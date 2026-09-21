import { sequelize } from '../db';
import exchangeRegistry from './exchanges';
import redisService from './RedisService';
import { ExchangeInstance } from '../models';
import { isVirtualExchangeType } from '../utils/virtualTypes';
import logger, { formatError } from '../utils/logger';

/**
 * SystemStatusService —— 系统健康状态聚合服务
 *
 * 职责：
 *  - 后台定时（15s）收集 Redis / 数据库 / 交易所（WS + REST 探测）的健康状态；
 *  - 所有网络探测都带超时并在后台执行，`getStatus()` 只返回缓存快照，绝不阻塞 API；
 *  - 供 GET /api/status 与前端首页（仪表盘）展示“异常状态”。
 *
 * 设计目标：即使 Redis 或交易所不可用，普通 API 请求依然正常响应，
 * 前端能通过 /api/status 看到具体的异常组件与错误信息，而不是整站不可用。
 */

const STATUS_TICK_MS = 15_000;          // 状态缓存刷新周期
const DB_CHECK_TTL_MS = 15_000;         // 数据库健康检查节流周期
const DB_CHECK_TIMEOUT_MS = 3_000;      // 数据库检查超时
const PROBE_TICK_MS = 30_000;           // 交易所 REST 探测节流周期
const PROBE_TIMEOUT_MS = 5_000;         // REST 探测超时
const PROBE_SYMBOL = 'BTC_USDT';        // 探测使用的公共行情符号

export interface ExchangeHealth {
  id: string;
  name: string;
  type: string;
  /** DB 中是否 active */
  active: boolean;
  /** 是否已注册到运行时（启动成功） */
  registered: boolean;
  /** WebSocket 是否已连接 */
  wsConnected: boolean;
  wsStats: Record<string, unknown> | null;
  /** REST 健康探测结果：true=正常, false=失败, null=尚未探测（如虚拟交易所跳过） */
  restOk: boolean | null;
  lastRESTError: string;
  lastRESTErrorAt: number;
}

export interface SystemStatus {
  overall: 'ok' | 'degraded' | 'critical';
  timestamp: number;
  server: {
    uptimeSec: number;
    startedAt: string;
    version: string;
  };
  redis: {
    ok: boolean;
    connected: boolean;
    ready: boolean;
    subStatus: string;
    pubStatus: string;
    lastError: string;
    lastErrorAt: number;
    lastConnectedAt: number;
  };
  database: {
    ok: boolean | null;
    lastCheckedAt: number;
  };
  exchanges: ExchangeHealth[];
}

class SystemStatusService {
  private startedAt = Date.now();
  private version = '';
  private tickTimer: NodeJS.Timeout | null = null;
  private cache: SystemStatus | null = null;

  // DB 检查缓存
  private dbOk: boolean | null = null;
  private lastDbCheckAt = 0;

  // 交易所 REST 探测缓存：id -> 结果
  private restProbeMap = new Map<string, { lastAttemptAt: number; ok: boolean; error: string }>();

  constructor() {
    try {
      const versionJson = require('../../version.json');
      this.version = versionJson?.version || '';
    } catch {
      this.version = '';
    }
  }

  public start(): void {
    if (this.tickTimer) return;
    void this.refresh().catch((e: any) => {
      logger.warn('[SystemStatusService] initial refresh failed', formatError(e));
    });
    this.tickTimer = setInterval(() => {
      void this.refresh().catch((e: any) => {
        logger.warn('[SystemStatusService] refresh failed', formatError(e));
      });
    }, STATUS_TICK_MS);
    this.tickTimer.unref?.();
    logger.info(`SystemStatusService started (tick every ${STATUS_TICK_MS}ms)`);
  }

  public stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  /**
   * 返回当前状态快照（纯内存读取，绝不阻塞）。
   * 首次调用时若尚未完成首次后台刷新，先构建一个同步快照。
   */
  public getStatus(): SystemStatus {
    if (this.cache) return this.cache;
    return this.buildStatusSync([]);
  }

  /** 交易所健康度映射（id -> health），供 /api/exchanges 合并展示 */
  public getExchangeHealthMap(): Map<string, ExchangeHealth> {
    const map = new Map<string, ExchangeHealth>();
    for (const ex of this.getStatus().exchanges) {
      map.set(ex.id, ex);
    }
    return map;
  }

  /**
   * 立即刷新一次状态快照（供初始化完成后调用，避免启动初期显示不准确）。
   */
  public async refreshNow(): Promise<void> {
    try {
      await this.refresh();
    } catch (e: any) {
      logger.warn('[SystemStatusService] refreshNow failed', formatError(e));
    }
  }

  // ------------------------------------------------------------------
  // 内部实现
  // ------------------------------------------------------------------

  private async refresh(): Promise<void> {
    await this.checkDatabase();

    // 查询 DB 中 active 的交易所实例，用于标记“配置存在但注册失败”的情况
    let dbInstances: ExchangeInstance[] = [];
    try {
      dbInstances = await ExchangeInstance.findAll({ where: { status: 'active' } });
    } catch (e: any) {
      logger.warn('[SystemStatusService] failed to load exchange instances from DB', formatError(e));
    }

    await this.probeExchanges(dbInstances);
    this.cache = this.buildStatusSync(dbInstances);
  }

  /** 数据库健康检查（带节流 + 超时） */
  private async checkDatabase(): Promise<void> {
    const now = Date.now();
    if (now - this.lastDbCheckAt < DB_CHECK_TTL_MS) return;
    this.lastDbCheckAt = now;

    try {
      await Promise.race([
        sequelize.authenticate(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('DB check timeout')), DB_CHECK_TIMEOUT_MS)),
      ]);
      this.dbOk = true;
    } catch (e: any) {
      this.dbOk = false;
      logger.warn('[SystemStatusService] database health check failed', formatError(e));
    }
  }

  /** 交易所 REST 健康探测（带节流 + 超时；虚拟交易所跳过） */
  private async probeExchanges(dbInstances: ExchangeInstance[]): Promise<void> {
    const now = Date.now();
    const exchanges = exchangeRegistry.getAllExchanges();

    // 运行时 IExchange 对象不一定携带 type 字段（虚拟交易所尤其如此），
    // 以 DB 中的实例 type 为准，避免把虚拟交易所误判成实盘去发真实 REST 探测。
    const dbTypeMap = new Map<string, string>();
    for (const inst of dbInstances) {
      dbTypeMap.set(inst.id, inst.type);
    }

    await Promise.all(exchanges.map(async (exchange: any) => {
      if (!exchange || !exchange.id) return;
      const instanceType = dbTypeMap.get(exchange.id) || exchange.type || '';
      if (isVirtualExchangeType(instanceType)) {
        // 虚拟交易所无需真实网络探测，直接标记为正常
        if (!this.restProbeMap.has(exchange.id)) {
          this.restProbeMap.set(exchange.id, { lastAttemptAt: now, ok: true, error: '' });
        }
        return;
      }

      const prev = this.restProbeMap.get(exchange.id);
      if (prev && now - prev.lastAttemptAt < PROBE_TICK_MS) return;

      // TradFi/CFD 市场不含加密货币，不能用 BTC_USDT 做 probe，改为 XAU_USDT（黄金标配）
      const exchangeType = String(instanceType).toLowerCase();
      const isCfd = exchangeType === 'gate_tradfi' || exchangeType === 'gate_cfd'
        || (exchange?.constructor?.name === 'GateCFDExchange');
      const probeSymbol = isCfd ? 'XAU_USDT' : PROBE_SYMBOL;

      try {
        let ok = false;
        let error = '';

        // 优先用公共行情探测（不消耗私有 REST）
        if (typeof exchange.getTicker === 'function') {
          const ticker: any = await Promise.race([
            exchange.getTicker(probeSymbol),
            new Promise((_, reject) => setTimeout(() => reject(new Error('REST probe timeout')), PROBE_TIMEOUT_MS)),
          ]);
          ok = !!ticker && Number.isFinite(parseFloat(ticker?.lastPrice));
          if (!ok) error = '行情返回异常（lastPrice 无效）';
        }

        // 若行情探测失败，对 CFD 类型再用 getBalance 兜底（确认 REST 链路通）
        if (!ok && isCfd && typeof exchange.getBalance === 'function') {
          const bal: any = await Promise.race([
            exchange.getBalance('USDC'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('CFD getBalance timeout')), PROBE_TIMEOUT_MS)),
          ]);
          ok = !!bal && Number.isFinite(parseFloat(bal?.total ?? bal?.available));
          if (!ok) error = error || '账户查询返回异常';
        }

        this.restProbeMap.set(exchange.id, {
          lastAttemptAt: now,
          ok,
          error,
        });
      } catch (e: any) {
        this.restProbeMap.set(exchange.id, {
          lastAttemptAt: now,
          ok: false,
          error: e?.message || String(e),
        });
      }
    }));
  }

  /** 构建同步快照（只读内存 + DB 查询结果，不做网络 I/O） */
  private buildStatusSync(dbInstances: ExchangeInstance[]): SystemStatus {
    const redis = redisService.getStatus();

    // DB 中的实例类型映射（运行时 IExchange 对象可能不携带 type 字段）
    const dbTypeMap = new Map<string, string>();
    for (const inst of dbInstances) {
      dbTypeMap.set(inst.id, inst.type);
    }

    // 运行时已注册的交易所（启动成功且仍在运行）
    const runtimeMap = new Map<string, any>();
    for (const ex of exchangeRegistry.getAllExchanges() as any[]) {
      runtimeMap.set(ex.id, ex);
    }

    const seen = new Set<string>();
    const exchangeHealths: ExchangeHealth[] = [];

    for (const [id, ex] of runtimeMap) {
      seen.add(id);
      const wsStats = ex?.getWebSocketStats ? ex.getWebSocketStats() : null;
      const probe = this.restProbeMap.get(id);
      exchangeHealths.push({
        id,
        name: ex.name || id,
        type: dbTypeMap.get(id) || ex.type || '',
        active: true,
        registered: true,
        wsConnected: !!(wsStats && wsStats.isConnected),
        wsStats: wsStats || null,
        restOk: probe ? probe.ok : null,
        lastRESTError: probe?.error || '',
        lastRESTErrorAt: probe?.lastAttemptAt || 0,
      });
    }

    // DB 中存在但未注册成功的实例（配置错误 / 初始化失败）
    for (const inst of dbInstances) {
      const id = inst.id;
      if (seen.has(id)) continue;
      seen.add(id);
      exchangeHealths.push({
        id,
        name: inst.name || id,
        type: inst.type || '',
        active: inst.status === 'active',
        registered: false,
        wsConnected: false,
        wsStats: null,
        restOk: null,
        lastRESTError: '交易所实例未成功加载（请检查配置或查看系统日志）',
        lastRESTErrorAt: 0,
      });
    }

    const redisOk = redis.ready;
    const dbOk = this.dbOk;
    const anyExchangeDown = exchangeHealths.some(
      (h) => !h.registered || !h.wsConnected || h.restOk === false
    );

    let overall: SystemStatus['overall'] = 'ok';
    if (dbOk === false) {
      overall = 'critical';
    } else if (!redisOk || anyExchangeDown) {
      overall = 'degraded';
    }

    return {
      overall,
      timestamp: Date.now(),
      server: {
        uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
        startedAt: new Date(this.startedAt).toISOString(),
        version: this.version,
      },
      redis: {
        ok: redisOk,
        connected: redis.connected,
        ready: redis.ready,
        subStatus: redis.subStatus,
        pubStatus: redis.pubStatus,
        lastError: redis.lastError,
        lastErrorAt: redis.lastErrorAt,
        lastConnectedAt: redis.lastConnectedAt,
      },
      database: {
        ok: dbOk,
        lastCheckedAt: this.lastDbCheckAt,
      },
      exchanges: exchangeHealths,
    };
  }
}

export default new SystemStatusService();

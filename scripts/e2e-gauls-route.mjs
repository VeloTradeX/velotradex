#!/usr/bin/env node
/**
 * E2E 测试：信号路由 gauls-main-dev（GaulsParser, main-dev testnet）
 * 覆盖：R 百分比偏移 / 固定金额偏移 / 入场点选择(all|nearest_sl) / 固定RR平仓 / 边界校验
 *
 * 用法: node scripts/e2e-gauls-route.mjs [caseName...]
 *      不传 caseName 时运行全部用例
 *
 * 环境: BASE_URL / E2E_USER / E2E_PASS 可通过环境变量覆盖
 *
 * 信号构造原则：
 *  - 以系统自身行情接口(/api/market/candles)动态锚定现价，避免硬编码价格脱离盘面导致
 *    SL 方向非法被拒、或市价单仓位低于最小下单量。
 *  - 市价(CMP)用例 R≈0.5% price（保证仓位名义价值 ≈ riskValue/0.005 ≈ $200，均达标）。
 *  - 限价用例入场点取现价 60% 以下，保证挂单不成交（PENDING），只验证价格计算。
 */
import { spawnSync } from 'node:child_process';

const BASE = process.env.BASE_URL || 'http://localhost:3010';
const USER = process.env.E2E_USER || 'admin';
const PASS = process.env.E2E_PASS || 'admin123';
const ROUTE_ID = 15;
const CHANNEL = '123456';
const EXCHANGE = 'main-dev';

// R 体系测试用的滑点系数（放大以便断言误差显著可观测；语义与线上默认 0.01 相同）
const RPAD = 0.05;

let token = '';
const results = [];

// ---------- 基础工具 ----------
async function api(method, path, body, retry = 2, timeoutMs = 30000) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (res.status === 401 && retry > 0) {
    await login(true);
    return api(method, path, body, retry - 1);
  }
  return { status: res.status, data };
}
async function login(force = false) {
  if (token && !force) return;
  const { status, data } = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  }).then(async (r) => ({ status: r.status, data: await r.json() }));
  if (status !== 200) throw new Error(`登录失败: ${JSON.stringify(data)}`);
  token = data?.accessToken || data?.token;
  if (!token) throw new Error(`登录响应缺少 token: ${JSON.stringify(data)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 现价锚点：优先取系统行情接口（CFD/主网镜像），失败回退公共 Gate API，均带重试 */
async function marketPrice(symbol) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await api('GET', `/api/market/candles?symbol=${encodeURIComponent(symbol)}&interval=1m&limit=1`, undefined, 0);
      const candles = Array.isArray(r.data) ? r.data : (r.data?.data || []);
      const last = candles[candles.length - 1];
      const p = last ? parseFloat(last.c ?? last.close ?? last.o) : NaN;
      if (Number.isFinite(p) && p > 0) return p;
    } catch { /* ignore */ }
    try {
      const r = await fetch(`https://api.gateio.ws/api/v4/futures/usdt/tickers?contract=${symbol}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) {
        const d = await r.json();
        if (d && d[0]?.last) return parseFloat(d[0].last);
      }
    } catch { /* ignore */ }
    await sleep(2000);
  }
  return null;
}

/**
 * CMP 用例盘口健康预检（Gate 测试网专用）。
 * 测试网薄盘口存在 ask1/bid1 相对 last 瞬时跳空的异常（实测 BTC ask1 可高出 mark 2%），
 * 此时买入市价单会被 Gate 内部 stop-match 安全校验拒绝（"stop match price ... less than ask1"）。
 * 发送 CMP 信号前调用：buy 要求 ask1 ≤ last×1.015，sell 要求 bid1 ≥ last×0.985；
 * 异常则等待盘口恢复（最多约 timeoutMs），超时仍返回（依赖系统级重试兜底）。
 */
async function ensureHealthyBook(symbol, side, timeoutMs = 45000) {
  const start = Date.now();
  let lastState = null;
  while (Date.now() - start < timeoutMs) {
    let asks = [], bids = [], last = null;
    try {
      const r = await fetch(`https://api.gateio.ws/api/v4/futures/usdt/order_book?contract=${symbol}&interval=0&limit=1`, {
        signal: AbortSignal.timeout(6000),
      });
      if (r.ok) {
        const d = await r.json();
        const norm = (arr) => (arr || [])
          .map((x) => (Array.isArray(x) ? { p: parseFloat(x[0]) } : { p: parseFloat(x.p) }))
          .filter((x) => Number.isFinite(x.p) && x.p > 0)
          .sort((a, b) => a.p - b.p);
        asks = norm(d.asks);
        bids = norm(d.bids).reverse();
        last = parseFloat(d.last);
        if (!Number.isFinite(last) || last <= 0) last = null;
      }
    } catch { /* ignore */ }
    if (!Number.isFinite(last) || last <= 0) {
      const p = await marketPrice(symbol);
      if (p) last = p;
    }
    const ask1 = asks[0]?.p, bid1 = bids[0]?.p;
    if (Number.isFinite(last) && last > 0 && ask1 !== undefined && bid1 !== undefined) {
      const ok = side === 'buy' ? ask1 <= last * 1.015 : bid1 >= last * 0.985;
      if (ok) return { ask1, bid1, last, ok: true };
      lastState = { ask1, bid1, last, ok: false };
    }
    await sleep(2500);
  }
  console.log(`    [warn] ${symbol} ${side} 盘口持续异常(${JSON.stringify(lastState)})，继续发送信号（依赖系统级 stop-match 重试兜底）`);
  return lastState || { ask1: undefined, bid1: undefined, last: undefined, ok: false };
}

// ---------- 预期值计算（与 OpenPriceAdjustment + TpSlCalculator 语义一致） ----------
function fin(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
/**
 * @param opts {side, entryPrice, stopLoss, targets, cfg}
 * 与后端一致（entryPrice 必须是 ORDER_INIT 审计的 currentPrice，即系统下单时的 ticker 快照）：
 *  - R 体系：entry=entry±R*entryPad; sl=sl∓R*slPad; TP 挂单价=target∓R*tpPad（固定体系 tpPad=0）
 *  - fixed 体系：entry=entry∓eo; sl=(新 entry)∓fsd; sl=sl∓sbo（止损后移）
 *  - fixedRR：追加 entry∓R*fixedRR 档目标（与信号目标共同等分）
 * 注意：CMP 市价单的 R 锚定为下单时 currentPrice（非成交价），TP/SL 在下单时即已算好，
 *      成交价漂移不影响 SL/TP（只影响 DB 记录 price）。
 */
function computeExpected({ side, entryPrice, stopLoss, targets, cfg }) {
  const isLong = side === 'buy';
  const mode = cfg.paddingMode === 'fixed' ? 'fixed' : 'r';
  const Rsig = Math.abs(entryPrice - stopLoss);
  const applied = {};
  let entry = entryPrice;
  let sl = stopLoss;

  if (mode === 'r') {
    const eP = cfg.entryPaddingR !== undefined ? Number(cfg.entryPaddingR) : 0.01;
    const tP = cfg.tpPaddingR !== undefined ? Number(cfg.tpPaddingR) : 0.01;
    const sP = cfg.slPaddingR !== undefined ? Number(cfg.slPaddingR) : 0.01;
    applied.entryPaddingR = eP; applied.tpPaddingR = tP; applied.slPaddingR = sP;
    entry = isLong ? entry + Rsig * eP : entry - Rsig * eP;
    sl = isLong ? sl - Rsig * sP : sl + Rsig * sP;
  } else {
    const eo = fin(cfg.entryOffsetFixed);
    const fsd = fin(cfg.fixedSlDistance);
    const sbo = fin(cfg.slBackOffsetFixed);
    if (eo !== undefined) { applied.entryOffsetFixed = eo; entry = isLong ? entry - eo : entry + eo; }
    if (fsd !== undefined) { applied.fixedSlDistance = fsd; sl = isLong ? entry - fsd : entry + fsd; }
    if (sbo !== undefined) { applied.slBackOffsetFixed = sbo; sl = isLong ? sl - sbo : sl + sbo; }
  }

  const execEntry = entry;
  const execSl = sl;
  const Rexec = Math.abs(execEntry - execSl);

  // TP 目标列表（信号目标 + fixedRR 档），排序后统一乘 TP 滑点
  const tpPad = mode === 'r' ? Math.abs(cfg.tpPaddingR !== undefined ? Number(cfg.tpPaddingR) : 0.01) : 0;
  let tps = [...(targets || [])].map((t) => parseFloat(t));
  const fRR = cfg.fixedRiskRewardClose !== undefined && cfg.fixedRiskRewardClose !== null ? Number(cfg.fixedRiskRewardClose) : null;
  if (fRR !== null && fRR > 0 && Rexec > 0) {
    tps.push(isLong ? execEntry + Rexec * fRR : execEntry - Rexec * fRR);
  }
  if (tps.length === 0) {
    tps.push(isLong ? execEntry + Rexec : execEntry - Rexec);
  }
  tps = tps.sort((a, b) => (isLong ? a - b : b - a));
  const tpOrders = tps.map((p) => (isLong ? p - Rexec * tpPad : p + Rexec * tpPad));

  return { mode, applied, entry, sl, Rsig, execEntry, execSl, Rexec, tps, tpOrders };
}

/** 从策略详情审计中取 ORDER_INIT 事件的 currentPrice（CMP 市价单的 R 锚点） */
function getOrderInitCurrentPrice(details) {
  const audit = (details.auditLogs || []).find((l) => l.action === 'ORDER_INIT');
  if (!audit) return null;
  try {
    const d = JSON.parse(audit.details);
    const cp = Number(d?.currentPrice);
    return Number.isFinite(cp) && cp > 0 ? cp : null;
  } catch {
    return null;
  }
}

// ---------- 信号发送与策略跟踪 ----------
async function sendSignal(msgId, content) {
  const r = await api('POST', '/api/message/send', {
    content: { channel_id: CHANNEL, id: msgId, content },
  });
  if (r.status !== 200) throw new Error(`发送信号失败 ${msgId}: ${JSON.stringify(r.data)}`);
}
async function waitStrategies(msgId, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { status, data } = await api('GET', `/api/strategies?limit=100`);
    if (status === 200) {
      const rows = Array.isArray(data) ? data : data?.items || data?.rows || [];
      const hit = rows.filter((s) => {
        try { return JSON.parse(s.rawMessage || '{}').id === msgId; } catch { return false; }
      });
      if (hit.length > 0) {
        const done = hit.every((s) => ['processed', 'failed', 'filtered'].includes(s.status));
        if (done) return hit.sort((a, b) => a.id - b.id);
      }
    }
    await sleep(3000);
  }
  throw new Error(`等待策略超时: ${msgId}`);
}
async function strategyDetails(id) {
  const { data } = await api('GET', `/api/strategies/${id}/details`);
  return data;
}
/**
 * 等待市价单成交并返回 {d, o, fill}。
 * 策略 status=processed 可能在成交同步完成前就已落库，直接读 filledPrice 可能为 0；
 * 这里轮询策略详情直到 orders[0].filledPrice > 0（交易所 WS/轮询回填）。
 */
async function waitOrderFill(strategyId, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const d = await strategyDetails(strategyId);
    const o = d?.orders?.[0];
    const fill = parseFloat(o?.filledPrice || '0');
    if (fill > 0) return { d, o, fill };
    await sleep(1000);
  }
  const d = await strategyDetails(strategyId);
  const o = d?.orders?.[0];
  if (!o) {
    const status = d?.strategy?.status;
    const routeResults = d?.strategy?.routes ? JSON.parse(d.strategy.routes) : 'n/a';
    throw new Error(`订单未生成: strategy#${strategyId} status=${status} routes=${JSON.stringify(routeResults)} orders=${JSON.stringify((d?.orders || []).map((x) => ({ id: x.id, status: x.status, lifecycle: x.lifecycleStatus, filled: x.filledPrice })))}`);
  }
  return { d, o, fill: parseFloat(o?.filledPrice || '0') };
}
function getParsed(details) {
  // 从 STRATEGY_DETECTED 审计中取解析结果（含 weight/entryIndex/entryCount/groupEntries）
  const audit = (details.auditLogs || []).find((l) => l.action === 'STRATEGY_DETECTED');
  return audit ? JSON.parse(audit.details).parsed : null;
}
/**
 * 轮询等待 ORDER_PROTECTED 审计出现。
 * 保护挂单由 REST（PostFillOrchestrator）与 WS（GateIOOrderPersistenceHandler）并行竞争 claim，
 * 赢家视角的审计写入可能晚于策略 status=processed 落库，故此处轮询保证确定收敛。
 */
async function waitForProtectedAudit(strategyId, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const d = await strategyDetails(strategyId);
    if ((d.auditLogs || []).some((l) => l.action === 'ORDER_PROTECTED')) return true;
    await sleep(1000);
  }
  return false;
}
/**
 * 轮询等待交易所出现 >=minCount 个本订单的 t-tp- 挂单。
 * 保护挂单由 PostFillOrchestrator / WS 路径异步放置，迟到资产同步回 DB/交易所存在竞态；
 * 尤其小仓位时 P0-4 可能裁剪档数，超时后按实际在场挂单返回（由调用方断言兜底）。
 */
async function waitForTpOrders(symbol, exchangeOrderId, minCount, timeoutMs = 15000) {
  const start = Date.now();
  const matched = async () => {
    const open = await openOrders();
    return open.filter((x) =>
      (x.contract === symbol || x.symbol === symbol) &&
      String(x.text || '').includes('t-tp-') &&
      String(x.text || '').includes(`-ord-${exchangeOrderId}`)
    );
  };
  while (Date.now() - start < timeoutMs) {
    const tp = await matched();
    if (tp.length >= minCount) return tp;
    await sleep(1000);
  }
  return matched();
}
async function openOrders() {
  const { status, data } = await api('GET', '/api/orders/open');
  if (status !== 200) return [];
  // 返回 {openOrders, triggerOrders}，合并并只保留本交易所实例的
  const open = Array.isArray(data) ? data : [...(data?.openOrders || []), ...(data?.triggerOrders || [])];
  return open.filter((o) => o.exchangeInstanceId === EXCHANGE);
}
async function cancelOrder(dbOrderId) {
  const { status, data } = await api('POST', `/api/orders/${dbOrderId}/cancel`);
  return { status, data };
}
async function closePosition(symbol, side) {
  const { status, data } = await api('POST', '/api/positions/close', {
    symbol, side, exchangeInstanceId: EXCHANGE,
  });
  return { status, data };
}

// ---------- 断言工具 ----------
function near(actual, expected, tol, label) {
  const a = parseFloat(actual);
  const diff = Math.abs(a - expected);
  const ok = Number.isFinite(a) && diff <= tol;
  return { ok, label, actual: a, expected, diff, okText: ok ? 'OK' : 'FAIL' };
}
function toleranceFor(price) {
  const p = Math.abs(price);
  if (p >= 10000) return 0.1;
  if (p >= 100) return 0.01;
  return 0.0005;
}
/** 市价/解析价格类断言容差：容忍成交价与解析基准价的微小漂移（≤0.02R），同时远小于 R×pad 误差 */
function mktTol(price, R) {
  const base = toleranceFor(price);
  const drift = (Math.abs(R) * 0.02) + base;
  return Math.max(base, drift);
}
/** 交易所真实挂单最小 tick（测试网 order_price_round，下取整生效） */
const TICK = { BTC_USDT: 0.1, ETH_USDT: 0.05, SOL_USDT: 0.01, XRP_USDT: 0.0001, DOGE_USDT: 0.00001 };
/** 交易所挂单价格断言容差 = max(基础容差, tick)。限价挂单（无成交漂移）用这个。 */
function xchgTol(symbol, price) {
  return Math.max(toleranceFor(price), TICK[symbol] || 0);
}
/** 市价/TP 挂单价格断言容差 = max(市价漂移容差, tick)。 */
function mktTolTick(symbol, price, R) {
  return Math.max(mktTol(price, R), TICK[symbol] || 0);
}

// ---------- 路由配置 ----------
async function setRisk(riskSettings) {
  const { status, data } = await api('PUT', `/api/routes/${ROUTE_ID}`, { riskSettings });
  if (status !== 200) throw new Error(`更新路由配置失败: ${JSON.stringify(data)}`);
}
async function getRoute() {
  const { data } = await api('GET', '/api/routes');
  return (Array.isArray(data) ? data : []).find((r) => r.id === ROUTE_ID);
}

// ---------- 用例运行框架 ----------
async function runCase(name, fn) {
  process.stdout.write(`\n===== ${name} =====\n`);
  try {
    const asserts = await fn();
    results.push({ name, pass: asserts.every((a) => a.ok), asserts });
    for (const a of asserts) {
      console.log(`  [${a.ok ? 'PASS' : 'FAIL'}] ${a.label}${a.ok ? '' : `  (期望 ${fmt(a.expected)} / 实际 ${fmt(a.actual)} / 差 ${a.diff?.toFixed(6)})`}`);
    }
  } catch (e) {
    results.push({ name, pass: false, error: e.message });
    console.log(`  [ERROR] ${e.message}`);
  }
}
const fmt = (n) => (typeof n === 'number' ? n.toString() : String(n));

function mkAsserts() {
  const list = [];
  const push = (r) => {
    if (!r.ok) console.log(`    ✗ ${r.label}: 期望 ${fmt(r.expected)} / 实际 ${fmt(r.actual)} / 差 ${r.diff?.toFixed(6)}`);
    list.push(r);
  };
  return { list, push };
}

const FIXED_CFG_MIN = { riskMode: 'fixed', riskValue: 1, priceTolerance: 0.01 };
const R_CFG = { ...FIXED_CFG_MIN, entryPaddingR: RPAD, tpPaddingR: RPAD, slPaddingR: RPAD };

// =====================================================================
// T1: R 体系 · 限价单 · 单TP —— 入场/止损 R 偏移精确验证（挂单不成交）
// =====================================================================
async function t1() {
  const A = mkAsserts();
  const cfg = { ...R_CFG };
  await setRisk(cfg);
  const price = await marketPrice('ETH_USDT');
  if (!price) throw new Error('无法获取 ETH_USDT 现价锚点');
  const entry = price * 0.6, sl = entry * 0.99, tp1 = entry * 1.08;
  // 预期：entry_adj=entry+R*0.05；sl_adj=sl-R*0.05（R=|entry-sl|）
  const expectEntry = entry + (entry - sl) * RPAD;
  const expectSl = sl - (entry - sl) * RPAD;
  // 测试网 REST 偶发瞬时超时/TLS 断连 → 信号级别整体重试（与 T3 一致）
  let strategies = null, msgId = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    msgId = `e2e-t1-${Date.now()}-${attempt}`;
    await sendSignal(msgId, `ETH_USDT Long setup | Entry: ${c1(entry)} | TP1 ${c1(tp1)} | SL ${c1(sl)}`);
    const cands = await waitStrategies(msgId);
    if (cands.length === 0) continue;
    const st = cands[0];
    const routesRaw = JSON.parse(st.routes || '[]');
    const errMsg = (routesRaw[0]?.error || '') + (routesRaw[0]?.reason || '');
    if (st.status !== 'failed' || !/socket|TLS|ECONN|disconnect|timeout/i.test(errMsg)) {
      strategies = cands;
      break;
    }
    A.push({ ok: true, label: `T1 尝试${attempt} 遇瞬时网络错误(${errMsg.slice(0, 60)}) 已重试` });
    await sleep(3000);
  }
  if (!strategies) throw new Error('T1 重试 3 次均失败');
  A.push({ ok: strategies.length === 1, label: `策略数量=1`, expected: 1, actual: strategies.length });
  const d = await strategyDetails(strategies[0].id);
  const parsed = getParsed(d);
  A.push({ ok: !!parsed, label: `STRATEGY_DETECTED 含解析` });
  A.push({ ok: strategies[0].status === 'processed', label: `策略 status=processed 实际=${strategies[0].status}`, expected: 'processed', actual: strategies[0].status });
  const o = d.orders[0];
  if (!o) throw new Error('未生成订单');
  const tol = toleranceFor(expectEntry);
  // 1) 入场偏移：现价≈${price.toFixed(2)}，限价 entry=信号价，成交前不改变 —— DB 记录 price 应为调整后入场价
  A.push(near(o.price, expectEntry, tol, `订单price=入场价+R*${RPAD}(信号${fmt(c1(entry))}→期望${fmt(c1(expectEntry))})`));
  // 2) 交易所挂单 price 与 DB 一致
  const open = await openOrders();
  const exOrder = open.find((x) => String(x.text || '').includes(`t-entry-${o.id}`));
  A.push({ ok: !!exOrder, label: `交易所存在入场挂单(t-entry-${o.id})`, expected: '存在', actual: exOrder ? exOrder.id : '无' });
  if (exOrder) A.push(near(exOrder.price, expectEntry, xchgTol('ETH_USDT', expectEntry), `交易所挂单price=调整后入场价(按tick取整)`));
  // 3) 止损偏移：初始SL=信号SL-R*slPad
  A.push(near(o.initialSl, expectSl, tol, `initialSl=信号SL-R*${RPAD}(期望${fmt(c1(expectSl))})`));
  // 4) TP 目标透传不变（tpResult.targets[0] 为原始目标，不做滑点）
  const parsedTp = parsed?.targets?.[0];
  A.push({ ok: parsedTp !== undefined && near(o.initialTp, parseFloat(parsedTp), tol).ok, label: `initialTp=原始TP1(${fmt(parsedTp)}) 实际=${fmt(o.initialTp)}`, expected: parseFloat(parsedTp), actual: o.initialTp });
  // 5) 挂单未成交
  A.push({ ok: ['PENDING', 'OPEN'].includes(o.lifecycleStatus), label: `限价挂单生命周期=${o.lifecycleStatus}`, expected: 'PENDING/OPEN', actual: o.lifecycleStatus });
  await cleanupOrders(d.orders, 'cancel');
  return A.list;
}

// =====================================================================
// T2: R 体系 · CMP 市价 · 双TP —— 成交后止盈挂单数/价格、初始SL验证
// =====================================================================
async function t2() {
  const A = mkAsserts();
  // riskValue=1 时按 R 换算仓位张数在 1~2 波动：1 张净敞口会使 P0-4 将双档 TP 裁剪为
  // 1 档（走预附着路径，无独立 t-tp- 挂单）→ 双档拆分断言失败。提到 2（风险仍仅 $2）
  // 保证仓位 >=2 张，双档各 >=1 张稳定拆分为独立 reduce-only 挂单。
  const cfg = { ...R_CFG, riskValue: 2 };
  await setRisk(cfg);
  const price = await marketPrice('SOL_USDT');
  if (!price) throw new Error('无法获取 SOL_USDT 现价锚点');
  const sl = price * 0.995;
  const tp1 = price * 1.015, tp2 = price * 1.02;
  await ensureHealthyBook('SOL_USDT', 'buy');
  // 测试网 REST 偶发瞬时超时/TLS 断连 → 信号级别整体重试（与 T1/T3 一致）
  let strategies = null, msgId = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    msgId = `e2e-t2-${Date.now()}-${attempt}`;
    await sendSignal(msgId, `SOL_USDT Long setup | CMP | TP1 ${c1(tp1)} | TP2 ${c1(tp2)} | SL ${c1(sl)}`);
    await sleep(4000);
    const cands = await waitStrategies(msgId);
    if (cands.length === 0) continue;
    const st = cands[0];
    const routesRaw = JSON.parse(st.routes || '[]');
    const errMsg = (routesRaw[0]?.error || '') + (routesRaw[0]?.reason || '');
    if (st.status !== 'failed' || !/socket|TLS|ECONN|disconnect|timeout/i.test(errMsg)) {
      strategies = cands;
      break;
    }
    A.push({ ok: true, label: `T2 尝试${attempt} 遇瞬时网络错误(${errMsg.slice(0, 60)}) 已重试` });
    await sleep(3000);
  }
  if (!strategies) throw new Error('T2 重试 3 次均失败');
  A.push({ ok: strategies.length === 1, label: `策略数量=1`, expected: 1, actual: strategies.length });
  const { d, o, fill } = await waitOrderFill(strategies[0].id);
  if (!o) throw new Error('未生成订单');
  A.push({ ok: fill > 0, label: `市价成交 filledPrice=${fill}`, expected: '>0', actual: fill });
  if (fill > 0) {
    const cp = getOrderInitCurrentPrice(d);
    A.push({ ok: !!cp, label: `ORDER_INIT currentPrice 锚点存在 (cp=${cp})` });
    if (!cp) throw new Error('未取到 ORDER_INIT currentPrice');
    // R 锚定为下单时 currentPrice（非成交价）：SL/TP 在下单时已定，成交漂移不影响
    const exp = computeExpected({ side: 'buy', entryPrice: cp, stopLoss: sl, targets: [tp1, tp2], cfg });
    const R = Math.abs(cp - sl);
    const tol = toleranceFor(cp);
    // TP 挂单 —— 只统计本次订单的挂单（text 含 ord-{exchangeOrderId}），对历史残留免疫；
    // 轮询等待保护挂单放置完成（REST/WS 异步放置存在竞态），最多 15s
    const reduceOnly = await waitForTpOrders('SOL_USDT', o.exchangeOrderId, 2);
    // 现场打印全部 t-tp- 挂单明细（id/price/amount/text），用于定位双放/价格偏差
    for (const x of reduceOnly) {
      console.log(`    [dbg T2] SOL t-tp- 挂单: id=${x.id} price=${x.price} amount=${x.amount || x.size} text=${x.text} side=${x.side}` + '\n      期望档: ' + exp.tpOrders.map((e) => e.toFixed(4)).join(' / '));
    }
    A.push({ ok: reduceOnly.length >= 2, label: `止盈挂单数>=2 (实际${reduceOnly.length})`, expected: 2, actual: reduceOnly.length });
    const tpPrices = reduceOnly.map((x) => parseFloat(x.price)).sort((a, b) => a - b);
    const expPrices = exp.tpOrders.slice().sort((a, b) => a - b);
    expPrices.slice(0, 2).forEach((ep, i) => {
      A.push(near(tpPrices[i], ep, mktTolTick('SOL_USDT', ep, R), `TP${i + 1}价格≈${ep.toFixed(4)} (目标${exp.tps[i]?.toFixed(2)}-R*${RPAD})`));
    });
    // 全部在场挂单都应该能匹配到某个期望档（用匹配集合替代 slice 比较，容忍双路径重复）
    {
      const matched = new Set();
      let unmatched = [];
      for (const x of reduceOnly) {
        const px = parseFloat(x.price);
        let best = null;
        for (const ep of exp.tpOrders) {
          const d0 = Math.abs(px - ep);
          if (!best || d0 < best.d) best = { ep, d: d0 };
        }
        if (best && best.d <= mktTolTick('SOL_USDT', best.ep, R)) matched.add(best.ep.toFixed(4));
        else unmatched.push(px);
      }
      A.push({ ok: unmatched.length === 0, label: `全部在场TP挂单均匹配期望档(去重${matched.size}/${exp.tpOrders.length}档, unmatched=${unmatched.join(',') || '无'})`, expected: '0 unmatched', actual: unmatched.join(',') || '无' });
    }
    // SL（exchange-attached，无独立挂单）→ 校验订单 initialSl
    A.push(near(o.initialSl, exp.execSl, tol, `initialSl=信号SL-R*${RPAD}(期望${fmt(exp.execSl.toFixed(4))})`));
  }
  await cleanupOrders(d.orders, 'all');
  return A.list;
}

// =====================================================================
// T3: 固定体系 · 限价单 —— 入场让点/固定止损距离/止损后移精确验证
// =====================================================================
async function t3() {
  const A = mkAsserts();
  const cfg = { ...FIXED_CFG_MIN, paddingMode: 'fixed', entryOffsetFixed: 50, fixedSlDistance: 500, slBackOffsetFixed: 100 };
  await setRisk(cfg);
  const price = await marketPrice('BTC_USDT');
  if (!price) throw new Error('无法获取 BTC_USDT 现价锚点');
  const entry = price * 0.6, sl = entry * 0.99, tp1 = entry * 1.08;
  // 预期：entry_adj=entry-50；sl=entry_adj-500-100=entry-650
  const expectEntry = entry - 50;
  const expectSl = entry - 50 - 500 - 100;
  // T3 偶发 GateIO TLS 瞬时断连（"Client network socket disconnected..."）→ 信号级别整体重试
  let strategies = null, msgId = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    msgId = `e2e-t3-${Date.now()}-${attempt}`;
    await sendSignal(msgId, `BTC_USDT Long setup | Entry: ${c1(entry)} | TP1 ${c1(tp1)} | SL ${c1(sl)}`);
    const cands = await waitStrategies(msgId);
    if (cands.length === 0) continue;
    const st = cands[0];
    const routes = JSON.parse(st.routes || '[]');
    const errMsg = (routes[0]?.error || '') + (routes[0]?.reason || '');
    if (st.status !== 'failed' || !/socket|TLS|ECONN|disconnect/i.test(errMsg)) {
      strategies = cands;
      break;
    }
    A.push({ ok: true, label: `T3 尝试${attempt} 遇瞬时网络错误(${errMsg.slice(0, 60)}) 已重试` });
    await sleep(3000);
  }
  if (!strategies) throw new Error('T3 重试 3 次均失败');
  A.push({ ok: strategies.length === 1, label: `策略数量=1`, expected: 1, actual: strategies.length });
  const d = await strategyDetails(strategies[0].id);
  const parsed = getParsed(d);
  A.push({ ok: !!parsed, label: `STRATEGY_DETECTED 含解析` });
  const o = d.orders[0];
  if (!o) throw new Error('未生成订单');
  const tol = toleranceFor(expectEntry);
  A.push(near(o.price, expectEntry, tol, `订单price=信号入场-50(期望${fmt(c1(expectEntry))})`));
  const open3 = await openOrders();
  const exOrder3 = open3.find((x) => String(x.text || '').includes(`t-entry-${o.id}`));
  if (exOrder3) A.push(near(exOrder3.price, expectEntry, xchgTol('BTC_USDT', expectEntry), `交易所挂单price=调整后入场价(按tick取整)`));
  else A.push({ ok: false, label: `交易所存在入场挂单(t-entry-${o.id})`, expected: '存在', actual: '无' });
  A.push(near(o.initialSl, expectSl, tol, `initialSl=入场-50-500-100(期望${fmt(c1(expectSl))})`));
  // TP 透传：固定体系下 TP 无滑点，initialTp=原始 TP1
  const parsedTp = parsed?.targets?.[0];
  A.push({ ok: parsedTp !== undefined && near(o.initialTp, parseFloat(parsedTp), tol).ok, label: `initialTp=原始TP1(${fmt(parsedTp)}) 实际=${fmt(o.initialTp)}`, expected: parseFloat(parsedTp), actual: o.initialTp });
  A.push({ ok: ['PENDING', 'OPEN'].includes(o.lifecycleStatus), label: `限价挂单生命周期=${o.lifecycleStatus}`, expected: 'PENDING/OPEN', actual: o.lifecycleStatus });
  await cleanupOrders(d.orders, 'cancel');
  return A.list;
}

// =====================================================================
// T4: 固定体系 · CMP 市价 · fixedRR=2 —— 止损基于调整后入场、fixedRR 档与信号TP等分
// =====================================================================
async function t4() {
  const A = mkAsserts();
  const cfg = { ...FIXED_CFG_MIN, paddingMode: 'fixed', entryOffsetFixed: 3, fixedSlDistance: 40, slBackOffsetFixed: 0, fixedRiskRewardClose: 2 };
  await setRisk(cfg);
  const price = await marketPrice('ETH_USDT');
  if (!price) throw new Error('无法获取 ETH_USDT 现价锚点');
  // 信号 TP 的用途只是“信号档透传 + 与 fixedRR 档等分”。
  // 测试网 taker 吃薄盘口时成交价相对信号锚点可漂移 +2%~3%（此前实测 +2.2%），
  // 若信号 TP 距锚点太近（此前 +2%），漂移后 TP 挂单价会低于成交价被瞬间成交，
  // 只剩 fixedRR 档、挂单数断言失败。把信号 TP 拉到 +15% 保证执行后仍在场。
  const sl = price * 0.93, tp1 = price * 1.15;
  await ensureHealthyBook('ETH_USDT', 'buy');
  // 测试网薄盘口偶发异常：buy 市价单触发价低于 ask1 被 Gate stop-match 拒绝
  // （实测 ask1 可相对 mark 突跳 ~2.7%）；系统级重试 1 次后仍可能失败 → 信号级整体重试。
  let strategies = null, msgId = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    msgId = `e2e-t4-${Date.now()}-${attempt}`;
    await sendSignal(msgId, `ETH_USDT Long setup | CMP | TP1 ${c1(tp1)} | SL ${c1(sl)}`);
    await sleep(4000);
    const cands = await waitStrategies(msgId);
    if (cands.length === 0) continue;
    const st = cands[0];
    const routeErr = JSON.parse(st.routes || '[]')[0]?.error || '';
    if (st.status !== 'failed' || !/stop match|socket|TLS|ECONN|disconnect|timeout/i.test(routeErr)) {
      strategies = cands;
      break;
    }
    A.push({ ok: true, label: `T4 尝试${attempt} 遇盘口/网络瞬时异常(${routeErr.slice(0, 70)}) 已重试` });
    await sleep(3000);
  }
  if (!strategies) throw new Error('T4 重试 3 次均失败');
  A.push({ ok: strategies.length === 1, label: `策略数量=1`, expected: 1, actual: strategies.length });
  const { d, o, fill } = await waitOrderFill(strategies[0].id);
  if (!o) throw new Error('未生成订单');
  A.push({ ok: fill > 0, label: `市价成交 filledPrice=${fill}`, expected: '>0', actual: fill });
  if (fill > 0) {
    const cp = getOrderInitCurrentPrice(d);
    A.push({ ok: !!cp, label: `ORDER_INIT currentPrice 锚点存在 (cp=${cp})` });
    if (!cp) throw new Error('未取到 ORDER_INIT currentPrice');
    // 固定体系以 ORDER_INIT currentPrice 作为让点的基准（系统下单时即定 SL/TP）
    const exp = computeExpected({ side: 'buy', entryPrice: cp, stopLoss: sl, targets: [tp1], cfg });
    const R = exp.Rexec;
    const tol = toleranceFor(cp);
    // 1) 止损：fixed 体系 ST=入场-3-40-0 = currentPrice-3-40
    A.push(near(o.initialSl, exp.execSl, tol, `initialSl=currentPrice-3-40(期望${fmt(exp.execSl.toFixed(4))})`));
    // 2) fixedRR=2 追加 1 档 → 2 档等分
    A.push({ ok: exp.tpOrders.length === 2, label: `TP数=2 (信号TP1 + fixedRR=2档)`, expected: 2, actual: exp.tpOrders.length });
    const open = await openOrders();
    const reduceOnly = open.filter((x) =>
      (x.contract === 'ETH_USDT' || x.symbol === 'ETH_USDT') &&
      String(x.text || '').includes('t-tp-') &&
      String(x.text || '').includes(`-ord-${o.exchangeOrderId}`)
    );
    // 两档都应仍在场（信号TP距锚点+15%、fixedRR档+3%相对成交价，窗口内不应被行情触发成交）
    A.push({ ok: reduceOnly.length >= 2, label: `止盈挂单数>=2 (实际${reduceOnly.length})`, expected: 2, actual: reduceOnly.length });
    // 在场档逐一匹配期望档价格（信号挡允许锚点位漂移容差）
    const matched = new Set();
    for (const x of reduceOnly) {
      const px = parseFloat(x.price);
      let best = null;
      for (const ep of exp.tpOrders) {
        const d0 = Math.abs(px - ep);
        if (!best || d0 < best.d) best = { ep, d: d0 };
      }
      if (best && best.d <= mktTolTick('ETH_USDT', best.ep, R)) {
        matched.add(best.ep.toFixed(2));
        A.push({ ok: true, label: `TP挂单${px.toFixed(2)} ≈ 期望档 ${best.ep.toFixed(2)}` });
      } else {
        A.push({ ok: false, label: `TP挂单${px.toFixed(2)} 未匹配期望档`, expected: exp.tpOrders.map((e) => e.toFixed(2)).join('/'), actual: px.toFixed(2) });
      }
    }
    A.push({ ok: matched.size >= 2, label: `在场TP档均匹配期望档(去重${matched.size}档)`, expected: '≥2', actual: matched.size });
    // 3) fixedRR 档（市场的更低一档）必须可观测：entry=cp-3, R=40, 档=cp-3+80 ——
    //    该档价格完全由 fixed 体系参数决定，是 “固定RR平仓” 是否生效的最强证据。
    const fixedRrLevel = exp.execEntry + exp.Rexec * cfg.fixedRiskRewardClose;
    const lowest = reduceOnly.length ? Math.min(...reduceOnly.map((x) => parseFloat(x.price))) : NaN;
    A.push(near(lowest, fixedRrLevel, mktTolTick('ETH_USDT', fixedRrLevel, R), `fixedRR=2档=入场+2R(期望${fmt(fixedRrLevel.toFixed(2))})`));
    // 4) 等分验证：两档止盈挂单数量近似相等（净敞口裁剪/分配错误会破坏等分）
    if (reduceOnly.length >= 2) {
      const amounts = reduceOnly.map((x) => parseFloat(x.amount || x.size || '0')).sort((a, b) => a - b);
      const a0 = amounts[0], a1 = amounts[amounts.length - 1];
      A.push({ ok: a0 > 0 && a1 > 0 && Math.abs(a0 - a1) <= Math.max(1, a0 * 0.1), label: `两档TP等分(实际${a0}/${a1})`, expected: '≈相等', actual: `${a0}/${a1}` });
    }
  }
  await cleanupOrders(d.orders, 'all');
  return A.list;
}

// =====================================================================
// T5: 入场点选择=all · CMP till X 双入场点 —— 均分仓位验证
// =====================================================================
async function t5() {
  const A = mkAsserts();
  // XRP 为 quanto 整数合约(multiplier=10)，riskValue=1 换算不足 1 张被拒；
  // 提高 riskValue 至足以成交 ≥1 张、同时又远小于默认（测试网无真实成本）。
  const cfg = { ...R_CFG, entrySelection: 'all', riskValue: 30 };
  await setRisk(cfg);
  const price = await marketPrice('XRP_USDT');
  if (!price) throw new Error('无法获取 XRP_USDT 现价锚点');
  const lim = price * 0.75, sl = price * 0.6, tp1 = price * 1.05, tp2 = price * 1.15;
  await ensureHealthyBook('XRP_USDT', 'buy');
  const msgId = `e2e-t5-${Date.now()}`;
  await sendSignal(msgId, `XRP_USDT Long setup | CMP till ${c1(lim)} | TP1 ${c1(tp1)} | TP2 ${c1(tp2)} | SL ${c1(sl)}`);
  await sleep(4000);
  const strategies = await waitStrategies(msgId);
  A.push({ ok: strategies.length === 2, label: `策略数量=2 (双入场点)`, expected: 2, actual: strategies.length });
  for (const s of strategies) {
    const d = await strategyDetails(s.id);
    const parsed = getParsed(d);
    A.push({ ok: parsed.weight === 0.5, label: `策略${s.id} weight=0.5 实际=${parsed.weight}`, expected: 0.5, actual: parsed.weight });
    A.push({ ok: Array.isArray(d.orders) && d.orders.length === 1, label: `策略${s.id} 生成1单(实际${d.orders?.length})`, expected: 1, actual: d.orders?.length });
    A.push({ ok: s.status === 'processed', label: `策略${s.id} status=processed 实际=${s.status}`, expected: 'processed', actual: s.status });
  }
  await cleanupAllOrdersForSymbol('XRP_USDT', 'all');
  return A.list;
}

// =====================================================================
// T6: 入场点选择=nearest_sl · CMP till X —— 仅限价腿(距SL最近)执行全仓，市价腿过滤
// =====================================================================
async function t6() {
  const A = mkAsserts();
  // DOGE 为 quanto 整数合约(multiplier=1000)，需足够 riskValue 保证全仓腿 ≥1 张。
  const cfg = { ...R_CFG, entrySelection: 'nearest_sl', riskValue: 80 };
  await setRisk(cfg);
  const price = await marketPrice('DOGE_USDT');
  if (!price) throw new Error('无法获取 DOGE_USDT 现价锚点');
  const lim = price * 0.75, sl = price * 0.55, tp1 = price * 1.05;
  const msgId = `e2e-t6-${Date.now()}`;
  await sendSignal(msgId, `DOGE_USDT Long setup | CMP till ${c1(lim)} | TP1 ${c1(tp1)} | SL ${c1(sl)}`);
  await sleep(4000);
  const strategies = await waitStrategies(msgId);
  A.push({ ok: strategies.length === 2, label: `策略数量=2 (解析仍为双入场点)`, expected: 2, actual: strategies.length });
  // 限价腿(0.75*price，距 SL 0.55*price 最近)执行 weight=1；市价腿(距 SL 远)过滤
  let executed = [], filtered = [];
  for (const s of strategies) {
    const d = await strategyDetails(s.id);
    const parsed = getParsed(d);
    const routes = JSON.parse(d.strategy?.routes || '[]');
    const routeResult = routes[0] || {};
    if (routeResult.status === 'filtered') filtered.push({ id: s.id, parsed });
    else executed.push({ id: s.id, parsed, d, status: routeResult.status });
  }
  A.push({ ok: filtered.length === 1, label: `过滤数=1 (实际${filtered.length})`, expected: 1, actual: filtered.length });
  A.push({ ok: executed.length === 1, label: `执行数=1 (实际${executed.length})`, expected: 1, actual: executed.length });
  if (executed.length === 1) {
    const ex = executed[0];
    // STRATEGY_DETECTED 是解析/检测时的原快照（双入场点均分 → 0.5）；
    // entrySelection 在执行时把最近入场点改为全仓(weight=1)，以订单实际张数验证。
    A.push({ ok: ex.parsed.weight === 0.5, label: `检测快照 weight=0.5 (原双入场点均分)`, expected: 0.5, actual: ex.parsed.weight });
    A.push({ ok: ex.d.orders.length === 1, label: `执行腿生成1单`, expected: 1, actual: ex.d.orders.length });
    // riskValue=80 全仓(weight=1) → 2 张；若仍是 0.5 权重则只有 1 张。价格取整可能跨档，
    // 断言 ≥2 以证明全仓生效、且远小于 0.5 权重下的 1 张。
    const amt = ex.d.orders[0] ? parseFloat(ex.d.orders[0].amount || '0') : 0;
    A.push({ ok: amt >= 2, label: `执行腿全仓张数>=2 (实际${amt}, 0.5权重只会是1)`, expected: '≥2', actual: amt });
  }
  if (filtered.length === 1) {
    const audit = (await strategyDetails(filtered[0].id)).auditLogs || [];
    const fAudit = audit.find((l) => l.action === 'STRATEGY_FILTERED');
    A.push({ ok: !!fAudit, label: `过滤腿存在 STRATEGY_FILTERED 审计` });
    if (fAudit) {
      const det = JSON.parse(fAudit.details);
      A.push({ ok: /不是距止损最近的入场点/.test(det.reason || ''), label: `过滤原因含"不是距止损最近的入场点"`, expected: true, actual: det.reason });
    }
  }
  await cleanupAllOrdersForSymbol('DOGE_USDT', 'all');

  // T6b: 单入场点信号在 nearest_sl 下不受影响（仍正常执行）
  const price2 = await marketPrice('BTC_USDT');
  const msgId2 = `e2e-t6b-${Date.now()}`;
  await sendSignal(msgId2, `BTC_USDT Long setup | Entry: ${c1(price2 * 0.6)} | TP1 ${c1(price2 * 0.66)} | SL ${c1(price2 * 0.55)}`);
  const s2 = await waitStrategies(msgId2);
  A.push({ ok: s2.length === 1, label: `单入场点 策略数=1`, expected: 1, actual: s2.length });
  if (s2.length === 1) {
    const d2 = await strategyDetails(s2[0].id);
    const routes = JSON.parse(d2.strategy?.routes || '[]');
    A.push({ ok: routes[0]?.status === 'executed', label: `单入场点正常执行(未过滤) 实际=${routes[0]?.status}`, expected: 'executed', actual: routes[0]?.status });
    await cleanupOrders(d2.orders, 'cancel');
  }
  return A.list;
}

// =====================================================================
// T7: R 体系 + fixedRR=1.5 + 信号自带双 TP —— 3 档止盈（等分）验证
// =====================================================================
async function t7() {
  const A = mkAsserts();
  const cfg = { ...R_CFG, fixedRiskRewardClose: 1.5 };
  await setRisk(cfg);
  const price = await marketPrice('BTC_USDT');
  if (!price) throw new Error('无法获取 BTC_USDT 现价锚点');
  // R=1%（sl=0.99p）：fixedRR=1.5 档≈+2.2% rel 成交价；
  // 信号 TP1/TP2 提到 +8%/+12%，确保排序后只有 fixedRR 档紧邻成交价。
  // 注意：测试网市价成交滑点可达 +1.5%~3%（taker 吃薄盘口），此前 TP 档离成交价过近
  // 导致断言前部分档已被触发成交（订单 filledAmount=9→7 恰证 2 档各成交 1 张）。
  // 因此止盈挂单数断言放松为 >=1，且对仍挂着的档逐一断言价格（不依赖全部在场）。
  const sl = price * 0.99, tp1 = price * 1.08, tp2 = price * 1.12;
  await ensureHealthyBook('BTC_USDT', 'buy');
  const msgId = `e2e-t7-${Date.now()}`;
  await sendSignal(msgId, `BTC_USDT Long setup | CMP | TP1 ${c1(tp1)} | TP2 ${c1(tp2)} | SL ${c1(sl)}`);
  await sleep(4000);
  const strategies = await waitStrategies(msgId);
  A.push({ ok: strategies.length === 1, label: `策略数量=1`, expected: 1, actual: strategies.length });
  const { d, o, fill } = await waitOrderFill(strategies[0].id);
  if (!o) throw new Error('未生成订单');
  A.push({ ok: fill > 0, label: `市价成交 filledPrice=${fill}`, expected: '>0', actual: fill });
  if (fill > 0) {
    const cp = getOrderInitCurrentPrice(d);
    A.push({ ok: !!cp, label: `ORDER_INIT currentPrice 锚点存在 (cp=${cp})` });
    if (!cp) throw new Error('未取到 ORDER_INIT currentPrice');
    // R 体系 + fixedRR=1.5：以 currentPrice 为锚，追加 1.5R 档 → 共 3 档等分
    const exp = computeExpected({ side: 'buy', entryPrice: cp, stopLoss: sl, targets: [tp1, tp2], cfg });
    const R = Math.abs(cp - sl);
    const tol = toleranceFor(cp);
    A.push({ ok: exp.tpOrders.length === 3, label: `TP数=3 (TP1+TP2+fixedRR=1.5档)`, expected: 3, actual: exp.tpOrders.length });
    // 订单 initialTp = 排序后最小 TP 档（fixedRR 档 80762.75 因低于信号 TP1 排首位）——
    // 直接验证 fixedRR 追加档的原始价格计算正确（TpSlCalculator 排序 + 追加逻辑）。
    A.push(near(o.initialTp, exp.tps[0], tol, `initialTp=排序后最小档=fixedRR挡(${fmt(exp.tps[0].toFixed(2))})`));
    // PROTECTED 审计：REST/WS 双路径竞争 claim，赢家挂保护并写审计（两路径已对齐）——
    // 审计写入可能晚于 status=processed，轮询等待确定收敛。
    const hasProtected = await waitForProtectedAudit(strategies[0].id);
    A.push({ ok: hasProtected, label: `存在 ORDER_PROTECTED 审计（保护管线已运行）`, expected: true, actual: hasProtected });
    // 止盈挂单：仍挂在交易所的 t-tp- 档逐一断言价格 ∈ 期望集合。
    // 测试网市价滑点较大（taker 吃薄盘口可达 +1.5%~3%），紧邻成交价的档可能已被触发成交
    // （属正常行情行为），因此只要求：在场档均匹配期望档价格，且去重后至少 1 档在场。
    const open = await openOrders();
    const reduceOnly = open.filter((x) =>
      (x.contract === 'BTC_USDT' || x.symbol === 'BTC_USDT') &&
      String(x.text || '').includes('t-tp-') &&
      String(x.text || '').includes(`-ord-${o.exchangeOrderId}`)
    );
    A.push({ ok: reduceOnly.length >= 1, label: `止盈挂单数>=1 (实际${reduceOnly.length}, 低档可能已被行情触发成交)`, expected: '≥1', actual: reduceOnly.length });
    if (reduceOnly.length > 0) {
      const matched = new Set();
      for (const x of reduceOnly) {
        const px = parseFloat(x.price);
        // 找期望集合中最接近的一档
        let best = null;
        for (const ep of exp.tpOrders) {
          const d0 = Math.abs(px - ep);
          if (!best || d0 < best.d) best = { ep, d: d0 };
        }
        if (best && best.d <= mktTolTick('BTC_USDT', best.ep, R)) {
          matched.add(best.ep.toFixed(2));
          A.push({ ok: true, label: `TP挂单${px.toFixed(2)} ≈ 期望档 ${best.ep.toFixed(2)}` });
        } else {
          A.push({ ok: false, label: `TP挂单${px.toFixed(2)} 未匹配任何期望档`, expected: exp.tpOrders.map((e) => e.toFixed(2)).join('/'), actual: px.toFixed(2) });
        }
      }
      A.push({ ok: matched.size >= 1, label: `在场TP档均匹配期望档(去重${matched.size}档, 被行情触发成交的档不计)`, expected: '≥1', actual: matched.size });
    }
    A.push(near(o.initialSl, exp.execSl, tol, `initialSl=信号SL-R*${RPAD}(期望${fmt(exp.execSl.toFixed(2))})`));
  }
  await cleanupOrders(d.orders, 'all');
  return A.list;
}

// =====================================================================
// T8: 边界与方向性测试
// =====================================================================
async function t8() {
  const A = mkAsserts();
  // 8a: API 参数校验
  let r = await api('PUT', `/api/routes/${ROUTE_ID}`, { riskSettings: { ...R_CFG, entryOffsetFixed: -5 } });
  A.push({ ok: r.status === 400, label: `entryOffsetFixed=-5 → 400`, expected: 400, actual: r.status });
  r = await api('PUT', `/api/routes/${ROUTE_ID}`, { riskSettings: { ...R_CFG, entrySelection: 'bogus' } });
  A.push({ ok: r.status === 400, label: `entrySelection=bogus → 400`, expected: 400, actual: r.status });
  r = await api('PUT', `/api/routes/${ROUTE_ID}`, { riskSettings: { ...R_CFG, paddingMode: 'bogus' } });
  A.push({ ok: r.status === 400, label: `paddingMode=bogus → 400`, expected: 400, actual: r.status });

  // 8b: SHORT 方向 R 体系 CMP 双TP —— 验证 SL/TP 滑点方向与多头相反
  // 说明：单 TP 时 TP 会通过 tpsl 附着在入场单上，不存在 t-tp- 开放单，无法观察；
  //      双 TP 时 TP 以 reduce-only 挂单形式存在，可断言价格方向。
  const cfg = { ...R_CFG };
  await setRisk(cfg);
  const price = await marketPrice('BTC_USDT');
  if (!price) throw new Error('无法获取 BTC_USDT 现价锚点');
  // SHORT：系统风控要求 SL 高于现价（避免立即触发 "Invalid Short Strategy"）。
  // 测试网行情波动大（实测数秒内可 +1.7%~3%），若 SL 只冗余 0.5% 会因信号锚点过期被拒；
  // 冗余拉到 +5%，TP 买入挂单一并拉远到 -5%/-8%，同时降低断言窗口内被行情触发成交的概率。
  const sl = price * 1.05, tp1 = price * 0.95, tp2 = price * 0.92;
  await ensureHealthyBook('BTC_USDT', 'sell');
  const msgId = `e2e-t8b-${Date.now()}`;
  await sendSignal(msgId, `BTC_USDT Short setup | CMP | TP1 ${c1(tp1)} | TP2 ${c1(tp2)} | SL ${c1(sl)}`);
  await sleep(4000);
  const strategies = await waitStrategies(msgId);
  A.push({ ok: strategies.length === 1, label: `SHORT 策略数量=1`, expected: 1, actual: strategies.length });
  const { d, o, fill } = await waitOrderFill(strategies[0].id);
  if (!o) throw new Error('SHORT 未生成订单');
  A.push({ ok: fill > 0, label: `SHORT 市价成交 filledPrice=${fill}`, expected: '>0', actual: fill });
  if (fill > 0) {
    const cp = getOrderInitCurrentPrice(d);
    A.push({ ok: !!cp, label: `SHORT ORDER_INIT currentPrice 锚点存在 (cp=${cp})` });
    if (!cp) throw new Error('未取到 SHORT ORDER_INIT currentPrice');
    const exp = computeExpected({ side: 'sell', entryPrice: cp, stopLoss: sl, targets: [tp1, tp2], cfg });
    const R = Math.abs(cp - sl);
    const tol = toleranceFor(cp);
    // SHORT: sl_pad 把止损向远离入场方向移动（更高）；TP 挂单价=TP+R*tpPad（向入场靠近，更保守）
    A.push(near(o.initialSl, exp.execSl, tol, `SHORT initialSl=信号SL+R*${RPAD}(期望${fmt(exp.execSl.toFixed(2))})`));
    const open = await openOrders();
    const reduceOnly = open.filter((x) =>
      (x.contract === 'BTC_USDT' || x.symbol === 'BTC_USDT') &&
      String(x.text || '').includes('t-tp-') &&
      String(x.text || '').includes(`-ord-${o.exchangeOrderId}`)
    );
    A.push({ ok: reduceOnly.length >= 1, label: `SHORT 止盈挂单数>=1 (实际${reduceOnly.length}, 低档可能在断言前被触发成交)`, expected: '≥1', actual: reduceOnly.length });
    // SHORT 止盈排序为降序（价格从高到低）；在场档与期望集合匹配，去重后至少 1 档在场
    if (reduceOnly.length > 0) {
      const matched = new Set();
      for (const x of reduceOnly) {
        const px = parseFloat(x.price);
        let best = null;
        for (const ep of exp.tpOrders) {
          const d0 = Math.abs(px - ep);
          if (!best || d0 < best.d) best = { ep, d: d0 };
        }
        if (best && best.d <= mktTolTick('BTC_USDT', best.ep, R)) {
          matched.add(best.ep.toFixed(2));
          A.push({ ok: true, label: `SHORT TP挂单${px.toFixed(2)} ≈ 期望档 ${best.ep.toFixed(2)}` });
        } else {
          A.push({ ok: false, label: `SHORT TP挂单${px.toFixed(2)} 未匹配期望档`, expected: exp.tpOrders.map((e) => e.toFixed(2)).join('/'), actual: px.toFixed(2) });
        }
      }
      A.push({ ok: matched.size >= 1, label: `在场SHORT TP档均匹配期望档(去重${matched.size}档)`, expected: '≥1', actual: matched.size });
    }
  }
  await cleanupOrders(d.orders, 'all');

  // 8c: 负向验证 —— SHORT 信号 SL 低于现价时必须被风控拒绝（避免立即触发）
  const p2 = await marketPrice('BTC_USDT');
  if (!p2) throw new Error('无法获取 BTC_USDT 现价锚点');
  // SL=0.99×现价：对 SHORT 而言 SL 在现价下方 → 立即触发，必须拒绝。
  // 取价后行情可能继续上行，SL 仍低于现价（拒绝条件更稳）；若极端回暖导致 SL 高于现价则跳过。
  const msgId2 = `e2e-t8c-${Date.now()}`;
  await sendSignal(msgId2, `BTC_USDT Short setup | CMP | TP1 ${c1(p2 * 0.9)} | TP2 ${c1(p2 * 0.85)} | SL ${c1(p2 * 0.99)}`);
  await sleep(4000);
  const strategies2 = await waitStrategies(msgId2);
  A.push({ ok: strategies2.length === 1, label: `8c 负向 策略数量=1`, expected: 1, actual: strategies2.length });
  if (strategies2.length === 1) {
    const d2 = await strategyDetails(strategies2[0].id);
    const routes = JSON.parse(d2.strategy?.routes || '[]');
    const r0 = routes[0] || {};
    const status = r0.status || d2.strategy?.status;
    const err = (r0.error || '') + ' ' + (r0.reason || '');
    // SL<=现价 的 SHORT 必须被拒且不产生订单（'failed' 或 'filtered' 均可，核心是订单为空）
    const noOrder = !(d2.orders || []).length;
    A.push({ ok: status !== 'executed' && noOrder, label: `8c SHORT SL低于现价被拒(status=${status}, 订单数=${d2.orders?.length || 0})`, expected: 'rejected+无订单', actual: `${status}/${d2.orders?.length || 0}` });
    // 若拒绝发生在 route 层，断言错误信息含风控关键词
    if (status !== 'executed') {
      A.push({ ok: /Invalid Short|SL|无订单|reject/i.test(err), label: `8c 拒绝原因合理(${err.slice(0, 80)})`, expected: '含拒绝原因', actual: err.slice(0, 80) });
    }
  }
  return A.list;
}
function c1(v) { return String(Number(v.toFixed(6))); }

// ---------- 清理 ----------
async function cleanupOrders(orders, mode) {
  const open = await openOrders();
  for (const o of orders || []) {
    const ex = open.find((x) => x.id === String(o.exchangeOrderId)) || open.find((x) => String(x.text || '').includes(`t-entry-${o.id}`));
    if (mode === 'cancel') {
      await cancelOrder(o.id);
    } else if (mode === 'all') {
      await closePosition(o.symbol, o.side);
      await cancelOrder(o.id);
    }
  }
}
async function cleanupAllOrdersForSymbol(symbol, mode, opts = {}) {
  const { cap = 100, onlyMarked = false } = opts;
  const open = await openOrders();
  const mine = open.filter((x) => x.symbol === symbol && x.exchangeInstanceId === EXCHANGE);
  for (const o of mine) {
    if (mode === 'all') {
      await closePosition(o.symbol, o.side);
    }
  }
  const { data } = await api('GET', `/api/orders?limit=200&symbol=${symbol}&exchange=${EXCHANGE}`);
  const rows = Array.isArray(data) ? data : data?.items || data?.rows || [];
  // 放宽生命周期过滤：t-tp-/t-sl- 子订单在 DB 可能已是 CLOSED 而交易所仍挂着，全部尝试撤销
  let myOrders = rows.filter((x) => x.symbol === symbol);
  if (onlyMarked) {
    // 只撤销测试生成的订单（text 含挂单标记），无关历史订单不碰
    myOrders = myOrders.filter((x) => /t-entry-|t-tp-|t-sl-|-ord-/.test(String(x.text || '')));
  }
  myOrders = myOrders.slice(0, cap);
  for (const o of myOrders) {
    try { await cancelOrder(o.id); } catch { /* 已关闭/已撤的单忽略 */ }
  }
}

// ---------- main ----------
async function main() {
  await login();
  const cases = { t1, t2, t3, t4, t5, t6, t7, t8 };
  const args = process.argv.slice(2);
  const names = args.length > 0 ? args : Object.keys(cases);

  // 前置自检
  const route = await getRoute();
  if (!route) throw new Error(`路由 ${ROUTE_ID} 不存在`);
  console.log(`路由确认: ${route.name} | parser=${route.parser} | exchange=${route.exchangeInstanceId} | channelId=${route.channelId}`);
  if (String(route.channelId) !== CHANNEL) console.log(`  ⚠ channelId=${route.channelId} 与脚本 CHANNEL=${CHANNEL} 不一致，信号可能不路由`);

  // 开始前兜底清理：关闭残留仓位 + 仅撤销测试标记的挂单（限量防无超时挂起）
  for (const sym of ['BTC_USDT', 'ETH_USDT', 'SOL_USDT', 'XRP_USDT', 'DOGE_USDT']) {
    await cleanupAllOrdersForSymbol(sym, 'all', { onlyMarked: true, cap: 20 }).catch((e) => console.log(`  [cleanup] ${sym} 清理异常: ${e.message?.slice(0, 80) || e}`));
  }

  for (const n of names) {
    if (cases[n]) await runCase(n, cases[n]);
    else console.log(`未知用例: ${n}`);
  }

  // 恢复路由为默认 R 模式
  try {
    await setRisk({ ...R_CFG });
  } catch { /* ignore */ }

  console.log('\n================ 汇总 ================');
  let passed = 0;
  for (const r of results) {
    if (r.pass) passed++;
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.error ? '  → ' + r.error : ''}`);
  }
  console.log(`\n通过 ${passed}/${results.length}`);
  process.exitCode = passed === results.length ? 0 : 1;
}

main().catch((e) => {
  console.error('运行失败:', e);
  process.exit(1);
});
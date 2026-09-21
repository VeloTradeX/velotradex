/**
 * CFD P0 实盘最小资金验证脚本（V1-V6）
 *
 * 依据 内部设计文档 §8 验证项，用最小仓位/最小资金
 * 在 gate-tradfi-test 实例（USDJPY）上实测：
 *   V1  同品种同向 2 笔市价单 → 返回几个 positionId（对冲 vs 净仓）★最关键
 *   V2  priceTp/priceSl 下单附带 + 成交回报（PROTECTED 判定依据）
 *   V3  volume 步长（非步长值 0.011 试单，观察拒绝/接受）
 *   V4  休市/交易时段状态（读 ticker status/tradeMode，周末拒单形态）
 *   V5  轮询限频（burst 读接口，观察 rate limit 与延迟）
 *   V6  强平/历史记录字段（positions history 是否存在 liquidation 标识字段）
 *
 * 安全约束：
 *   - 全部下单用最小手数 minOrderVolume（USDJPY=0.01 手 ≈ 1000 名义）
 *   - priceTp/priceSl 放在远离现价的档位，避免测试期间触发
 *   - finally 强制平掉全部测试仓位
 *   - 每个写操作前打印将要执行的动作
 *
 * 用法：npx ts-node --transpile-only scripts/cfd-p0-verify.ts [--dry-run] [--only=read]
 */
import { DatabaseSync } from 'node:sqlite';
import * as path from 'path';

// ---------------------------------------------------------------------------
// 1. 读取交易所实例配置（gate-tradfi-test）
// ---------------------------------------------------------------------------
const DB_PATH = path.resolve(process.cwd(), 'data/velotradex.db');
const EXCHANGE_ID = process.env.CFD_EXCHANGE_ID || 'gate-tradfi-test';
const SYMBOL = process.env.CFD_SYMBOL || 'USDJPY'; // 内部格式（与 dict 一致）
const ARGS = process.argv.slice(2);
const DRY_RUN = ARGS.includes('--dry-run');
const ONLY_READ = ARGS.includes('--only=read');

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const row = db
  .prepare('SELECT id, name, type, config FROM exchange_instances WHERE id = ?')
  .get(EXCHANGE_ID) as any;
db.close();
if (!row) {
  console.error(`[FATAL] exchange instance ${EXCHANGE_ID} not found in ${DB_PATH}`);
  process.exit(1);
}
const cfg = JSON.parse(row.config || '{}');
console.log(`[CFG] exchange=${row.id} type=${row.type} baseURL=${cfg.baseURL} proxy=${cfg.proxyUrl || cfg.proxy || '(none)'} isTestnet=${cfg.isTestnet}`);

// ---------------------------------------------------------------------------
// 2. 构造 GateCFDRestClient（复用项目实现）
// ---------------------------------------------------------------------------
import { GateCFDRestClient } from '../src/services/exchanges/gate_cfd/GateCFDRestClient';

const client = new GateCFDRestClient({
  apiKey: cfg.apiKey,
  apiSecret: cfg.apiSecret,
  baseURL: cfg.baseURL,
  proxy: cfg.proxyUrl || cfg.proxy || undefined,
  isTestnet: !!cfg.isTestnet,
} as any);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface StepResult {
  step: string;
  ok: boolean;
  detail: any;
}

const results: StepResult[] = [];
function record(step: string, ok: boolean, detail: any) {
  results.push({ step, ok, detail });
  console.log(`\n[${ok ? 'PASS' : 'FAIL'}] ${step}`);
  console.log(JSON.stringify(detail, null, 2));
}

// ---------------------------------------------------------------------------
// 3. 只读前置检查：资产 / 品种规格 / 行情状态
// ---------------------------------------------------------------------------
async function readOnlyChecks() {
  // 资产（V0：确认账户有资金）
  try {
    const assets = await client.queryUserAssets();
    record('V0-assets', !!assets, assets);
  } catch (e: any) {
    record('V0-assets', false, { error: e.message, status: e.status, label: e.label, body: e.responseBody });
  }

  // 品种规格（V3 数据源：min/max/contractVolume/pricePrecision）
  try {
    const specs = await client.querySymbolDetail([SYMBOL]);
    const spec = specs.find((s: any) => s.symbol === SYMBOL) || specs[0];
    record('V3-spec', !!spec, spec);
  } catch (e: any) {
    record('V3-spec', false, { error: e.message, status: e.status, label: e.label, body: e.responseBody });
  }

  // 行情/交易时段（V4 数据源）
  try {
    const ticker = await client.querySymbolTicker(SYMBOL);
    record('V4-ticker', !!ticker, ticker);
  } catch (e: any) {
    record('V4-ticker', false, { error: e.message, status: e.status, label: e.label, body: e.responseBody });
  }

  // 当前持仓快照（确认无残留）
  try {
    const positions = await client.queryPositionList();
    record('V0-open-positions', true, positions.map((p: any) => ({ positionId: p.positionId, symbol: p.symbol, volume: p.volume, priceOpen: p.priceOpen, positionDir: p.positionDir, priceTp: p.priceTp, priceSl: p.priceSl })));
  } catch (e: any) {
    record('V0-open-positions', false, { error: e.message });
  }
}

// ---------------------------------------------------------------------------
// 4. V1+V2：同向 2 笔市价单 + 保护价附带
// ---------------------------------------------------------------------------
async function hedgingTest(spec: any, ticker: any) {
  const minVol = parseFloat(spec?.minOrderVolume || '0.01');
  const px = parseFloat(ticker?.last ?? ticker?.lastPrice ?? '0');
  console.log(`\n[V1] 现价=${px} 最小手数=${minVol} → 2 笔同向(买)市价单，各 ${minVol} 手`);
  if (!px || isNaN(px)) {
    record('V1-orders', false, { error: 'cannot determine market price from ticker', ticker });
    return;
  }
  // 保护价放在远离现价处（USDJPY 现价≈150，SL=140/TP=170，距离远超 min 步长 50 points）
  const priceSl = (px * 0.95).toFixed(3);
  const priceTp = (px * 1.05).toFixed(3);
  console.log(`[V1] 保护价: priceSl=${priceSl} priceTp=${priceTp}（远离现价，测试期间不会触发）`);

  const orderIds: any[] = [];
  for (let i = 0; i < 2; i++) {
    const body = {
      symbol: SYMBOL,
      side: 1, // 1=买
      priceType: 'Market',
      volume: minVol.toFixed(2),
      priceTp,
      priceSl,
    };
    console.log(`[V1] 第 ${i + 1} 笔下单:`, JSON.stringify(body));
    if (DRY_RUN) {
      orderIds.push({ id: `dry-run-${i + 1}` });
      continue;
    }
    try {
      const r = await client.createOrder(body);
      orderIds.push(r);
      console.log(`[V1] 第 ${i + 1} 笔下单返回:`, JSON.stringify(r));
    } catch (e: any) {
      record('V1-orders', false, { leg: i + 1, error: e.message, status: e.status, label: e.label, body: e.responseBody });
      return;
    }
  }
  record('V1-orders-submitted', orderIds.length === 2, orderIds);

  // 等待成交（市价单应秒级成交）
  await sleep(3000);

  // 查订单日志（V2：成交回报）
  for (const o of orderIds) {
    if (!o?.id || DRY_RUN) continue;
    try {
      const log = await client.queryOrderLog(o.id);
      record('V2-order-log', !!log, log);
    } catch (e: any) {
      record('V2-order-log', false, { orderId: o.id, error: e.message, status: e.status, label: e.label });
    }
  }

  // 查持仓（V1 核心：positionId 数量）
  try {
    const positions = await client.queryPositionList();
    const mine = positions.filter((p: any) => p.symbol === SYMBOL);
    const ids = mine.map((p: any) => p.positionId);
    record('V1-hedging', mine.length >= 2 && new Set(ids).size >= 2, {
      mode: mine.length >= 2 && new Set(ids).size >= 2 ? 'hedging（对冲：多个独立 positionId）' : mine.length === 1 ? 'netting（净仓：合并为单个 positionId）' : 'unknown',
      positionCount: mine.length,
      positionIds: ids,
      positions: mine.map((p: any) => ({ positionId: p.positionId, volume: p.volume, priceOpen: p.priceOpen, positionDir: p.positionDir, priceTp: p.priceTp, priceSl: p.priceSl, margin: p.margin, unrealizedPnl: p.unrealizedPnl })),
    });
  } catch (e: any) {
    record('V1-hedging', false, { error: e.message, status: e.status, label: e.label, body: e.responseBody });
  }
}

// ---------------------------------------------------------------------------
// 5. V3：volume 步长探测（0.011 非步长值）
// ---------------------------------------------------------------------------
async function volumeStepProbe(spec: any) {
  const minVol = parseFloat(spec?.minOrderVolume || '0.01');
  const probeVol = (minVol + 0.001).toFixed(3); // min+0.001，若步长=0.01 应被拒
  console.log(`\n[V3] 步长探测：下单 ${probeVol} 手（min=${minVol}），观察接受/拒绝形态`);
  if (DRY_RUN) {
    record('V3-probe', true, { note: 'dry-run 跳过' });
    return;
  }
  try {
    const r = await client.createOrder({
      symbol: SYMBOL,
      side: 1,
      priceType: 'Market',
      volume: probeVol,
      // 不带保护价，探测后立即全平
    });
    record('V3-probe', true, { accepted: true, orderId: r.id, probeVol, note: '非步长值被接受 → 步长 < 0.001 或无步长约束' });
    return r;
  } catch (e: any) {
    record('V3-probe', true, {
      accepted: false,
      error: e.message,
      status: e.status,
      label: e.label,
      body: e.responseBody,
      probeVol,
      note: '非步长值被拒绝 → 错误信息揭示步长约束',
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// 6. V5：读接口 burst（限频观察）
// ---------------------------------------------------------------------------
async function rateLimitProbe() {
  console.log(`\n[V5] 读接口 burst：连续 12 次 queryPositionList（模拟 poller 节奏）`);
  const latencies: number[] = [];
  let errors = 0;
  for (let i = 0; i < 12; i++) {
    const t0 = Date.now();
    try {
      await client.queryPositionList();
      latencies.push(Date.now() - t0);
    } catch (e: any) {
      errors++;
      latencies.push(Date.now() - t0);
      if (errors <= 2) console.log(`[V5] 第 ${i + 1} 次失败:`, e.message, e.status, e.label, JSON.stringify(e.responseBody));
    }
    await sleep(200);
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  record('V5-rate-limit', errors === 0, {
    attempts: 12,
    errors,
    latencyMinMs: sorted[0],
    latencyMedianMs: sorted[Math.floor(sorted.length / 2)],
    latencyMaxMs: sorted[sorted.length - 1],
    note: errors === 0 ? '12 连发无限频错误 → 1s 级 poller 间隔安全' : '出现限频错误 → 需调整 poller 间隔',
  });
}

// ---------------------------------------------------------------------------
// 7. V6：position history 字段（强平/平仓标识）
// ---------------------------------------------------------------------------
async function positionHistoryProbe() {
  // 尝试调用历史持仓/订单历史，观察平仓类型字段（liquidation/closeType 等）
  try {
    const hist = await (client as any).queryOrderHistoryList({ symbol: SYMBOL });
    const sample = Array.isArray(hist) ? hist.slice(0, 5) : hist;
    record('V6-order-history', true, {
      count: Array.isArray(hist) ? hist.length : 0,
      sample,
      note: '观察历史记录中平仓类型/强平标识字段',
    });
  } catch (e: any) {
    record('V6-order-history', false, { error: e.message, status: e.status, label: e.label, body: e.responseBody });
  }
}

// ---------------------------------------------------------------------------
// 8. 清理：全平测试仓位
// ---------------------------------------------------------------------------
async function cleanup() {
  try {
    const positions = await client.queryPositionList();
    const mine = positions.filter((p: any) => p.symbol === SYMBOL);
    console.log(`\n[Cleanup] 待平仓位 ${mine.length} 个:`, mine.map((p: any) => p.positionId));
    for (const p of mine) {
      console.log(`[Cleanup] 平仓 positionId=${p.positionId} closeType=1(全平)`);
      if (DRY_RUN) continue;
      try {
        const r = await client.closePosition(p.positionId, { closeType: 1 });
        console.log(`[Cleanup] 平仓返回:`, JSON.stringify(r));
      } catch (e: any) {
        console.log(`[Cleanup] 平仓失败:`, e.message, e.status, e.label, JSON.stringify(e.responseBody));
      }
    }
    await sleep(1500);
    const after = await client.queryPositionList();
    const left = after.filter((p: any) => p.symbol === SYMBOL);
    record('cleanup', left.length === 0, { remaining: left.map((p: any) => ({ positionId: p.positionId, volume: p.volume })) });
  } catch (e: any) {
    record('cleanup', false, { error: e.message });
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`[RUN] exchange=${EXCHANGE_ID} symbol=${SYMBOL} dryRun=${DRY_RUN} onlyRead=${ONLY_READ}`);
  await readOnlyChecks();

  if (!ONLY_READ) {
    // 取 spec 与 ticker 供测试用
    let spec: any = null;
    let ticker: any = null;
    try {
      const specs = await client.querySymbolDetail([SYMBOL]);
      spec = specs.find((s: any) => s.symbol === SYMBOL) || specs[0];
    } catch { /* ignore */ }
    try {
      ticker = await client.querySymbolTicker(SYMBOL);
    } catch { /* ignore */ }

    if (spec && ticker) {
      await hedgingTest(spec, ticker);
      // V3 探测（独立小单，成功后立即由 cleanup 平掉）
      await volumeStepProbe(spec);
    } else {
      console.log('[SKIP] 未获取到 spec/ticker，跳过下单类验证（可能休市或品种不可用）');
    }
    await rateLimitProbe();
    await positionHistoryProbe();
  }

  await cleanup();

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n========== P0 验证汇总 ==========`);
  console.log(`通过 ${pass}/${results.length}`);
  for (const r of results) {
    console.log(`  [${r.ok ? 'PASS' : 'FAIL'}] ${r.step}`);
  }

  const outPath = path.resolve(process.cwd(), 'data/cfd-p0-verify-result.json');
  const fs = await import('node:fs');
  fs.writeFileSync(
    outPath,
    JSON.stringify({ exchange: EXCHANGE_ID, symbol: SYMBOL, dryRun: DRY_RUN, ts: new Date().toISOString(), results }, null, 2),
  );
  console.log(`\n结果已写入 ${outPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[FATAL]', e);
    process.exit(1);
  });

/**
 * 手动刷新 Gate-CFD 品种兜底字典 dict/gate_cfd_symbols.json。
 *
 * 流程（两段式，2026-08 实测确认）：
 *   1. GET /tradfi/symbols（公开接口，无需凭据）→ 全量品种列表
 *      （symbol/描述/类别/状态/交易时段/多档杠杆）。注意该接口只给"有哪些品种"，
 *      不给合约规格（contractVolume / min-max 手数）。
 *   2. 对 status=open 的品种，按每批 10 个调 GET /tradfi/symbols/detail（需凭据）
 *      → 合约规格。实测该接口必须传 symbols 且单次 ≤10 个，空参/11+ 均报
 *      INVALID_ARGUMENT「Invalid parameter」。
 *   合并两段结果落盘。品种规格一律来自接口，不在此臆造任何交易对/规格。
 *
 * 运行时 GateCFDSymbolUtils 本就会在首个 getSpecs() 成功后自动把最新全量
 * 品种覆写进 dict/gate_cfd_symbols.json（作为下次启动的回退缓存）；本脚本用于
 * 在新增交易对上线后【立即】强制刷新该字典，无需重启服务。与运行时唯一的区别：
 * 这里直接拉取并向字典落盘，失败立即报错、绝不回退兜底，避免把"接口失败"误报成"已刷新"。
 *
 * 运行：npm run markets:cfd
 *       或 npx tsx scripts/update-gate-cfd-markets-from-api.ts
 * 凭据来源（按优先级）：① env（TRADING_GATE_TRADFI_API_KEY/SECRET，可写入 .env 或
 * .env.${APP_ENV}）；② 数据库已保存的 gate_tradfi/gate_cfd 交易所实例。
 * 说明：步骤 1 的品种列表是公开接口、不需要凭据；步骤 2 的规格接口需要凭据。
 */
import fs from 'fs';
import path from 'path';
import { Op } from 'sequelize';
import config from '../src/config';
import { ExchangeInstance } from '../src/models';
import { GateCFDRestClient } from '../src/services/exchanges/gate_cfd/GateCFDRestClient';
import { GateCFDMapper } from '../src/services/exchanges/gate_cfd/GateCFDMapper';
import { CfdSymbolSpec } from '../src/services/exchanges/gate_cfd/types';

/** GET /tradfi/symbols/detail 单次最大 symbol 数（实测：11+ 报 Invalid parameter） */
const DETAIL_BATCH_SIZE = 10;

/**
 * 凭据来源：优先 config 内 plan（env 覆盖），否则回退读取已保存的
 * gate_tradfi/gate_cfd 交易所实例（config 字段在模型 afterFind 时已解密，
 * 这里不打印密钥）。
 */
async function resolveCredential() {
  const cf = config.trading.gate_tradfi;
  if (cf && cf.apiKey && cf.apiSecret) {
    return { apiKey: cf.apiKey, apiSecret: cf.apiSecret, baseURL: cf.baseURL, proxy: cf.proxyUrl };
  }
  const inst = await ExchangeInstance.findOne({
    where: { type: { [Op.in]: ['gate_tradfi', 'gate_cfd'] }, status: 'active' },
    order: [['updatedAt', 'DESC']],
  });
  if (inst) {
    let conf: any = {};
    try {
      conf = JSON.parse(inst.config || '{}');
    } catch {
      conf = {};
    }
    if (conf.apiKey && conf.apiSecret) {
      return {
        apiKey: conf.apiKey,
        apiSecret: conf.apiSecret,
        baseURL: conf.baseURL || config.trading.gate_tradfi.baseURL,
        proxy: conf.proxy || conf.proxyUrl || config.trading.gate_tradfi.proxyUrl,
      };
    }
  }
  return null;
}

async function main() {
  const cred = await resolveCredential();
  if (!cred) {
    throw new Error(
      '未找到 Gate-CFD 凭据：env（TRADING_GATE_TRADFI_API_KEY/SECRET）与已保存实例（type=gate_tradfi/gate_cfd）均无可用密钥。' +
        '（品种列表为公开接口不需要凭据，但品种规格 GET /tradfi/symbols/detail 需要）'
    );
  }

  const rest = new GateCFDRestClient({
    id: 'scripts/update-gate-cfd',
    type: 'gate_tradfi',
    name: 'scripts/update-gate-cfd',
    apiKey: cred.apiKey,
    apiSecret: cred.apiSecret,
    baseURL: cred.baseURL,
    proxy: cred.proxy,
  });

  // 1. 全量品种列表（公开接口 GET /tradfi/symbols，无需签名）
  const list = await rest.querySymbols();
  if (!list.length) {
    throw new Error('GET /tradfi/symbols 返回空品种列表，未覆写字典。');
  }

  // 2. 分类映射（公开接口，失败不阻塞：categoryName 缺失时回落 detail 自带值）
  const categoryMap = new Map<number, string>();
  try {
    for (const c of await rest.queryCategories()) {
      if (c.categoryId != null && c.categoryName) categoryMap.set(c.categoryId, c.categoryName);
    }
  } catch (e: any) {
    console.warn(`[warn] GET /tradfi/symbols/categories 失败，分类名将缺失：${e?.message || e}`);
  }

  // 3. 筛选可交易品种（status=open；个别行可能缺 status，视为可交易）
  const openRows = list.filter((r) => !r.status || r.status === 'open');
  if (!openRows.length) {
    throw new Error('GET /tradfi/symbols 无 status=open 品种，未覆写字典。');
  }

  // 4. 分批拉规格（detail 需凭据，单批 ≤10）
  const symbols = openRows.map((r) => r.symbol);
  const specs: CfdSymbolSpec[] = [];
  for (let i = 0; i < symbols.length; i += DETAIL_BATCH_SIZE) {
    const batch = symbols.slice(i, i + DETAIL_BATCH_SIZE);
    const rows = await rest.querySymbolDetail(batch);
    specs.push(...rows);
  }
  if (!specs.length) {
    throw new Error('GET /tradfi/symbols/detail 全批返回空，未覆写字典。');
  }

  // 5. 用列表行补全 spec：分类名（列表 categoryId → categories 名称，detail 无该字段时）、
  //    交易时段（openTime/closeTime，detail 的 tradeMode 仅数字代码）
  const bySymbol = new Map(openRows.map((r) => [r.symbol, r]));
  for (const s of specs) {
    const row = bySymbol.get(s.symbol);
    if (!row) continue;
    if (!s.categoryName && row.categoryId != null) {
      s.categoryName = categoryMap.get(row.categoryId);
    }
    if (!s.tradeMode && row.tradeMode) s.tradeMode = row.tradeMode;
    if (!s.tradeTimezone && row.tradeMode) s.tradeTimezone = row.tradeMode; // 占位兜底
    // 附加列表行信息（不参与 mapSymbolSpec 的字段，供字典可读性/审计）
    s.raw = {
      ...(s.raw || {}),
      listRow: {
        symbolDesc: row.symbolDesc,
        categoryId: row.categoryId,
        status: row.status,
        openTime: row.openTime,
        closeTime: row.closeTime,
        leverages: row.leverages,
      },
    };
  }

  // 6. 落盘：格式与运行时 GateCFDSymbolUtils.saveToFile 一致
  const cacheFilePath = path.join(process.cwd(), 'dict', 'gate_cfd_symbols.json');
  const payload = {
    _comment:
      'Gate-CFD 品种规格缓存（由 GateCFDSymbolUtils 自动覆写，仅兜底，实际以 GET /tradfi/symbols/detail 为准）',
    symbols: specs,
  };
  fs.writeFileSync(cacheFilePath, JSON.stringify(payload, null, 2));

  // 7. 汇总输出
  const total = list.length;
  const open = openRows.length;
  const withSpec = specs.length;
  console.log(`品种列表: ${total} 个（status=open ${open} 个），规格拉取成功 ${withSpec} 个 → dict/gate_cfd_symbols.json`);
  const grouped = new Map<string, string[]>();
  for (const s of specs) {
    const cat = s.categoryName || '其他';
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(s.symbol);
  }
  for (const [cat, syms] of grouped) {
    console.log(`  [${cat}] ${syms.join(', ')}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

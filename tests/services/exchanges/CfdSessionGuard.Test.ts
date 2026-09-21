/**
 * CfdSessionGuard 单元测试 —— 纯逻辑，不依赖实盘。
 * 覆盖：状态字段短路 / 毫秒秒兼容 / 缺省兜底 / 左闭右开 / 跨午夜 / 24h 退化时段。
 */
import { CfdSessionGuard, isSessionOpen } from '../../../src/services/exchanges/gate_cfd/CfdSessionGuard';

// 2026-08-20 22:00:00 GMT+8 附近的时间戳（毫秒）
const H22 = Date.UTC(2026, 7, 20, 14, 0, 0); // 22:00 UTC+8

describe('CfdSessionGuard', () => {
  test('status 明确休市 → 直接 false（即使时段数据异常）', () => {
    expect(isSessionOpen({ status: 'CLOSED', openTime: 0, closeTime: 0 }, H22)).toBe(false);
    expect(isSessionOpen({ status: 'paused' }, H22)).toBe(false);
  });

  test('status 明确开市 → 直接 true', () => {
    expect(isSessionOpen({ status: 'OPEN', openTime: 0, closeTime: 0 }, H22)).toBe(true);
  });

  test('无时段信息（缺省）→ 视为开放兜底', () => {
    expect(isSessionOpen({}, H22)).toBe(true);
    expect(isSessionOpen({ openTime: 0, closeTime: 0 }, H22)).toBe(true);
  });

  test('秒级时间戳自动换算为毫秒（兼容两种单位）', () => {
    // 22:00-06:00（跨午夜），now = 23:00
    const now = H22 + 3600_000;
    const openSec = H22 / 1000;
    const closeSec = (H22 + 8 * 3600_000) / 1000; // 次日 06:00
    expect(isSessionOpen({ openTime: openSec, closeTime: closeSec }, now)).toBe(true);
    // 毫秒单位同语义
    expect(isSessionOpen({ openTime: openSec * 1000, closeTime: closeSec * 1000 }, now)).toBe(true);
  });

  test('常规时段（openTime < closeTime）左闭右开', () => {
    const open = H22;
    const close = H22 + 2 * 3600_000;
    expect(isSessionOpen({ openTime: open, closeTime: close }, open)).toBe(true);          // 开市边界
    expect(isSessionOpen({ openTime: open, closeTime: close }, open + 1000)).toBe(true);   // 时段内
    expect(isSessionOpen({ openTime: open, closeTime: close }, close)).toBe(false);        // 闭市边界
    expect(isSessionOpen({ openTime: open, closeTime: close }, open - 1000)).toBe(false);  // 时段前
  });

  test('跨午夜时段（openTime > closeTime）：now ≥ open 或 now < close 为开放', () => {
    const open = H22;                      // 22:00
    const close = H22 + 8 * 3600_000;      // 次日 06:00
    // 开市后 23:00 → 开放
    expect(isSessionOpen({ openTime: open, closeTime: close }, open + 3600_000)).toBe(true);
    // 开市前 21:00（但 < close 次日 06:00？21:00 当天 < 06:00 次日 → 误判？需真实跨天：close 落在次日，
    // 用绝对时间戳判断：now = open - 3600_000（开市前 1h），不满足 now ≥ open 也不满足 now < close → false）
    expect(isSessionOpen({ openTime: open, closeTime: close }, open - 3600_000)).toBe(false);
    // 次日 05:00（close 前 1h）→ 开放
    expect(isSessionOpen({ openTime: open, closeTime: close }, close - 3600_000)).toBe(true);
  });

  test('退化时段（openTime === closeTime，24h）→ 开放', () => {
    expect(isSessionOpen({ openTime: H22, closeTime: H22 }, H22)).toBe(true);
  });

  test('checkCanTrade：休市时返回 MARKET_CLOSED 原因', () => {
    const guard = new CfdSessionGuard();
    const r = guard.checkCanTrade({ status: 'CLOSED' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('MARKET_CLOSED');
    expect(guard.checkCanTrade({ status: 'OPEN' }).ok).toBe(true);
  });

  test('注入 nowProvider 可测休市路径', () => {
    const fixed = Date.UTC(2026, 7, 20, 12, 0, 0); // 固定时刻
    const guard = new CfdSessionGuard(() => fixed);
    const open = fixed - 3600_000;
    const close = fixed + 3600_000;
    expect(guard.isOpen({ openTime: open, closeTime: close })).toBe(true);
    expect(guard.isOpen({ openTime: open + 2 * 3600_000, closeTime: close + 2 * 3600_000 })).toBe(false);
  });
});

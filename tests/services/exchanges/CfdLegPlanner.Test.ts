/**
 * CfdLegPlanner 单元测试 —— 纯逻辑，不依赖实盘。
 * 覆盖设计文档 内部设计文档 §3.6 / §4.1 的关键路径：
 * 正常分配 / 最小量放大 / 最大量封顶 / 风险约束超限减腿 / 名义红线 / 放弃 / 单 TP / 无 TP / ratio_based。
 *
 * 说明：设计 §4.1 的示例手数（0.025/0.015/0.01）是理想化的 3 位小数分配；
 * 实盘步长为 0.01（volumePrecision=2），规划器对每腿向下取整（保证不超风险），
 * 因此 0.025 → 0.02。本测试断言以「实盘可下单的最终值」为准。
 */
import { CfdLegPlanner } from '../../../src/services/exchanges/gate_cfd/CfdLegPlanner';
import { CfdLegPlannerInput, CfdLegPlan } from '../../../src/services/exchanges/gate_cfd/types';

// XAUUSD 品种规格（与设计 §4.1 示例一致）
const XAUUSD = {
  contractVolume: 100, // oz/手
  minOrderVolume: 0.01,
  maxOrderVolume: 10,
  pricePrecision: 2,
  volumePrecision: 2,
};

function plan(overrides: Partial<CfdLegPlannerInput> = {}): CfdLegPlan {
  const input: CfdLegPlannerInput = {
    entryPrice: 2900,
    stopLoss: 2880, // R = 20
    targets: [2920, 2950, 3000],
    distribution: [0.5, 0.3, 0.2],
    contractVolume: XAUUSD.contractVolume,
    minOrderVolume: XAUUSD.minOrderVolume,
    maxOrderVolume: XAUUSD.maxOrderVolume,
    baseVolume: 0.05, // riskAmount 100 / (20 × 100)
    riskAmount: 100,
    maxPositionSize: 20000,
    pricePrecision: XAUUSD.pricePrecision,
    volumePrecision: XAUUSD.volumePrecision,
    ...overrides,
  };
  return new CfdLegPlanner().plan(input);
}

describe('CfdLegPlanner', () => {
  test('设计 §4.1 正常路径：3 腿按分配比例，每腿取整到 0.01 步长，风险与名义均不超限', () => {
    const p = plan();
    expect(p.rejected).toBe(false);
    expect(p.legs).toHaveLength(3);
    // 理想分配 0.025/0.015/0.01 → 向下取整到 0.01 步长：0.02/0.01/0.01（总 0.04）
    expect(p.legs[0]).toMatchObject({ legIndex: 0, tpPrice: '2920', volume: '0.02' });
    expect(p.legs[1]).toMatchObject({ legIndex: 1, tpPrice: '2950', volume: '0.01' });
    expect(p.legs[2]).toMatchObject({ legIndex: 2, tpPrice: '3000', volume: '0.01' });
    expect(p.totalVolume).toBe('0.04');
    // 全腿共用 SL
    expect(p.legs.every((l) => l.priceSl === '2880')).toBe(true);
    // 总风险 = 0.04 × 100 × 20 = 80 ≤ 100
    expect(p.totalRisk).toBeCloseTo(80, 6);
    // 总名义 = 0.04 × 100 × 2900 = 11600 ≤ 20000
    expect(p.totalNotional).toBeCloseTo(11600, 6);
    expect(p.amplificationApplied).toBe(false);
    expect(p.downgradedFrom).toBeUndefined();
  });

  test('最小下单量放大：0.008 手 → 每腿放大到 0.01（用户示例场景）', () => {
    // baseVolume 0.024，三等分 → 0.008/0.008/0.008，均 < min 0.01
    const p = plan({ targets: [2920, 2950, 3000], baseVolume: 0.024 });
    expect(p.rejected).toBe(false);
    expect(p.amplificationApplied).toBe(true);
    expect(p.totalVolume).toBe('0.03'); // 3 × 0.01
    expect(p.legs.every((l) => l.volume === '0.01')).toBe(true);
    // 放大后总风险 = 0.03 × 100 × 20 = 60 ≤ 100
    expect(p.totalRisk).toBeCloseTo(60, 6);
  });

  test('放大后超限 → 自动减腿重试：3 腿放大超风险，合并原始分配量后 2 腿通过', () => {
    // baseVolume 0.02，riskAmount 50：原始分配 0.01/0.006/0.004 → 放大 0.01×3 = 0.03
    // 风险 = 0.03×100×20 = 60 > 50 → 减腿：合并最小两档（原始量 0.006+0.004=0.01）→
    // 0.01 + 0.01 = 0.02 → 风险 = 0.02×100×20 = 40 ≤ 50 ✓（合并必须用原始分配量，见实现注释）
    const p = plan({ baseVolume: 0.02, riskAmount: 50 });
    expect(p.rejected).toBe(false);
    expect(p.legs).toHaveLength(2);
    expect(p.downgradedFrom).toBe(3);
    expect(p.amplificationApplied).toBe(true);
    expect(p.totalVolume).toBe('0.02');
    expect(p.totalRisk).toBeCloseTo(40, 6);
    // 合并腿 TP = (2950×0.3+3000×0.2)/0.5 = 2970
    expect(p.legs[1].tpPrice).toBe('2970');
  });

  test('名义红线超限：减腿后总手数不变（无放大），减到 1 腿仍超 → 放弃（CFD_RISK_LIMIT_REJECTED）', () => {
    // 设计 §4.1 对照场景：maxPositionSize=10000，总名义 11600 超红线，
    // 合并不改总手数 → 1 腿仍超 → rejected
    const p = plan({ maxPositionSize: 10000 });
    expect(p.rejected).toBe(true);
    expect(p.rejectReason).toContain('名义');
    expect(p.legs).toHaveLength(0); // 放弃时无腿
  });

  test('风险超限且无放大空间 → 放弃', () => {
    // baseVolume 0.05、riskAmount 60：总风险 80 > 60；无放大、合并不降手数 → 放弃
    const p = plan({ riskAmount: 60 });
    expect(p.rejected).toBe(true);
    expect(p.rejectReason).toContain('风险');
  });

  test('单 TP 信号：legs=1，同一算法（放大 → 校验）', () => {
    const p = plan({ targets: [2920], distribution: [1], baseVolume: 0.008, riskAmount: 100 });
    expect(p.rejected).toBe(false);
    expect(p.legs).toHaveLength(1);
    expect(p.legs[0]).toMatchObject({ legIndex: 0, tpPrice: '2920', volume: '0.01' });
    expect(p.amplificationApplied).toBe(true);
  });

  test('无 TP 信号：单腿 tpPrice 为空，仅 min/max 约束', () => {
    const p = plan({ targets: [], distribution: undefined, baseVolume: 0.008 });
    expect(p.rejected).toBe(false);
    expect(p.legs).toHaveLength(1);
    expect(p.legs[0].tpPrice).toBe('');
    expect(p.legs[0].volume).toBe('0.01'); // 放大到 min
  });

  test('每腿封顶 maxOrderVolume：腿手数超过上限被截断', () => {
    // 抬高红线避免触发名义/风险约束，单独验证封顶
    const opts = { riskAmount: 5000, maxPositionSize: 500000 };
    const p = plan({ ...opts, baseVolume: 1.5, maxOrderVolume: 1, targets: [2920, 2950], distribution: [0.5, 0.5] });
    expect(p.rejected).toBe(false);
    // 0.75/0.75 均 ≤ 1 → 不截断
    expect(p.legs.every((l) => l.volume === '0.75')).toBe(true);
    // 真正超上限场景：单腿 1.5 > 1
    const p2 = plan({ ...opts, baseVolume: 1.5, maxOrderVolume: 1, targets: [2920], distribution: [1] });
    expect(p2.legs[0].volume).toBe('1.00'); // 封顶到 1.00（toFixed(2) 固定精度输出）
  });

  test('ratio_based 无 SL：riskAmount=0 跳过风险约束，仅名义红线与 min/max', () => {
    const p = plan({ stopLoss: 0, riskAmount: 0, baseVolume: 0.02, targets: [2920, 2950], distribution: [0.5, 0.5] });
    expect(p.rejected).toBe(false);
    expect(p.legs[0].priceSl).toBeUndefined();
    expect(p.legs).toHaveLength(2);
  });

  test('baseVolume<=0 → 直接拒绝', () => {
    const p = plan({ baseVolume: 0 });
    expect(p.rejected).toBe(true);
  });

  test('缺省分配比例：等分（1/n）', () => {
    const p = plan({ distribution: undefined, baseVolume: 0.06, riskAmount: 200, maxPositionSize: 50000 });
    expect(p.rejected).toBe(false);
    expect(p.legs.map((l) => l.volume)).toEqual(['0.02', '0.02', '0.02']);
  });
});

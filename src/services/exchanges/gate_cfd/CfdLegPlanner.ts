// src/services/exchanges/gate_cfd/CfdLegPlanner.ts
import { CfdLeg, CfdLegPlan, CfdLegPlannerInput } from './types';

// ---------------------------------------------------------------------------
// 内部辅助类型（不导出，仅规划过程使用）
// ---------------------------------------------------------------------------

/** 内部腿：规划全程用数值运算，最终输出时统一格式化为字符串 */
interface InternalLeg {
  /** 止盈价（数值） */
  tpPrice: number;
  /** 手数（数值，经过取整 / 放大 / 封顶） */
  volume: number;
  /** 原始分配比例（来自信号 distribution，缺省等分 1/n；合并腿加权均价时使用） */
  weight: number;
}

/** adjustLegs() 递归结果 */
interface AdjustResult {
  legs: InternalLeg[];
  rejected: boolean;
  rejectReason?: string;
  totalRisk: number;
  totalNotional: number;
}

/** 递归上下文：跨轮共享的累加标记（是否发生过最小下单量放大） */
interface AdjustCtx {
  amplificationApplied: boolean;
}

/**
 * CfdLegPlanner —— Gate-CFD（/tradfi/*）多腿仓位规划器（核心风控组件）
 *
 * 职责：把一条信号（entry / SL / 多个 TP 档）规划为多腿仓位计划，
 * 每腿满足交易所规格硬限与风控红线；超限时自动减腿重试，
 * 减到 1 腿仍超限则放弃信号（rejected，审计 CFD_RISK_LIMIT_REJECTED）。
 *
 * ── CFD 风控换算（勿删，维护必读）────────────────────────────
 * 单笔风险上限 riskAmount：来自 route 风控设置「风险模式/风险值」（现有参数，未新增）
 *   fixed       → riskAmount = riskValue（USD，每笔最大亏损金额）
 *   percentage  → riskAmount = equity × riskValue%（每笔最大亏损百分比）
 *   ratio_based → 无风险上限（跟信号 quantity），riskAmount 传 0，跳过风险约束
 * 总风险 = Σ(腿手数 × contractVolume × |入场价 − 止损价|)，必须 ≤ riskAmount（单位 USD）
 * 名义红线 = Σ(腿手数 × contractVolume × 入场价)，必须 ≤ maxPositionSize（现有参数「最大持仓(U)」，单位 USD）
 * 交易所硬限：minOrderVolume ≤ 每腿手数 ≤ maxOrderVolume（GET /tradfi/symbols/detail）
 * 校验方向：≤ 上限才放行；任一超限 → 减腿重试；1 腿仍超限 → 放弃
 * ────────────────────────────────────────────────────────────
 *
 * 决策依据（内部设计文档 §1.3 D3/D4/D5、§1.4、§3.6、§4.1）：
 * - D3 单次最大风险：riskMode + riskValue → riskAmount，约束 Σ(手数×合约大小×|入场−止损|)
 * - D4 名义价值红线：maxPositionSize，约束 Σ(手数×合约大小×入场价)；每腿 ≤ maxOrderVolume
 * - D5 放大策略：手数 < minOrderVolume → 放大到 min；放大后超限 → 合并最小两档减腿重试，
 *   合并腿 TP = 两档按各自原分配比例加权均价；1 腿仍超限 → 放弃
 */
export class CfdLegPlanner {
  plan(input: CfdLegPlannerInput): CfdLegPlan {
    const {
      entryPrice,
      stopLoss,
      targets,
      contractVolume,
      minOrderVolume,
      maxOrderVolume,
      baseVolume,
      riskAmount,
      maxPositionSize,
    } = input;

    // 取整精度：手数 volumePrecision 缺省 2，价格 pricePrecision 兜底 2
    const volumePrecision = this.resolvePrecision(input.volumePrecision, 2);
    const pricePrec = this.resolvePrecision(input.pricePrecision, 2);

    // ── 边界：基线手数 ≤ 0 → 直接放弃 ──────────────────────────
    // baseVolume 由 PositionSizer 按 riskAmount 换算（含 weight/riskMultiplier 修正）；
    // ≤ 0 说明风险预算无效（fixed/percentage 下 riskAmount=0）或 ratio_based 信号手数为 0。
    if (!(baseVolume > 0) || !Number.isFinite(baseVolume)) {
      return {
        legs: [],
        totalVolume: '0',
        totalRisk: 0,
        totalNotional: 0,
        riskAmount,
        maxPositionSize,
        amplificationApplied: false,
        distribution: undefined,
        originalTargets: targets.map(String),
        rejected: true,
        rejectReason: `基线手数 baseVolume=${baseVolume} 不大于 0：风险预算（riskAmount=${riskAmount} USD）无效或信号手数为 0，无法规划仓位，放弃信号`,
      };
    }

    const hasSl = stopLoss > 0 && Number.isFinite(stopLoss);

    // ── 1) 无 TP 档位 → 单腿、无 TP 语义 ───────────────────────
    // 仅把 baseVolume 夹在交易所硬限 [minOrderVolume, maxOrderVolume]；
    // 单腿无 TP 信号不做风险/名义红线校验（无腿可减，且 baseVolume 已含 PositionSizer 风险换算）。
    if (targets.length === 0) {
      // 向下取整到 volumePrecision：避免浮点且保证不超风险
      let volume = this.floorTo(baseVolume, volumePrecision);
      let amplificationApplied = false;
      if (volume < minOrderVolume) {
        // D5 放大触发条件：取整后手数 < 最小下单量 → 放大到 minOrderVolume
        volume = minOrderVolume;
        amplificationApplied = true;
      }
      if (volume > maxOrderVolume) {
        // 交易所硬限封顶：取整后手数 > 最大下单量 → 压到 maxOrderVolume
        volume = maxOrderVolume;
      }
      // 总风险 = 手数 × contractVolume × |entry − SL|（USD）；无 SL 时为 0
      const riskDistance = hasSl ? Math.abs(entryPrice - stopLoss) : 0;
      const totalRisk = riskDistance > 0 ? volume * contractVolume * riskDistance : 0;
      // 总名义 = 手数 × contractVolume × entry（USD），仅作审计快照
      const totalNotional = volume * contractVolume * entryPrice;
      return {
        legs: [
          {
            legIndex: 0,
            tpPrice: '', // 无 TP：tpPrice 置空，表示不止盈
            volume: this.formatVolume(volume, volumePrecision),
            priceSl: hasSl ? String(stopLoss) : undefined, // 全腿共用 SL，下单随单附带
          },
        ],
        totalVolume: this.formatVolume(volume, volumePrecision),
        totalRisk,
        totalNotional,
        riskAmount,
        maxPositionSize,
        amplificationApplied,
        originalTargets: [],
        rejected: false,
      };
    }

    // ── 2) 有 targets → 逐档分配 ─────────────────────────────
    // distribution 缺省等分（1/n 求和 1）；逐档 vi = baseVolume × dist[i]
    const dist = this.resolveDistribution(targets.length, input.distribution);
    const legs: InternalLeg[] = targets.map((tp, i) => ({
      tpPrice: tp,
      volume: baseVolume * dist[i],
      weight: dist[i],
    }));

    // ── 3) adjustLegs：放大 / 封顶 / 风控校验 / 超限减腿递归 ──
    const ctx: AdjustCtx = { amplificationApplied: false };
    const result = this.adjustLegs(legs, input, volumePrecision, pricePrec, ctx);

    if (result.rejected) {
      return {
        legs: [],
        totalVolume: '0',
        totalRisk: result.totalRisk,
        totalNotional: result.totalNotional,
        riskAmount,
        maxPositionSize,
        amplificationApplied: ctx.amplificationApplied,
        distribution: dist,
        originalTargets: targets.map(String),
        rejected: true,
        rejectReason: result.rejectReason,
      };
    }

    // ── 4) 输出 CfdLegPlan ────────────────────────────────────
    const finalLegs: CfdLeg[] = result.legs.map((l, i) => ({
      legIndex: i, // 0-based，减腿后重新编号
      tpPrice: String(l.tpPrice),
      volume: this.formatVolume(l.volume, volumePrecision),
      priceSl: hasSl ? String(stopLoss) : undefined,
    }));
    const totalVolume = finalLegs.reduce((sum, l) => sum + parseFloat(l.volume), 0);

    return {
      legs: finalLegs,
      totalVolume: this.formatVolume(totalVolume, volumePrecision),
      totalRisk: result.totalRisk,
      totalNotional: result.totalNotional,
      riskAmount,
      maxPositionSize,
      // downgradedFrom：减腿后实际腿数 < 原信号档位数（原 targets.length）
      downgradedFrom: result.legs.length < targets.length ? targets.length : undefined,
      amplificationApplied: ctx.amplificationApplied,
      distribution: dist,
      originalTargets: targets.map(String),
      rejected: false,
    };
  }

  /**
   * adjustLegs：对一组腿反复执行「放大 → 封顶 → 风控校验」，
   * 任一红线超限则合并分配比例最小的两档后递归回到开头。
   * 递归终止：全部通过（返回）或只剩 1 腿仍超限（rejected）。
   */
  private adjustLegs(
    legs: InternalLeg[],
    input: CfdLegPlannerInput,
    volumePrecision: number,
    pricePrecision: number,
    ctx: AdjustCtx,
  ): AdjustResult {
    const {
      entryPrice,
      stopLoss,
      contractVolume,
      minOrderVolume,
      maxOrderVolume,
      riskAmount,
      maxPositionSize,
    } = input;

    // a/b. 逐腿放大 + 封顶（生成调整副本，不修改原始腿 volume）
    // 先向下取整到 volumePrecision 再与 min 比较：避免浮点（如 0.009999… 被误判为 ≥ min）；
    // 向下取整保证手数不超风险；放大到 minOrderVolume（D5），封顶到 maxOrderVolume（交易所硬限）。
    // 关键：保留原始分配量（leg.volume 不变）用于「减腿合并」——设计 §4.1 示例
    // 合并 TP2+TP3 = 0.015+0.01 = 0.025 用的是原始分配量；若用放大后的值合并，
    // 放大超限场景会被误判为「减腿也无法通过」（放大不降总量），与 D5 意图相悖。
    const adjusted = legs.map((leg) => {
      let v = this.floorTo(leg.volume, volumePrecision);
      if (v < minOrderVolume) {
        // 放大触发条件：取整后手数 < 最小下单量
        v = minOrderVolume;
        ctx.amplificationApplied = true;
      }
      if (v > maxOrderVolume) {
        // 封顶触发条件：取整后手数 > 最大下单量
        v = maxOrderVolume;
      }
      return { ...leg, volume: v };
    });

    const hasSl = stopLoss > 0 && Number.isFinite(stopLoss);
    // c. 风险约束生效条件：有 SL 且 riskAmount > 0（ratio_based 无 SL / riskAmount≤0 → 跳过）
    const hasRiskCheck = hasSl && riskAmount > 0;
    // d. 名义红线生效条件：maxPositionSize > 0（0 = 不校验）
    const hasNotionalCheck = maxPositionSize > 0;
    const riskDistance = hasSl ? Math.abs(entryPrice - stopLoss) : 0;

    // c. 总风险 = Σ(腿手数 × contractVolume × |entry − SL|)，必须 ≤ riskAmount（D3，单位 USD）
    // d. 总名义 = Σ(腿手数 × contractVolume × entry)，必须 ≤ maxPositionSize（D4，单位 USD）
    let totalRisk = 0;
    let totalNotional = 0;
    for (const leg of adjusted) {
      if (hasRiskCheck) {
        totalRisk += leg.volume * contractVolume * riskDistance;
      }
      totalNotional += leg.volume * contractVolume * entryPrice;
    }

    // 容差 1e-9：吸收浮点累加误差，避免「恰等于上限」的边界值被误判超限
    const riskOver = hasRiskCheck && totalRisk > riskAmount + 1e-9;
    const notionalOver = hasNotionalCheck && totalNotional > maxPositionSize + 1e-9;

    if (riskOver || notionalOver) {
      // e. 减腿触发条件：c/d 任一超限 → 合并「当前分配比例最小的两档」为一腿 → 递归回 a
      if (legs.length <= 1) {
        // 减到 1 腿仍超限 → 放弃信号（D5），返回 rejected 并写明超限原因
        const overItems: string[] = [];
        if (riskOver) {
          overItems.push(`总风险 ${this.formatUsd(totalRisk)} USD 超过单笔风险上限 ${this.formatUsd(riskAmount)} USD`);
        }
        if (notionalOver) {
          overItems.push(`总名义 ${this.formatUsd(totalNotional)} USD 超过最大持仓 ${this.formatUsd(maxPositionSize)} USD`);
        }
        return {
          legs: adjusted,
          rejected: true,
          rejectReason: `风控红线未通过，减腿至 1 腿仍无法满足：${overItems.join('；')}。放弃信号（审计 CFD_RISK_LIMIT_REJECTED）`,
          totalRisk,
          totalNotional,
        };
      }
      // 合并使用原始分配量（leg.volume 未放大）：递归回到 a 重新放大/封顶/校验
      const merged = this.mergeTwoLegs(legs, pricePrecision);
      return this.adjustLegs(merged, input, volumePrecision, pricePrecision, ctx);
    }

    return { legs: adjusted, rejected: false, totalRisk, totalNotional };
  }

  /** 减腿：把「当前分配比例（weight）最小的两档」合并为一腿，返回新的腿列表（TP 升序） */
  private mergeTwoLegs(legs: InternalLeg[], pricePrecision: number): InternalLeg[] {
    const sorted = [...legs].sort((a, b) => a.weight - b.weight);
    const a = sorted[0];
    const b = sorted[1];

    // 合并腿 TP = 两档按各自原分配比例的加权均价（pricePrecision 四舍五入）
    const weightSum = a.weight + b.weight;
    const mergedTp =
      weightSum > 0
        ? this.roundTo((a.tpPrice * a.weight + b.tpPrice * b.weight) / weightSum, pricePrecision)
        : this.roundTo((a.tpPrice + b.tpPrice) / 2, pricePrecision);

    // 合并腿 volume = 两腿之和（递归 adjustLegs 会重新取整 / 放大 / 封顶）
    const merged: InternalLeg = {
      tpPrice: mergedTp,
      volume: a.volume + b.volume,
      weight: weightSum,
    };

    const rest = legs.filter((l) => l !== a && l !== b);
    rest.push(merged);
    // 保持 TP 升序，与原 targets「升序」契约一致，输出更可读
    return rest.sort((x, y) => x.tpPrice - y.tpPrice);
  }

  /** distribution 缺省等分（1/n 求和 1）；提供的比例若和偏离 1 则归一化，保证 Σ vi = baseVolume */
  private resolveDistribution(n: number, distribution?: number[]): number[] {
    if (!distribution || distribution.length !== n) {
      return Array.from({ length: n }, () => 1 / n);
    }
    const sum = distribution.reduce((s, d) => s + d, 0);
    if (!Number.isFinite(sum) || sum <= 0) {
      return Array.from({ length: n }, () => 1 / n);
    }
    if (Math.abs(sum - 1) > 1e-9) {
      return distribution.map((d) => d / sum);
    }
    return distribution;
  }

  /** 精度兜底：非正整数精度回退到 fallback */
  private resolvePrecision(precision: number | undefined, fallback: number): number {
    if (typeof precision === 'number' && Number.isInteger(precision) && precision > 0) {
      return precision;
    }
    return fallback;
  }

  /**
   * 向下取整到 precision 位小数：Math.floor(x × 10^p) / 10^p，确保不超风险。
   * 加极小 epsilon（1e-8）消除浮点下溢：如 0.06 × (1/3) = 0.019999999999999997，
   * 若直接 floor 会得到 0.01 造成 50% 的量损；epsilon 远小于步长 0.01，不改变
   * 「向下取整」的保守语义（真实值恰在上界时仍不会向上突破）。
   */
  private floorTo(value: number, precision: number): number {
    const factor = Math.pow(10, precision);
    return Math.floor(value * factor + 1e-8) / factor;
  }

  /** 四舍五入到 precision 位小数（用于合并腿 TP 加权均价） */
  private roundTo(value: number, precision: number): number {
    const factor = Math.pow(10, precision);
    return Math.round(value * factor) / factor;
  }

  /** 手数格式化：固定精度输出，稳定可预期（如 "0.01"、"1.00"） */
  private formatVolume(value: number, precision: number): string {
    return value.toFixed(precision);
  }

  /** USD 金额展示：保留 2 位小数，去掉浮点尾巴 */
  private formatUsd(value: number): number {
    return Number(value.toFixed(2));
  }
}

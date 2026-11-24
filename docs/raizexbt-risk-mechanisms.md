# Raizexbt 信号解析与执行：频道级风控机制

> 本文记录 2026-11 针对 Raizexbt（raizelxbt 短线频道）历史回测中人工标注的解析/执行问题所新增的机制。
> 所有机制都是**频道级**的：只有 Raizexbt 解析链路会设置对应字段，其他解析器的行为不受影响。

## 背景：30 条人工修正归为 7 类

| # | 问题 | 典型消息 | 根因 | 修复位置 |
|---|---|---|---|---|
| 1 | 高风险被放大成 2R | `Risky long`、`trying this / high risk trade` | 提示词规则把 `high risk` 映射成 `riskMultiplier: 2.0` | `RaizexbtAiPrompts.ts` + 确定性规则 |
| 2 | 「半 R 规则」缺失：`0.5R` / `0.3R` 单发消息 | `0.5R`、`Risk 0.5R`、`USE 0.5R ON THIS TRADE`、`low risk` | 没有跨消息机制，消息被 ignore 或误开新仓 | `RaizexbtParser.ts` 状态机 + `UpdateOrderService` |
| 3 | 分批止盈语义错、剩余仓位裸奔 | `Partials`、`Tp1 here`、`Runner left` | 部分平仓被当全平；无 TP 前缀时撤掉了剩余仓位的 SL/TP | `RaizexbtStrategyConversion.ts` + `ClosePositionService` |
| 4 | 浮亏时设 BE 触发立即全平 | `will close if we get breakeven` | BE 止损在亏损侧被交易所拒绝 → 兜底市价全平 | `UpdateOrderService` breakeven guard |
| 5 | 该撤的挂单没撤 | `No limits for now`、`Cutting this entry` | 文本被解析成 ignore/close，`cancel` 动作从未触发 | 解析器确定性覆盖 + `handleCancel` 回复链定位 |
| 6 | 近似重复开仓 | 同一张图 8 分钟内再次发帖 | 只有「价格/SL/TP 完全相同」的精确去重 | `StrategyDeduplicationService.checkNearDuplicate` |
| 7 | 图表信号门槛宽紧失当 / 1R 计划缺失 | 无 SL 的图开仓、`full tp soon` 被当全平、`manage after 1R` 无实现 | 开仓不校验 SL；期望性措辞被当指令；无 R 触发机制 | `RaizexbtStrategyConversion.ts` + `UpdateOrderService` |

## 1. 风险倍数（确定性优先于 LLM）

`RaizexbtRiskRules.resolveRiskMultiplierFromText()` 统一口径：

| 文本 | riskMultiplier |
|---|---|
| `risky` / `high risk` / `high-risk` / `low risk` / `reduced risk` / `half R` / `half size` | 0.5 |
| `0.3-0.5R` / `0.2-0.5R` 等区间 | 取低值（0.3 / 0.2） |
| `0.25R` / `quarter size` | 0.25 |
| `1R` / `1R risk` / `normal` / `full size` | 1.0 |
| `2R+`、`2.5RR+`、`-0.5R`、`took 0.5R` | 不参与仓位（战绩/报告） |

规则优先级：**文本确定性规则 > LLM 输出 > 旧的兜底正则**；并且任何 >1R 的值会被夹到 1R（该频道只会缩仓，不会加仓）。

## 2. 半 R 规则（跨消息状态机）

交易员习惯：先发开仓信号，几秒后再补一条 `0.5R`；偶尔先发风险便签再发信号。

`RaizexbtParser` 增加了一个轻量状态机（消息按到达顺序串行解析，见 `parse()` 的 `parseQueue`）：

1. **识别独立风险便签**：整条消息除风险倍数外没有交易动作（`0.5R`、`.5R`、`Risk 0.5R`、`USE 0.5R ON THIS TRADE`、`low risk`、`Low risk> 0.3-0.5R only`）。
2. **找归属目标**：
   - 有回复链且引用了开仓信号 → 目标就是被引用信号；
   - 否则「最近一条开仓信号」在 **120 秒**内 → 目标就是它；
   - 都没有 → 暂存为 pending，套用给 **120 秒内下一条开仓信号**（数字便签优先于 `low risk` 这类泛化措辞）。
3. **执行**（`ParsedStrategy` 新增 `riskResize`）：
   - 已有持仓：市价部分平仓，使剩余仓位对应目标 R（比例 = `1 - target/base`，按当前剩余仓位计算；之后的分批平仓比例天然基于减仓后的仓位）；
   - 只有未成交挂单：`amendOrder` 把挂单数量缩放到目标 R；
   - 两者都没有：安全跳过。

## 3. 部分平仓 + 自动保本

- 任何 `0 < closePercentage < 100` 的平仓，都会额外产生一条 `update/stopLoss=breakeven` 策略，并给平仓策略打上 `keepPartialProtections=true`。
- `ClosePositionService` 在 `keepPartialProtections=true` 时**不撤销**剩余仓位的 SL/TP（否则剩余仓裸奔，`NoStopLossMonitor` 可能全平）。
- `Tp1` 简写仍走 `tpDistribution`（默认 50%），成交后由既有「TP1 成交→移 BE」链路保护。
- `Runner left` = 平 80% + BE。
- 全量**限价**平仓（例如「回到入场价就平仓」下的 reduce-only 限价单）同样保留原止损，避免挂单期间裸奔。

## 4. 浮亏时的保本语义（breakevenMode）

`ParsedStrategy.breakevenMode`：

- `'protect'`（默认，stop 移到保本/自动保本）：若执行时价格已在亏损侧 → **不碰止损**（`protect` 恢复原止损），绝不市价全平；
- `'exit_at_entry'`（交易员说「回到入场价就平仓」）：若执行时已浮亏 → 在入场价挂 **reduce-only 限价平仓单**（回本平仓），保留原止损；
- 未设置该字段的解析器保持旧行为（失败时才市价平仓兜底）。

判定依据：`UpdateOrderService.handleBreakevenInLossGuard()` 用实时 ticker 与入场价比较，浮亏/盈利分流。

## 5. 取消挂单 / 剪切入场

解析器 LLM 之后的确定性覆盖（利用 `<reply_to><origin_signal>` 的 `lifecycle_status`）：

- `No limits for now` / `not setting any limits` / `remove the limit` → `action:cancel`（只撤未成交挂单）。
- `Cutting this entry` / `cancel this entry` → `action:close`：已成交则平仓，未成交由执行层自动撤单。
- `handleCancel` 现在优先按回复链的 `replyOrderId` / `replyStrategyId` 精确定位挂单，避免撤错单。

## 6. 近似重复开仓拦截

`ParsedStrategy.nearDuplicateGuard`（普通开仓=true，DCA/加仓=false）：

- 同 `exchangeInstanceId + routeId + symbol + side`；
- 已有挂单/持仓的入场价与新信号入场价相差 ≤ **0.5R**（R = |entry − SL|，缺失时按 0.5%）；
- 且创建时间在 **30 分钟**内；
- 命中 → 策略标记 `filtered`，原因 `near_duplicate_strategy`，并写审计。

DCA / 加仓（`dca`、`adding here`、`averaging in`）豁免；并通过 `allowAddPosition` 继续走加仓逻辑。

## 7. 图表信号门槛与 1R 管理计划

- 开仓必须带可读止损：解析层对没有 SL 的开仓直接丢弃（DCA 豁免），不再依赖下游 `missing_stop_loss` 拒单。
- 风险便签 + 完整图表（入场+SL+TP）且无持仓 → 视为开仓，并强制该风险倍数（如 `0.3R` + 完整图 = 0.3R 开仓）。
- 期望性措辞（`full tp soon`、`stops alr flat`）→ ignore，永不当成全平。
- `Can manage your position after 1R accordingly` → `update` + `planRMultiple=1` / `planClosePercentage=50`：执行层在入场价 ± 1R 挂 50% 的 reduce-only 限价止盈单，成交后由 TP1→BE 链路自动移保本。

## 测试

```bash
npx jest tests/services/parsers tests/services/UpdateOrderService.executionBranches.test.ts \
  tests/services/closePositionService.keepPartialProtections.test.ts \
  tests/services/StrategyDeduplicationService.test.ts --silent
```

新增/扩展的用例覆盖：风险倍数映射、风险便签识别、半 R 前后配对、部分平仓+BE、浮亏 BE 分流、取消/剪切、1R 计划、近似重复拦截、部分平仓保护单保留。

## 已知边界

- 挂单 `amendOrder` 的交易所兼容性需要实盘验证（Gate 对带 tpsl 附件的入场单是否允许改量）；失败时保持原仓位并记录日志，不会中断流程。
- 1R 计划单是直接下到交易所的 reduce-only 限价单，未落 `Order`/`PendingProtection` 表；重启后靠交易所侧订单继续生效，但本地不追踪。
- `Tp1` 简写的 BE 依赖既有「TP1 成交→移 BE」链路；若交易所未推送成交事件，需靠对账兜底。

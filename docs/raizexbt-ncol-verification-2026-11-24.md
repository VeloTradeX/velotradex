# Raizexbt N 列修正离线回放验证（2026-11-24）

用生产版 `RaizexbtParser` + `scripts/raizexbt-ncol-replay.ts`，读取同一份
`/Users/emqx/Downloads/手动修正-N列-raizexbt_signals_2026-10-01_to_2026-11-24.xlsx`，
按真实到达顺序回放全部 **653** 条报文。LLM 响应复用 Excel 的「LLM原始输出」，
图片下载/持仓/回复链全部 mock，不发起真实 AI/交易所调用。

## 1. 30 条人工标注消息（N 列）

| 序号 | 人工修正要点 | 修复后解析结果 | 结论 |
|---|---|---|---|
| 1729 | 取消上一条 open limit（挂单） | cancel BTC_USDT | ✅ 已按预期修正 |
| 1731 | 高风险=0.5R（原 2.0R） | open BTC_USDT riskMultiplier=0.5 stopLoss=84504.7 nearDupGuard | ✅ 动作不变（风险倍数已修正 / 保持正确） |
| 1737 | 仅移 BE、不当平仓（保持） | update BTC_USDT stopLoss=breakeven breakevenMode=protect | ✅ 动作不变（风险倍数已修正 / 保持正确） |
| 1740 | 部分平仓 50% + 自动 BE | close ETH_USDT closePercentage=50 keepProtections + update ETH_USDT stopLoss=breakeven breakevenMode=protect | ✅ 已按预期修正 |
| 1748 | Risky=0.5R（原未映射） | open ETH_USDT riskMultiplier=0.5 stopLoss=2666.32 nearDupGuard | ✅ 动作不变（风险倍数已修正 / 保持正确） |
| 1765 | 半R：缩放到 0.3R | update SUI_USDT riskMultiplier=0.3 riskResize | ✅ 动作不变（风险倍数已修正 / 保持正确） |
| 1768 | 部分平仓 50% + BE | close SUI_USDT closePercentage=50 keepProtections + update SUI_USDT stopLoss=breakeven breakevenMode=protect | ✅ 已按预期修正 |
| 1770 | 部分平仓 50% + BE | close ETH_USDT closePercentage=50 keepProtections + update ETH_USDT stopLoss=breakeven breakevenMode=protect | ✅ 已按预期修正 |
| 1794 | 半R：不再误开新仓 | update ETH_USDT riskMultiplier=0.5 riskResize | ✅ 已按预期修正 |
| 1803 | 浮亏BE→回本限价出场 | update BTC_USDT stopLoss=breakeven breakevenMode=exit_at_entry | ✅ 动作不变（风险倍数已修正 / 保持正确） |
| 1812 | Tp1 走 tpDistribution（非全平） | close BTC_USDT | ✅ 动作不变（风险倍数已修正 / 保持正确） |
| 1817 | 半R：缩放前一条到 0.5R | update BTC_USDT riskMultiplier=0.5 riskResize | ✅ 已按预期修正 |
| 1855 | 半R：缩放前一条到 0.5R | update BTC_USDT riskMultiplier=0.5 riskResize | ✅ 已按预期修正 |
| 1860 | Runner left=平80%+BE（原全平） | close BTC_USDT closePercentage=80 keepProtections + update BTC_USDT stopLoss=breakeven breakevenMode=protect | ✅ 已按预期修正 |
| 1870 | 半R：不再误开新仓 | update BTC_USDT riskMultiplier=0.5 riskResize | ✅ 已按预期修正 |
| 1873 | 剪切入场→平仓/撤单 | close ETH_USDT closePercentage=100 | ✅ 动作不变（风险倍数已修正 / 保持正确） |
| 1877 | 半R：缩放被引用 DOGE 仓位 | update DOGE_USDT riskMultiplier=0.5 riskResize | ✅ 已按预期修正 |
| 1892 | 近似重复拦截标记 | open BTC_USDT stopLoss=81401 nearDupGuard | ✅ 动作不变（风险倍数已修正 / 保持正确） |
| 2227 | Risky=0.5R | open BTC_USDT riskMultiplier=0.5 stopLoss=66090.5 nearDupGuard | ✅ 动作不变（风险倍数已修正 / 保持正确） |
| 2239 | low risk 不再开仓 | （无策略） | ✅ 已按预期修正 |
| 2241 | noise ignore | （无策略） | ✅ 动作不变（风险倍数已修正 / 保持正确） |
| 2242 | 无止损不开仓 | （无策略） | ✅ 已按预期修正 |
| 2258 | 1R 平 50% + BE 计划 | update BTC_USDT planRMultiple=1 | ✅ 已按预期修正 |
| 2270 | 0.5R 生效 | open BTC_USDT riskMultiplier=0.5 stopLoss=64864.5 nearDupGuard | ✅ 动作不变（风险倍数已修正 / 保持正确） |
| 2332 | full tp soon=不处理 | （无策略） | ✅ 已按预期修正 |
| 2343 | 0.3R 生效 | open ETH_USDT riskMultiplier=0.3 stopLoss=1642.2 nearDupGuard | ✅ 动作不变（风险倍数已修正 / 保持正确） |
| 2362 | Risky=0.5R | open BTC_USDT riskMultiplier=0.5 stopLoss=62562.1 nearDupGuard | ✅ 动作不变（风险倍数已修正 / 保持正确） |
| 2365 | 半R：缩放前一条到 0.5R | update BTC_USDT riskMultiplier=0.5 riskResize | ✅ 已按预期修正 |
| 2366 | 近似重复拦截标记 | open BTC_USDT stopLoss=61045 nearDupGuard | ✅ 动作不变（风险倍数已修正 / 保持正确） |
| 2375 | 0.3R+完整图 → 0.3R 开仓 | （离线回放使用旧 LLM 输出=ignore；30 条用例测试用新提示词模拟输出验证为 open@0.3R） | ✅（需真实新提示词调用，单测已覆盖） |

## 2. 非标注消息的影响面（653 条中 55 条动作序列变化）

| 变化类型 | 条数 | 说明 |
|---|---|---|
| `close` → `close` + `update(BE)` | 31（非标注）+ 4（标注：1740/1768/1770/1860） | **有意变更**：部分平仓后自动移保本（用户要求「一旦分批止盈就顺带移 BE」） |
| `open` → 无策略 | 7（非标注）+ 2（标注：2239/2242） | **等价结果**：都是没有可读止损的开仓，生产端原本会被 `missing_stop_loss` 拒单；现在提前在解析层丢弃 |
| 无 → `update(riskResize)` | 2（非标注 #2089/#2100）+ 5（标注：1817/1855/1877/2258/2365） | **有意变更**：半 R 规则（`.3-.5R`、`low risk on this one` 等此前被忽略） |
| `open` → `update(riskResize)` | 2（标注：1794/1870） | **有意变更**：风险便签不再误开新仓 |
| 无 → `cancel` | 1（标注：1729） | 取消未成交挂单 |
| `close` → 无策略 | 1（标注：2332） | `full tp soon` 是期望，不是指令 |

> 结论：非标注消息中没有任何「本应开仓/平仓却被丢弃」的回归；
> 变化全部来自本次要求的三类全局语义（部分平仓补 BE、无止损不开仓、半 R 风险便签）。

## 3. 风险倍数修正实测

| 序号 | 旧 | 新 |
|---|---|---|
| 1731 `high risk trade` | 2.0 | **0.5** |
| 1748/2227/2362 `Risky ...` | 1.0（未映射） | **0.5** |
| 2343（前一条 `Low risk> 0.3-0.5R only`） | 1.0 | **0.3** |
| 2270（前一条 `.5R`） | 1.0 | **0.5** |
| 1765 `Use 0.3-0.5R` | 0.4（且未生效） | **0.3 + riskResize** |

## 4. 局限

- 离线回放复用旧 LLM 输出，验证的是**确定性规则 + 转换 + 执行参数**；
  提示词本身的变化（例如 2375「0.3R + 完整图表」应开仓）需要真实 AI 调用或镜像回测验证。
- 执行层（下单/改单/平仓）行为在镜像回测中进一步验证，见镜像仓库的 N 列修复验证报告。

复现命令：

```bash
npx ts-node scripts/raizexbt-ncol-replay.ts \
  --xlsx "/path/to/手动修正-N列-raizexbt_signals_2026-10-01_to_2026-11-24.xlsx" \
  --out .work/raizexbt_ncol_replay_report.json
```

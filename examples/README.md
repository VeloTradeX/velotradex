# examples

本目录中的示例数据**全部为人工编写的虚构数据**，仅用于演示解析器输入格式、
回测脚本输入输出结构以及接口请求体，**不包含任何真实交易信号、第三方内容、
真实用户信息或 Discord 频道 / 消息 ID**。

> 请勿在本目录提交从 Discord、Telegram 等平台抓取的原始消息转储。
> 这类内容通常受版权保护，且可能违反平台服务条款与隐私规定。

所有示例信号都满足以下约定：

- 信号正文（`content` / `rawMessage`）**首行带有「虚构信号 · FICTIONAL SIGNAL」标注**；
- 时间戳互不相同、覆盖不同日期；
- `channel_id` / `id` / 用户名均为占位值。

## 文件说明

| 文件 | 用途 |
|---|---|
| `kacang.json` | Kacang 解析器的规范化消息输入（虚构） |
| `kacang_signals.json` | Kacang 解析器回测的解析输出（虚构） |
| `mansoor.json` | Mansoor 解析器的规范化消息输入（虚构） |
| `mansoor_signals.json` | Mansoor 解析器回测的解析输出（虚构） |
| `raizexbt.json` | Raizexbt 解析器的原始 Discord 格式输入（虚构，`author` 为占位数据） |
| `soul.json` | `scripts/discord-json-tool.ts` 的规范化输入示例（虚构） |
| `order.json` / `market-order.json` / `limit-order.json` / `post-only.json` / `limit-tpsl.json` | 下单接口请求体示例 |

## 回测流程

`scripts/parser-backtest.ts`、`scripts/kacang-backtest.ts`、`scripts/mansoor-backtest.ts`
采用「两阶段」流程：

1. **parse**：读取规范化消息 JSON（如 `examples/mansoor.json`），解析为信号 JSON（如 `examples/mansoor_signals.json`）。
2. **backtest**：读取信号 JSON，拉取 K 线执行回测并导出 XLSX 到 `docs/backtest/`。

使用真实数据回测时，请将数据文件放在本目录之外的本地路径，并通过 `--input`
参数显式指定，避免真实信号被提交进仓库。

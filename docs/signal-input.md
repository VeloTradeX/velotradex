# 信号接入与解析

本文档说明如何把外部交易信号接入 VeloTradeX，以及系统如何解析这些信号。

> ⚠️ **本系统不内置任何信号源。** 信号由你自行接入，请务必确保来源合法合规
> （不得使用未经授权抓取的付费 / 私有信号），详见 [免责声明](../DISCLAIMER.md)。
> 本文中的信号示例均为**人工虚构**，仅用于演示格式。

---

## 1. 总览

```
   你的信号源                Redis Pub/Sub                 VeloTradeX
 ┌───────────┐   PUBLISH   ┌──────────────────┐   subscribe   ┌─────────────────────────┐
 │ 你自己的   │ ──────────▶ │ REDIS_MSG_CHANNEL │ ────────────▶ │ channelMessageHandler    │
 │ 程序/脚本  │             │ 默认 discord:msg   │               │  · 用 channel_id 匹配路由 │
 └───────────┘             └──────────────────┘               └───────────┬─────────────┘
                                                                          │
                                                             ┌────────────▼─────────────┐
                                                             │ 信号路由 SignalRoute      │
                                                             │  · parser（解析器）       │
                                                             │  · exchangeInstanceId     │
                                                             │  · riskSettings / aiMode  │
                                                             └────────────┬─────────────┘
                                                                          │ parse()
                                                             ┌────────────▼─────────────┐
                                                             │ ParsedStrategy[]          │
                                                             └────────────┬─────────────┘
                                                                          │
                                                             ┌────────────▼─────────────┐
                                                             │ 下单执行（交易所 / 虚拟交易所）│
                                                             └──────────────────────────┘
```

要点：**消息能不能被处理，取决于 `channel_id` 有没有匹配到一条启用中的信号路由。**
没有匹配时消息会被静默丢弃，日志打印 `no routes matched message`。

---

## 2. 输入通道

系统在启动时订阅一个 Redis **Pub/Sub 通道**（`src/app.ts` → `redisService.subscribe`），
通道名来自环境变量：

| 项 | 值 |
|---|---|
| 通道环境变量 | `REDIS_MSG_CHANNEL` |
| 默认值 | `discord:msg` |
| Redis 连接 | `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` / `REDIS_DB` |

> 注意：使用的是 Redis **Pub/Sub（发布/订阅）**，不是 Stream 或 List。
> 订阅者不在线时发布的消息**不会**被保留，因此请确保系统已启动并连上 Redis 后再推送。

### 投递方式 A：直接发布

```bash
redis-cli -h 127.0.0.1 -p 6379 PUBLISH discord:msg '<下方第 3 节的 JSON>'
```

### 投递方式 B：HTTP 接口

登录后调用 `/api/message/send`（内部同样是 `PUBLISH` 到该通道）：

```bash
curl -X POST http://localhost:3000/api/message/send \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{"content": { "channel_id": "my-signal-channel", "id": "msg-0001", "content": "..." }}'
```

### 前置条件：配置信号路由

在管理面板「路由」中创建一条信号路由，使其：

- **频道 ID** 与消息的 `channel_id` 一致；
- 指定 `parser`（决定用哪种解析方式）；
- 指定目标交易所实例 `exchangeInstanceId`；
- 配置风控（风险模式、杠杆、滑点等）与可选 `aiMode`。

---

## 3. 消息格式

Pub/Sub 的值是一个 **JSON 对象的字符串**。字段如下：

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `channel_id` | ✅ | string | **路由匹配键**，必须与信号路由的频道 ID 一致 |
| `content` | ✅\* | string | 信号正文，交给路由指定的解析器解析 |
| `id` | 建议 | string | 消息唯一 ID，用于去重与「编辑重发」识别 |
| `ts` | 建议 | number | epoch 毫秒；AI 解析器用于上下文排序 |
| `timestamp` | 可选 | string | ISO 8601 时间字符串 |
| `username` | 可选 | string | 发送者标识（部分解析器可能参考） |
| `attachments` | 可选 | array | 图片附件 `[{ "url", "proxy_url", "is_image" }]`，供视觉解析器使用 |
| `embeds` | 可选 | array | `[{ "description" }]`，供 `WWGParser` 使用 |

\* 若没有 `content`，则必须至少提供 `attachments` 或 `embeds`，否则消息会被丢弃。

### 最小示例

```json
{
  "channel_id": "my-signal-channel",
  "id": "msg-0001",
  "content": "【虚构信号 · FICTIONAL SIGNAL — 仅用于演示，非真实交易信号】\nBTC_USDT Long 80000 SL 79000 TP 82000",
  "timestamp": "2025-09-12T10:20:30.000Z",
  "ts": 1757672430000
}
```

---

## 4. 信号解析：三大类

同一个 `channel_id` 的消息由路由上指定的解析器处理。系统内置 7 个解析器，按**解析原理**可分为三大类。

### 4.1 基于文本解析（程序 / 规则，无 AI）

用确定性的正则 / 状态机从文本中抽取 `action / symbol / side / entry / SL / TP`。

| 解析器 | 说明 |
|---|---|
| `DefaultParser` | 兜底解析器，识别最通用的字段写法 |
| `AlwaysWinParser` | 针对固定模板文本解析 |
| `KacangParser` | 纯文本程序解析（支持双层入场等结构化规则） |

- **优点**：零外部依赖、零 API 成本、毫秒级、结果可复现。
- **缺点**：只认预设的格式，信号源一旦改文案就可能失效；无法理解自然语言或图片。

### 4.2 AI 解析（LLM 文本）

把消息文本交给**大语言模型**，由其输出结构化 JSON。解析器通过统一的
`AIParserService.analyzeRaw()` 调用，兼容任意 **OpenAI 接口**的服务（OpenAI、DeepSeek 等）。

| 解析器 | 说明 |
|---|---|
| `GaulsParser` | 文本交给 LLM，优先要求 strict JSON schema，失败时降级为宽松 `json_object` |
| `WWGParser` | 把 `embeds[].description` 作为快照，结合「上一版快照 + 差异规则」交给 LLM |

- **优点**：容忍自然语言、措辞变化、多语言、非固定格式。
- **缺点**：需要先配置 AI（`textModel`）；有网络延迟与 API 费用；结果存在不确定性。
- **相关配置**：管理面板「AI 解析」/ `AIConfig` 中的 `provider` / `apiKey` / `baseUrl` / `textModel`。

### 4.3 AI 图片识别解析（视觉 / 多模态）

有些信号源把入场、止盈、止损**画在图表截图里**，此时需要视觉模型。流程：

```
rejectReason()  →  tryParseText()（先试确定性文本快路径，命中即结束）
      │ 未命中
      ▼
找到图片附件 → 下载图片 → 转 base64 → 连文本一起提交 visionModel → 结构化 JSON
```

| 解析器 | 说明 |
|---|---|
| `RaizexbtParser` | 支持「文本 AI」与「图片视觉」两种模式：有图片走视觉，无图片走文本 |
| `MansoorParser` | 继承 `AiParserBase`：先 `tryParseText` 快路径，未命中且有图片则走视觉模型 |

- **优点**：能读懂图表截图里的标注，覆盖纯文本拿不到的信息。
- **缺点**：需要 `visionModel`；成本与延迟高于文本 AI；依赖图片可访问（`proxy_url` / 网络）。
- **失败处理**：图片下载失败、AI 未配置、重复图片都会跳过该消息并记录日志。

### 4.4 三类对比

| 维度 | 文本解析（程序） | AI 解析（文本） | AI 图片识别 |
|---|---|---|---|
| 依赖 | 无 | OpenAI 兼容 API（`textModel`） | OpenAI 兼容 API（`visionModel`） |
| 成本 | 0 | 有 | 更高 |
| 速度 | 毫秒级 | 秒级 | 秒级（含图片下载） |
| 格式容忍度 | 低（固定模板） | 高 | 高（含图表） |
| 稳定性 | 确定性 | 有不确定性 | 有不确定性 |
| 典型解析器 | `DefaultParser` / `AlwaysWinParser` / `KacangParser` | `GaulsParser` / `WWGParser` | `RaizexbtParser` / `MansoorParser` |

### 4.5 路由级 AI 增强（`aiMode`）

对于**自身不具备 AI 能力**的解析器（如 `DefaultParser`、`KacangParser`），可以在路由上
叠加一层 AI：

| `aiMode` | 行为 |
|---|---|
| `disabled`（默认） | 不使用 AI，仅用解析器自身逻辑 |
| `analyze_only` | AI **只分析并记录**结果，**不覆盖**解析器的输出 |
| `enabled` | 用 AI 结果**覆盖 / 增强**解析结果（同步执行，影响下单） |

> 对已内置 AI 的解析器，`aiMode` 不生效，由解析器自己决定。当前注册表中被标记为
> 「内置 AI」（`BUILT_IN_AI_PARSERS`）的解析器为：`RaizexbtParser`、`AlwaysWinParser`、
> `WWGParser`、`GaulsParser`、`MansoorParser`。因此 `aiMode` 实际作用于 `DefaultParser`、
> `KacangParser` 以及未来新增的、未标记为内置 AI 的解析器（其中 `AlwaysWinParser` 目前
> 虽为纯程序解析，但在注册表中被标记为内置 AI，故不接受 `aiMode` 增强）。

### 4.6 信号来源标记 `sourceType`

解析结果会记录信号来源，便于事后排查（写入 `strategy.signalOrigin`）：

| 值 | 含义 |
|---|---|
| `text` | 由文本解析得到 |
| `image` | 由图片视觉识别得到 |
| `text_inferred` | 文本被截断时，由均值反推补全得到 |

---

## 5. Raizexbt 信号示例

`RaizexbtParser` 是 AI 解析器，支持**文本**与**图片**两种输入。以下均为**虚构示例**。

### 5.1 文本信号

```json
{
  "id": "raizexbt-demo-0001",
  "channel_id": "my-raizexbt-channel",
  "username": "example_user",
  "content": "【虚构信号 · FICTIONAL SIGNAL — 仅用于演示，非真实交易信号】\nXAUUSD BUY\nEntry: 4300 - 4295\nTP1: 4317\nTP2: 4347\nSL: 4283",
  "timestamp": "2026-03-15T05:41:09.000Z",
  "ts": 1773553269000,
  "attachments": []
}
```

直接发布：

```bash
redis-cli PUBLISH discord:msg '{"id":"raizexbt-demo-0001","channel_id":"my-raizexbt-channel","content":"【虚构信号 · FICTIONAL SIGNAL】\nXAUUSD BUY\nEntry: 4300 - 4295\nTP1: 4317\nTP2: 4347\nSL: 4283","ts":1773553269000,"attachments":[]}'
```

### 5.2 图片信号（图表截图）

```json
{
  "id": "raizexbt-demo-0002",
  "channel_id": "my-raizexbt-channel",
  "username": "example_user",
  "content": "【虚构信号 · FICTIONAL SIGNAL — 仅用于演示，非真实交易信号】\nXAUUSD BUY (see chart)",
  "timestamp": "2026-04-27T16:22:38.000Z",
  "ts": 1777306958000,
  "attachments": [
    {
      "url": "https://example.com/chart.png",
      "proxy_url": "https://example.com/chart.png",
      "is_image": true
    }
  ]
}
```

> ⚠️ 图片解析需要先配置 AI（`visionModel`），且会下载图片并产生外部 API 调用与费用。
> 若图片地址需要代理，请配置 `ALL_PROXY` / `HTTPS_PROXY` / `HTTP_PROXY`
> （图片下载按该顺序读取代理）。

---

## 6. 快速验证

不配置路由也能对单条消息测试解析器（见 [AI HTTP 接口下单测试指南](ai-e2e-testing-guide.md)）：

```bash
curl -X POST http://localhost:3000/api/parser/test \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "parser": "RaizexbtParser",
    "channelId": "my-raizexbt-channel",
    "content": {
      "channel_id": "my-raizexbt-channel",
      "id": "msg-test-1",
      "content": "【虚构信号 · FICTIONAL SIGNAL — 仅用于演示，非真实交易信号】\nXAUUSD BUY\nEntry: 4300 - 4295\nTP1: 4317\nSL: 4283",
      "ts": 1773553269000
    }
  }'
```

返回 `{ result: <ParsedStrategy> }`，包含 `action / symbol / side / entryPrice / stopLoss / targets` 等字段。

---

## 7. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 日志 `no routes matched message` | 没有路由匹配该 `channel_id`，或路由未启用 |
| `Parser XxxParser not found` | 路由上配置的解析器名不在注册表中（见 `GET /api/parsers`） |
| `AIParserService disabled (no active config)` | 未配置或未启用 AI，AI 类解析器会跳过 |
| `Image download failed, skipping image parsing` | 图片地址不可访问 / 需要代理 / 已过期 |
| `Duplicate image ignored` | 同一图片被判重，属正常去重 |
| 文本解析器不识别 | 该解析器只认固定格式，检查信号格式或改用 AI 类解析器 |

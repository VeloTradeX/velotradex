# AI HTTP 接口下单测试指南

本文档用于指导 AI Agent 如何通过 HTTP API 对 VeloTradeX 系统进行端到端的下单测试。

## 1. 基础信息

- 后端服务默认地址: `http://localhost:3000`
- API 前缀: `/api/*`
- 登录接口: `POST /api/auth/login`（免认证）
- 受保护接口需在 Header 携带: `Authorization: Bearer <accessToken>`

## 2. 登录获取 Token

请求:
```
POST /api/auth/login
Content-Type: application/json

{
  "username": "admin",
  "password": "<ADMIN_DEFAULT_PASSWORD>"
}
```

返回:
```json
{
  "accessToken": "...",
  "refreshToken": "...",
  "user": { "username": "admin", "role": "admin" }
}
```

## 3. 核心测试流程（信号 → 策略 → 订单）

### 3.1 直接发送交易信号（无需 Redis）

此接口允许 AI 直接推送一条模拟的 Discord 交易信号到系统，并指定用哪个解析器：

```
POST /api/message/send
Authorization: Bearer <token>
Content-Type: application/json

{
  "content": {
    "channel_id": "test-channel",
    "id": "msg-001",
    "content": "BTC_USDT Long entry 80000, SL 79000, TP1 81000, TP2 82000"
  }
}
```

返回 `{ success: true }` 表示信号已推入 Redis 队列并被处理。

### 3.2 直接测试某个解析器

无需路由配置，直接对指定解析器做单条消息解析：

```
POST /api/parser/test
Authorization: Bearer <token>
Content-Type: application/json

{
  "parser": "RaizexbtParser",
  "channelId": "test-channel",
  "content": {
    "channel_id": "test-channel",
    "id": "msg-002",
    "content": "<具体信号文本或 JSON 对象>"
  }
}
```

返回: `{ result: <ParsedStrategy 对象> }`，包含 action、symbol、side、entryPrice、stopLoss、targets 等字段。

### 3.3 查询策略与订单

- 策略列表: `GET /api/strategies?limit=50&parser=RaizexbtParser`
- 策略详情（含订单 + 审计）: `GET /api/strategies/:id/details`
- 订单列表: `GET /api/orders`
- 挂单 + 触发单: `GET /api/orders/open`
- 订单审计日志: `GET /api/orders/:id/audit`

## 4. 常用调试接口

| 接口 | 用途 |
|---|---|
| `GET /api/config/trading-mode` | 当前交易模式（observe / testnet / real） |
| `GET /api/config/redis-channel` | Redis 消息频道名 |
| `GET /api/parsers` | 已注册解析器列表 + 风险配置 + 路由数 |
| `GET /api/exchanges` | 交易所实例列表 |
| `GET /api/exchanges/:id/markets` | 指定交易所的交易对列表 |
| `GET /api/routes` | 信号路由列表 |
| `POST /api/routes` | 创建路由（指定 parser + 交易所 + 风控） |
| `GET /api/stats` / `/api/stats/trading?days=30` | 统计数据 |
| `GET /api/version` | 版本信息 |

## 5. 路由配置与交易所实例（前置条件）

执行下单测试前，需先创建：
1. **交易所实例**: `POST /api/exchanges` — 添加 GateIO / Lighter / Virtual Gate
2. **信号路由**: `POST /api/routes` — 指定 `parser` + `exchangeInstanceId` + `channelId` + 风控参数

只有路由匹配时，`/api/message/send` 的信号才会走到下单执行流程。

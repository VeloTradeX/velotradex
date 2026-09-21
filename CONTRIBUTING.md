# 贡献指南

感谢你愿意为 VeloTradeX 贡献代码！本文档说明本地开发、测试、分支与提交规范，以及新增解析器 / 交易所时应遵循的方向。

## 开发环境

前置依赖：Node.js (v16+)、Redis（默认 `localhost:6379`）。

```bash
# 安装依赖
npm install

# 复制环境配置并按需修改
cp .env.example .env
```

### 日常开发与调试

```bash
# 启动后端开发服务（nodemon 热重载）
npm run dev
```

管理面板开发见 `admin-web/`：

```bash
cd admin-web
npm install
npm run dev   # http://localhost:5173
```

### 测试

```bash
# 单元测试
npm run test:unit

# 带覆盖率
npm run test:coverage

# E2E 测试
npm run test:e2e
```

### 类型检查

提交前请确保类型检查通过：

```bash
npx tsc --noEmit
```

## 分支与提交

### 分支

- 主分支为 `main` / `master`，保持可发布状态。
- 新功能、修复请从主分支检出独立分支，命名建议：`feat/<描述>`、`fix/<描述>`。

### 提交规范（Conventional Commits）

提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/) 约定，格式为 `<type>(<scope>): <subject>`。

```bash
fix: 修复止损在快速行情下重复下单的问题
feat: 新增 xx 解析器的风控路由配置
build: 升级 node 运行版本并更新依赖锁定文件
refactor: 拆分 TradeExecutor 的下单流程
chore: 调整 CI 的缓存策略
```

常用 type 包括：`fix`（bug 修复）、`feat`（新功能）、`build`（构建 / 依赖）、`refactor`（重构）、`chore`（杂项）、`docs`（文档）、`test`（测试）、`style`（格式）。

## 后端模块结构

后端核心位于 `src/services/`，主要按职责分层，便于长期维护：

- `src/services/TradeExecutor.ts`：执行编排的**薄门面**。它不再承载下单/平仓的具体逻辑，只做参数校验、事务边界与请求调度，对外公共 API（`execute` / `manualClosePosition` / `closeForSoftStop` 等）保持稳定。
- `src/services/executor/`：按交易动作拆分的业务服务：
  - `OpenPositionService`（开仓）
  - `ClosePositionService`（平仓）
  - `UpdateOrderService`（改单 / 撤单）
  - `deps.ts`（共享依赖注入点）、`types.ts`（窄协作接口 如 `CloseExecutor`）
- `src/services/OrderPersistenceHandler.ts`：订单状态流转与落库等无状态持久化逻辑。
- `src/services/StartupRecoveryService.ts`：启动 / 崩溃后的订单与仓位恢复编排。
- `src/services/ProtectionContext.ts`：保护层（止损 / 止盈管线、`PostFillOrchestrator`）的构造与生命周期管理。
- `src/serviceStartup.ts`：**组合根**，负责按顺序组装 `exchangeRegistry` → 路由 → `TradeExecutor` → 各监控器并启动。

新增交易执行相关逻辑时，优先放入对应的 `executor/` 子服务而不是改厚 `TradeExecutor`；跨组件依赖尽量走该模块定义的窄接口，避免 `as any` 与循环依赖。

## 新增解析器

解析器位于 `src/services/parsers/`：

1. 参照现有解析器（如 `RaizexbtParser`）实现统一的解析器接口：输入原始消息，输出结构化的交易策略（方向、进场价、止损、止盈、杠杆等）。
2. 在 `DefaultParser` 路由兜底之前注册新解析器，并支持按路由配置风控参数。
3. 补充单元测试（`tests/`），用 `examples/` 中的示例消息验证不同输入场景。

## 新增交易所

交易所实现位于 `src/services/exchanges/`：

1. 参照 `GateIOExchange` / `Lighter` / `VirtualGate` 实现统一的交易所接口：下单、止盈止损、仓位查询等。
2. 支持真实交易与测试模式，涉及资金的操作必须先经过风控链路校验。
3. 交易所密钥等敏感配置走现有凭证管理口径（`apiCredentialScope`），勿硬编码或明文落盘。
4. 合约参数写入 `dict/` 字典，补充对应测试与事件模拟。

> 说明：若现有结构与你遇到的实际需求有出入，欢迎在 PR 或 issue 中说明场景，我们共同迭代接口约定。
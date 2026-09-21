# 开发与部署指南

本文档面向**开发者与运维**，包含本地开发、目录结构、配置项、数据库迁移、构建与测试等细节。
只想把系统跑起来的普通用户，请看根目录的 [README](../README.md)。

---

## 1. 本地开发环境

### 环境要求

- Node.js (v20+)
- Redis（必须运行，默认 `localhost:6379`）
- SQLite（无需单独安装，Sequelize 自动管理文件数据库）

### 安装依赖

```bash
npm install
# 或
yarn install
```

### 配置

```bash
cp .env.example .env
# 编辑 .env，至少设置：
#   SERVER_JWT_SECRET=your_random_secret   ← 仍为占位符时服务会直接退出
#   ADMIN_DEFAULT_PASSWORD=your_admin_password
```

> `SERVER_JWT_SECRET` 保持占位符时，服务启动会打印 `FATAL: SERVER_JWT_SECRET is using the
> insecure default value` 并退出（测试环境除外），避免带着弱密钥跑实盘。

生成随机密钥：

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### 启动后端服务

```bash
npm run dev      # 开发模式（nodemon 热重载）
# 或
npm start        # 生产模式（需先 npm run build）
```

后端默认运行在 `http://localhost:3000`。默认管理员账号：用户名 `admin`，
密码为 `.env` 中 `ADMIN_DEFAULT_PASSWORD` 设置的值。

### 启动管理面板（开发模式）

```bash
cd admin-web
npm install
npm run dev     # http://localhost:5173
```

API 请求会通过 Vite Proxy 代理到 `http://localhost:3000`。

### 生产部署管理面板（不用 Docker 时）

```bash
cd admin-web
npm run build
# 将 dist/ 内容部署到 Web 服务器的 /velotradex/ 路径下
# 反向代理 /ct-api -> 后端 3000 端口
```

> 不想自己构建前端、配 Nginx？直接用 Docker 镜像即可：镜像内已包含构建好的管理面板，
> 由后端直接托管在 `/velotradex/`。

---

## 2. 环境变量

服务从仓库根目录的 `.env` 读取全部变量（命名与 `.env.example` 完全一致），
容器部署时还会加载 `docker-compose` 中覆写的若干项。核心配置项：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `APP_ENV` | `development` | 优先加载 `.env.<APP_ENV>` |
| `SERVER_PORT` | `3000` | 后端服务端口（容器部署下由 compose 固定为 `3000`） |
| `SERVER_JWT_SECRET` | 占位符 | **生产必须修改**为高强度随机值 |
| `SERVER_JWT_EXPIRES_IN` | `24h` | Token 有效期 |
| `SERVER_JWT_REFRESH_EXPIRES_IN` | `240h` | Refresh token 有效期（滑动续期） |
| `SERVER_JWT_SESSION_MAX` | `30d` | 会话绝对上限（`0` 或空 = 不限制） |
| `SERVER_ENCRYPTION_KEY` | 空 | 设置后对敏感字段做 AES-256-GCM 加密；**生产务必设置** |
| `ADMIN_DEFAULT_PASSWORD` | 空 | 首次启动创建 `admin` 账号的密码，空则创建 |
| `REDIS_HOST` / `REDIS_PORT` | `localhost:6379` | Redis 连接（容器内为 `redis:6379`） |
| `REDIS_MSG_CHANNEL` | `discord:msg` | 订阅/推送交易信号的 Redis 频道 |
| `DB_STORAGE` | `./data/velotradex.db` | SQLite 文件路径 |
| `TRADING_MODE` | `observe` | `observe`=只解析不下单 / `testnet` / `real` |
| `DEFAULT_POSITION_LEVERAGE` | `10` | 默认杠杆倍数 |
| `DEFAULT_POSITION_MARGIN_TYPE` | `cross` | `cross` / `isolated` |
| `DEFAULT_POSITION_POSITION_MODE` | `one-way` | `one-way` / `hedge` |
| `TRADING_API_PROXY` / `TRADING_WS_PROXY` | 空 | 交易所 REST / WS 代理；容器内 `127.0.0.1` 不是宿主机 |
| `LOG_LEVEL` | `info` | 日志级别 |

完整清单与注释见 [`.env.example`](../.env.example)。

> **容器部署代理提醒**：容器内的 `127.0.0.1` 指向容器自身。若在 `.env` 里填
> `http://127.0.0.1:7890`，进入 Docker 后交易所 REST/WS 会全部连接失败。
> `docker-compose*.yml` 已默认清空这些变量；确需经宿主代理出网时，请在
> `docker-compose.override.yml` 中改为 `http://host.docker.internal:7890`
> （Linux 需配合 `extra_hosts: ["host.docker.internal:host-gateway"]`）。

---

## 3. 数据库迁移

```bash
# 首次或升级后执行（空库也能一键建好：首个迁移 20260101000000-init-schema 会建立全部基础表）
npx sequelize-cli db:migrate

# 查看迁移状态
npx sequelize-cli db:migrate:status
```

迁移必须**先于**后端服务执行：空库直接启动的话，所有数据库读写都会报 `no such table`。
使用 Docker 部署时无需手工执行，compose 中的 `migrate` 一次性 job 会自动完成。
迁移文件约定见 [`migrations/README.md`](../migrations/README.md)。

---

## 4. 使用 Docker 部署

仓库提供两个 compose 文件：

| | `docker-compose.release.yml`（推荐） | `docker-compose.yml` |
|---|---|---|
| 镜像来源 | 已发布的镜像（GHCR，或 Release 离线包） | 本地 `build: .` 构建 |
| 需要 | 能访问 ghcr.io 或能下 Release 附件 | Node 工具链、npm/Debian 源、充足磁盘 |
| 适合 | 生产服务器、弱网、小磁盘机器 | 改代码后自测、离线内网 |

### 使用预构建镜像（推荐）

**GitHub Release 离线包（公开可下，不依赖镜像仓库）**：

```bash
./scripts/docker-install-from-release.sh v1.0.0    # 下载 + SHA256 校验 + docker load
cp .env.example .env                               # 至少设置 SERVER_JWT_SECRET / ADMIN_DEFAULT_PASSWORD
VTX_IMAGE=velotradex VTX_TAG=v1.0.0 docker compose -f docker-compose.release.yml up -d
```

**GHCR 镜像仓库**（已是 Public，匿名可拉，无需登录）：

```bash
cp .env.example .env
# 注意 GHCR 的 semver tag 不带 v：用 1.0.0（离线包载入后才是 velotradex:v1.0.0）
VTX_TAG=1.0.0 docker compose -f docker-compose.release.yml up -d
```

> 前提是能访问 `ghcr.io`。国内网络或拉取失败时，用上面的 Release 离线包。

### 本地构建

```bash
docker compose up -d --build     # 先自动跑 sequelize 迁移（migrate job），再启动 app
docker compose ps
docker compose logs -f app
```

两个 compose 文件都会：把 `REDIS_HOST` 指向 compose 内的 `redis` 服务、将 `SERVER_PORT`
固定为 `3000`、清空 `.env` 中指向宿主机的代理变量，并在启动 app 前先执行一次性迁移 job。

> 镜像**同时包含后端与管理面板**，不需要另外用 Nginx 托管前端：
> 管理面板 `http://<host>:3000/velotradex/`，健康检查 `http://<host>:3000/healthz`。

镜像构建、离线包、代理、Lighter 签名工具挂载、常见问题等，详见
**[容器化部署文档](../docker/README.md)**。

---

## 5. 项目结构

```
velotradex/
├── src/
│   ├── app.ts, config.ts, db.ts
│   ├── middleware/       # auth, audit, admin check, api credential scope
│   ├── models/           # Sequelize models (20+)
│   ├── routes/           # Koa route handlers
│   ├── services/
│   │   ├── parsers/      # 策略信号解析器
│   │   ├── exchanges/    # GateIO / Lighter / VirtualGate 交易所
│   │   ├── marketData/   # 行情数据流
│   │   ├── TradeExecutor.ts / ProtectionPipeline.ts / ...
│   └── utils/            # logger, json, exchange utils, retry, etc.
├── admin-web/            # Vue 3 管理面板
├── dict/                 # 交易所合约字典
├── migrations/           # Sequelize migrations
├── tests/                # Jest 单元 + E2E 测试
├── examples/             # 解析器示例消息 JSON（全部为人工虚构数据）
├── docs/                 # 文档（信号接入、开发指南、AI 测试指南）
├── tools/lighter-signer/ # Lighter 签名工具 (Go)
├── scripts/              # 辅助脚本 (TS)
└── config/database.js    # Sequelize config
```

后端模块分层与扩展方式（新增解析器 / 交易所）见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

---

## 6. 测试与类型检查

```bash
npm run test:unit       # 单元测试
npm run test:coverage   # 带覆盖率
npm run test:e2e        # E2E 测试
npx tsc --noEmit        # 类型检查（提交前必过）
```

---

## 7. 安全基线（开发者须知）

- **JWT 密钥启动保护**：生产模式（`NODE_ENV=production`，Docker 部署默认）下，服务启动时会
  检测默认占位 `SERVER_JWT_SECRET` 并拒绝启动，必须设置为高强度随机值；开发模式仅打印告警。
- **字段级加密（AES-256-GCM）**：通过设置 `SERVER_ENCRYPTION_KEY`，可对 `ExchangeInstance`
  的 `apiKey` / `apiSecret` / `privateKey` 及 `AIConfig` 的 `apiKey` 等敏感字段进行字段级加密；
  未设置该变量时以明文存储运行，并打印安全告警（向后兼容）。**注意：一旦设置后修改该值，
  已加密的密钥将无法解密，务必备份。**
- **备份 / 恢复仅 admin 可用**：`/api/backup` 接口已启用 admin 权限校验，勿将备份接口暴露到公网。

更多安全指引见 [SECURITY.md](../SECURITY.md)。

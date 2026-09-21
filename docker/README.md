# velotradex 容器化部署（Docker / Docker Compose）

本仓库根目录提供 `Dockerfile`、`docker-compose.yml`、`docker-compose.release.yml`、
`.dockerignore`，实现**一条命令**把整套系统（Node + Koa + Sequelize/SQLite + Redis
+ Vue 3 管理面板）跑起来（含自动数据库迁移）。

> **镜像内容**：单个镜像同时包含 **后端**（`dist/`）与 **前端管理面板**
> （`admin-web` 经 Vite 构建后放在 `dist/public/velotradex/`，由后端 `koa-static` 托管）。
> 因此不需要额外的 Nginx / 静态站点来部署前端：
>
> | 入口 | 地址 |
> |---|---|
> | 管理面板 | `http://<host>:3000/velotradex/`（访问 `/` 会自动 302 过去） |
> | 健康检查 | `http://<host>:3000/healthz` |
>
> 前端固定以 `/ct-api` 作为 API 前缀（见 `admin-web/src/utils/request.ts`），
> 常规部署靠 Nginx 把它重写为 `/api`；镜像内没有 Nginx，因此在 `src/app.ts` 中做了
> **等价重写中间件**，开箱即用。已有反向代理的部署不受影响。

---

## 一、两种部署方式

| | 方式 A：使用预构建镜像 | 方式 B：本地构建 |
|---|---|---|
| compose 文件 | `docker-compose.release.yml` | `docker-compose.yml` |
| 镜像来源 | GitHub Release 离线包 / 镜像仓库 | 本机现构建 |
| 需要 | `docker` + `zstd` + `curl` | Node 工具链、npm/Debian 源、充足磁盘 |
| 适合 | 生产服务器、弱网、小磁盘机器 | 改代码后自测 |

> 为什么提供方式 A：本项目的本地构建需要拉取 `node:20-slim` + 两次 `npm ci`
> （后端 + 前端，合计约 1GB 依赖）并编译 TS / Vite，在弱网或小磁盘环境下很容易失败。
> 构建已放到 CI（`.github/workflows/docker-publish.yml`），成品镜像以两种形式发布：
> **GitHub Release 离线包**（无需任何镜像仓库，公开可下载）与 **GHCR 镜像**。

## 二、方式 A：使用预构建镜像（推荐）

### A1. 一条命令安装（GitHub Release 离线包）

```bash
# 1. 进入仓库根目录
cd /path/to/velotradex

# 2. 下载 + 校验 + 载入镜像（默认版本见脚本内 DEFAULT_TAG，可传参覆盖）
./scripts/docker-install-from-release.sh v1.0.0

# 3. 复制并编辑环境变量（至少 SERVER_JWT_SECRET / ADMIN_DEFAULT_PASSWORD，见第五节）
cp .env.example .env

# 4. 用刚载入的本地镜像启动
VTX_IMAGE=velotradex VTX_TAG=v1.0.0 docker compose -f docker-compose.release.yml up -d
```

访问 `http://localhost:3000/velotradex/`（访问 `/` 会自动 302 过去）。

### A2. 手动下载离线包

在仓库 **Releases** 页面下载该版本的全部附件：

| 附件 | 说明 |
|---|---|
| `velotradex-<tag>-linux-amd64.tar.zst.part-*` | 镜像分片（单块 ≤ 1.9GB） |
| `load.sh` | 载入脚本 |
| `SHA256SUMS.txt` | 校验和 |

```bash
shasum -a 256 -c SHA256SUMS.txt    # 校验（Linux 用 sha256sum -c）
bash load.sh                       # 等价于 cat *.part-* | zstd -d | docker load
```

> - 依赖 `zstd`：`apt install zstd` / `brew install zstd`。
> - **请用 `bash load.sh` 而不是 `./load.sh`**：GitHub Release 附件不保留可执行位
>   （也可以先 `chmod +x load.sh`）。
> - 离线包只提供 `linux/amd64`；在 arm64 机器上 Docker 会以模拟方式运行。

### A3. 镜像仓库（ghcr.io，已公开）

该 Package **已设为 Public，任何人都可以匿名拉取，无需登录**：

```bash
# 直接拉（无需 docker login）
docker pull ghcr.io/velotradex/velotradex:latest   # 也可用 :1.0.0 / :sha-xxxxxxx

# 看有哪些 tag：
# https://github.com/VeloTradeX/velotradex/pkgs/container/velotradex
```

> 前提是能访问 `ghcr.io`；国内网络拉不动时走 A1/A2 的 Release 离线包。
> 若你把它推到自己的仓库（阿里云 ACR / 腾讯云 TCR / Docker Hub / 自建 registry），
> 用 `VTX_IMAGE` 指过去即可。

### A4. 启动（各来源通用）

```bash
docker compose -f docker-compose.release.yml up -d
docker compose -f docker-compose.release.yml ps     # 等 app 变成 healthy
```

- 离线包：`VTX_IMAGE=velotradex VTX_TAG=v1.0.0 docker compose -f docker-compose.release.yml up -d`
- GHCR：直接 `up -d`（默认 `ghcr.io/velotradex/velotradex:latest`）
- 不用 compose 只跑单容器（需自备 Redis）：

```bash
docker run -d --name velotradex \
  --env-file .env -p 3000:3000 -v "$PWD/data:/app/data" \
  -e REDIS_HOST=host.docker.internal -e SERVER_PORT=3000 \
  velotradex:v1.0.0
```

生产环境建议**固定版本**而不是 `latest`（把 `VTX_TAG` 写进 `.env` 即可）：

```bash
# GHCR 的 tag 不带 v 前缀；离线包载入后的镜像名是 velotradex:v1.0.0
VTX_TAG=1.0.0 docker compose -f docker-compose.release.yml up -d
```

## 三、方式 B：本地构建

```bash
# 1. 进入仓库根目录
cd /path/to/velotradex

# 2. 创建环境变量文件并编辑（同上）
cp .env.example .env

# 3. 一键构建并启动
docker compose up -d --build

# 4. 等待状态变为 healthy
docker compose ps
```

> 首次启动顺序为：`redis`(healthy) → `migrate`(退出码 0) → `app`。
> 迁移失败时 app 不会被拉起，避免在残缺 schema 上跑交易逻辑。

构建相关的两个可选参数（一般不用）：

```bash
# 目标平台没有 sqlite3 prebuilt、必须源码编译时，才装上 python3/make/g++
docker build --build-arg INSTALL_BUILD_TOOLS=true -t velotradex:local .

# 强制 sqlite3 走源码编译
docker build --build-arg NPM_CONFIG_BUILD_FROM_SOURCE=true -t velotradex:local .
```

> 默认**不安装** Debian 构建工具：`sqlite3@5.1.7` 在 node20 的 linux x64/arm64 上都有
> 官方 prebuilt 二进制，装 `python3/make/g++` 反而会因为 Debian 源慢/不稳定（国内网络常见）
> 让构建卡住甚至失败。

## 四、常用命令

以下命令以 `docker-compose.yml` 为例；用预构建镜像时把 `docker compose` 换成
`docker compose -f docker-compose.release.yml` 即可。

```bash
# 查看日志
docker compose logs -f app

# 手动执行迁移（正常情况下 migrate job 已自动完成）
docker compose exec app npx sequelize-cli db:migrate
docker compose exec app npx sequelize-cli db:migrate:status

# 只重跑一次迁移 job
docker compose run --rm migrate

# 停止
docker compose down

# 停止并同时删除数据卷（redis-data 会丢失，慎用）
docker compose down -v

# 重新构建
docker compose up -d --build
```

## 五、环境变量与配置

- 服务从仓库根目录的 `.env`（`env_file`）读取全部变量，**命名与 `.env.example` 完全一致**，
  例如 `SERVER_JWT_SECRET`、`REDIS_HOST`、`REDIS_PORT`、`DB_STORAGE` 等。
- **必须**填写 `SERVER_JWT_SECRET`。服务在 `config.ts` 中检测到仍为占位符（或为空）时，在
  生产模式（compose 默认 `NODE_ENV=production`）会打印
  `FATAL: SERVER_JWT_SECRET is using the insecure default value` 并直接退出；开发模式仅告警
  ——这也是一种安全的保护措施。
- **建议**填写 `ADMIN_DEFAULT_PASSWORD`，否则不会创建 `admin` 账号，无法登录管理面板。
- Redis 连接：compose 已把 `REDIS_HOST` 覆写为服务名 `redis`（容器内部网络），无需改动。
- 端口：compose 已把 `SERVER_PORT` 固定为 `3000` 并映射 `3000:3000`。即使 `.env` 里写的是
  本地开发用的其它端口（如 `3010`）也不会影响容器；但**不要**单独修改 `ports` 或
  `healthcheck`，两者必须与 `SERVER_PORT` 保持一致。
- 代理：`.env` 中的 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `TRADING_API_PROXY` /
  `TRADING_WS_PROXY` 通常指向**宿主机**（如 `http://127.0.0.1:7890`），而容器内的
  `127.0.0.1` 是容器自身，直传会导致交易所 REST/WS 全部连接失败。因此 compose 默认把它们
  清空；确需经宿主代理出网时，新建 `docker-compose.override.yml`：

  ```yaml
  services:
    app:
      environment:
        TRADING_API_PROXY: http://host.docker.internal:7890
        TRADING_WS_PROXY: http://host.docker.internal:7890
  ```

  （Linux 上 `host.docker.internal` 需配合 `extra_hosts: ["host.docker.internal:host-gateway"]`。）

## 六、数据与持久化

| 内容 | 挂载方式 | 默认路径/卷 |
|---|---|---|
| SQLite 数据库文件 | 宿主目录挂载 `./data:/app/data` | 容器内 `/app/data/velotradex.db`（对应 `DB_STORAGE=./data/velotradex.db`） |
| Redis 数据 | Docker 命名卷 | `redis-data` |

- 为避免误删交易数据，**不要轻易执行 `docker compose down -v`**，它会清空 Redis 数据卷。
- SQLite 单文件数据库请保留在挂载卷内，`docker compose down` 不会删除 `./data` 目录下的数据。

## 七、数据库迁移

迁移由 compose 中的 `migrate` 一次性 job 自动执行（同一镜像，命令为
`npx sequelize-cli db:migrate`），app 通过
`depends_on: { migrate: { condition: service_completed_successfully } }` 等它跑完。

- **空库首次部署**：`20260101000000-init-schema` 是基线迁移，先建出全部基础表，后续时间戳迁移
  再补 `cfd_*` / `backtest_runs` / 新增列等，因此 `docker compose up -d` 之后数据库即可用，
  无需任何手工步骤。
- **升级部署**：方式 A 改 `VTX_TAG` 后重新 `up -d`；方式 B 再次 `docker compose up -d --build`。
  未执行的迁移会被自动应用。
- **手工执行**（排查用）：

  ```bash
  docker compose exec app npx sequelize-cli db:migrate
  docker compose exec app npx sequelize-cli db:migrate:status
  docker compose run --rm migrate
  ```

- 迁移文件本身遵循 `migrations/README.md` 的约定（`up`/`down`、幂等、可回滚）。

## 八、关于 Lighter 签名工具（Go 二进制）

`tools/lighter-signer` 是一个 **Go 命令行二进制**，不是 Node 依赖，
因此**没有内置进基础镜像**。若你的路由使用了 Lighter 交易所下单，需要：

1. 在**主机**编译 Linux 二进制：
   ```bash
   ./tools/lighter-signer/build.sh all
   # 生成 bin/lighter-signer-dist/lighter-signer-linux-amd64（或 -arm64）
   ```
2. 把对应架构的二进制挂载进容器并保证可执行：
   ```yaml
   # 追加到 docker-compose.yml 的 app.volumes：
   volumes:
     - ./data:/app/data
     - ./bin/lighter-signer-dist/lighter-signer-linux-amd64:/app/bin/lighter-signer
   ```
3. 进入容器赋权：
   ```bash
   docker compose exec app chmod +x /app/bin/lighter-signer
   docker compose restart app
   ```

仅使用 Gate.io / 虚拟交易所时，可忽略本步骤。

## 九、健康检查

- `app`：每 30s 请求 `http://localhost:3000/healthz`，通过即视为健康。
  - `/healthz` 是公开且不依赖数据库的端点。**不要**改回 `/api/version`：该路径被 `/api/*`
    鉴权中间件拦截，恒定返回 401，会让容器永远处于 unhealthy。
- `redis`：`redis-cli ping`。
- `depends_on ... condition: service_healthy` 保证 app 等 Redis 就绪后再启动。

## 十、镜像发布（给维护者）

`.github/workflows/docker-publish.yml` 负责构建与发布：

- push `main` → `ghcr.io/velotradex/velotradex:{latest, main, sha-xxxxxxx}`
- push tag `v*` → 额外产出 `{1.2.3, 1.2}`，并把离线包作为 Release 附件
- 平台：`linux/amd64` + `linux/arm64`

发布后注意：

1. **GHCR 包默认是私有的**，匿名 `docker pull` 会 401；**本项目已手动改为 Public**（一次性操作）。
   若日后再建新包并希望公开，需重新做一次：
   `仓库 → Packages → 包名 → Package settings → Change visibility → Public`
   （包页面：`https://github.com/VeloTradeX/velotradex/pkgs/container/<包名>`）
2. 若组织策略禁止修改包可见性（页面提示
   “Setting is disabled by organization administrators”），GHCR 就只能给组织内成员用，
   对外分发请用 **Release 离线包**（公开仓库的 Release 附件不受该策略限制），
   或把镜像另行推到自己的仓库（阿里云 ACR / 腾讯云 TCR / Docker Hub / 自建 registry）。
3. **删 git tag 会连带删掉对应 Release**；残留的"孤儿 Release"还会导致后续
   `gh release upload` 持续失败。工作流的发布步骤已改为幂等（先按 API 删除同 tag 的
   残留 Release 再新建），但手动删 tag 前仍需谨慎。

## 十一、常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 容器一直 `health: starting` / `unhealthy` | 健康检查打到了需要鉴权的路径，或 `SERVER_PORT` 与 `ports` / `healthcheck` 不一致。前者用 `/healthz`；后者由 compose 固定 `SERVER_PORT=3000` 已避免。 |
| 启动日志 `no such table: xxx` | 迁移没跑。正常情况下 `migrate` job 会自动执行；也可 `docker compose run --rm migrate`。 |
| 交易所 API/WS 连不上 | `.env` 里的代理指向宿主机 `127.0.0.1`。compose 已默认清空，需代理时按第五节用 `host.docker.internal` 覆盖。 |
| 服务启动即退出，日志 `FATAL: SERVER_JWT_SECRET ...` | `.env` 里仍是占位符。生产模式（容器）会拒绝启动，换成随机串即可。 |
| 登录提示账号不存在 | 未设置 `ADMIN_DEFAULT_PASSWORD`；设置后 `docker compose restart app` 会自动创建 `admin`。 |
| `docker compose up` 报 migrate 的 `service_completed_successfully` 不满足 | 迁移失败了，先看 `docker compose logs migrate` 定位具体迁移。 |
| 打开 `http://<host>:3000/` 是 404 | 只有镜像/构建产物里带管理面板时 `/` 才会 302 到 `/velotradex/`。直接用仓库旧版 `Dockerfile` 构建的镜像不含前端，请改用本仓库当前版本。 |
| `docker pull ghcr.io/...` 报 `denied` / `401` | 正常情况（该包已公开）不应出现。若出现：确认镜像名是对应组织的（`ghcr.io/velotradex/...`），或直接用 Release 离线包（第二节 A1/A2）。 |

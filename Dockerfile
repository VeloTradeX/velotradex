# syntax=docker/dockerfile:1

# =============================================================================
# velotradex — 一键容器化部署（多阶段构建）
#
# 本镜像同时包含 **后端 + 前端管理面板**：
#   - 后端：scripts.build = build:version(generate-version) + tsc → dist/
#   - 前端：admin-web 用 Vite 构建（base=/velotradex/）→ dist/public/velotradex/
# 启动：node dist/app.js  (port 3000)
#
# 访问方式（镜像内自带静态托管，无需额外 Nginx）：
#   管理面板  http://<host>:3000/velotradex/
#   健康检查  http://<host>:3000/healthz
#
# 两个阶段的路径约定必须严格对齐：
#   - admin-web/vite.config.ts :  base = '/velotradex/'
#   - src/app.ts               :  serve(path.join(__dirname, 'public'))
#                                 + WEB_APP_BASE = '/velotradex'
#                                 + /ct-api → /api 等价重写（镜像内无 Nginx）
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: web-builder — 构建 Vue 3 管理面板 admin-web
# -----------------------------------------------------------------------------
FROM node:20-slim AS web-builder

WORKDIR /web

# admin-web 同样以 npm 为唯一依赖管理工具（存在 package-lock.json）
# 先只拷 package 文件，使依赖层在源码变动时仍可复用缓存
COPY admin-web/package.json admin-web/package-lock.json ./

# 前端构建需要 devDependencies（vite / vue-tsc / unplugin-*），故不传 --omit=dev
RUN npm ci --no-audit --no-fund

# 拷贝前端源码与配置（node_modules / dist 已由 .dockerignore 排除）
COPY admin-web/index.html admin-web/tsconfig.json admin-web/tsconfig.app.json \
     admin-web/tsconfig.node.json admin-web/vite.config.ts ./
COPY admin-web/public ./public
COPY admin-web/src ./src

# vue-tsc -b && vite build -> /web/dist
RUN npm run build

# -----------------------------------------------------------------------------
# Stage 2: builder — 安装后端依赖并构建产物
# -----------------------------------------------------------------------------
FROM node:20-slim AS builder

# sqlite3(v5.x) 在 node20 的 linux x64/arm64 下都有官方 prebuilt 二进制，
# 因此默认不安装 python3/make/g++：避免因 Debian 镜像源慢/不稳定（国内网络常见）
# 而卡在建构建工具上，也顺带缩小构建层体积。
# 仅当目标平台确实没有 prebuilt、必须回退源码编译时才开启：
#   docker build --build-arg INSTALL_BUILD_TOOLS=true .
ARG INSTALL_BUILD_TOOLS=false
RUN if [ "$INSTALL_BUILD_TOOLS" = "true" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends python3 make g++ \
      && rm -rf /var/lib/apt/lists/*; \
    fi

WORKDIR /app

# 仓库根目录同时存在 package-lock.json 与 yarn.lock，
# 本项目按 package.json 的 npm 方向使用 npm 作为唯一依赖管理工具。
COPY package.json package-lock.json ./

# 默认使用 lockfile 中的 prebuilt 二进制安装；
# 如需强制源码编译（例如目标平台无 prebuilt 时），构建时传入：
#   docker build --build-arg NPM_CONFIG_BUILD_FROM_SOURCE=true .
ARG NPM_CONFIG_BUILD_FROM_SOURCE=false
ENV NPM_CONFIG_BUILD_FROM_SOURCE=$NPM_CONFIG_BUILD_FROM_SOURCE

# 按 package-lock.json 精确安装全部依赖（含 devDependencies，
# 使容器内可运行 sequelize-cli db:migrate）。
RUN npm ci --no-audit --no-fund

# 拷贝编译所需源码与脚本
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

# build:version -> 生成 version.json；tsc -> 产出 dist/
RUN npm run build

# -----------------------------------------------------------------------------
# Stage 3: runtime — 精简运行镜像（后端 + 管理面板）
# -----------------------------------------------------------------------------
FROM node:20-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    NODE_PATH=./node_modules

# 以非 root 用户运行，更安全
RUN groupadd -r appuser \
  && useradd -r -g appuser appuser

# 拷贝运行时依赖与构建产物
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json
# build:version 生成的版本文件（dist/routes 通过 ../../version.json 读取）
COPY --from=builder /app/version.json ./version.json

# 前端管理面板静态资源：koa-static 挂载的是 dist/public，
# 而 app.ts 探测的是 dist/public/velotradex/index.html，故必须落在 velotradex 子目录下。
COPY --from=web-builder /web/dist ./dist/public/velotradex

# 数据库迁移所需文件（容器内可执行 npx sequelize-cli db:migrate）
COPY migrations ./migrations
COPY config ./config
COPY .sequelizerc ./

# SQLite 是文件数据库，建议把宿主目录挂载到 /app/data：
#   volumes: ./data:/app/data
RUN mkdir -p /app/data \
  && chown -R appuser:appuser /app

# -----------------------------------------------------------------------------
# Lighter 签名工具（tools/lighter-signer）是 Go 二进制，未内置进本镜像。
# 如需使用 Lighter 下单，请：
#   1) 在主机编译 Linux 二进制：./tools/lighter-signer/build.sh all
#      生成 bin/lighter-signer-dist/lighter-signer-linux-amd64（或 -arm64）
#   2) 将二进制挂载到容器（如 -v ./bin/lighter-signer-dist/lighter-signer-linux-amd64:/app/bin/lighter-signer）
#   3) 确保可执行：docker compose exec app chmod +x /app/bin/lighter-signer
# 详见 docker/README.md。基础镜像未包含该二进制即可正常运行非 Lighter 功能。
# -----------------------------------------------------------------------------

USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://localhost:3000/healthz').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/app.js"]

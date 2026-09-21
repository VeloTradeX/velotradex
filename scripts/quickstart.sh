#!/usr/bin/env bash
# =============================================================================
# velotradex 一键启动脚本（面向普通用户，无需本地编译）
#
# 它会自动完成：
#   1) 若 .env 不存在，从 .env.example 复制一份；
#   2) 自动生成 SERVER_JWT_SECRET / SERVER_ENCRYPTION_KEY / ADMIN_DEFAULT_PASSWORD
#      （已填写成非占位符的值一律原样保留，重复执行不会覆盖你的密钥）；
#   3) 拉取预构建镜像并启动 Redis + 数据库迁移 + 后端/管理面板；
#   4) 打印管理面板地址与登录账号。
#
# 用法：
#   ./scripts/quickstart.sh                  # 先试 GHCR，拉不到自动回退到 Release 离线包
#   ./scripts/quickstart.sh --tag 1.0.0      # 指定 GHCR 镜像 tag（不回退）
#   ./scripts/quickstart.sh --release v1.0.0 # 用 GitHub Release 离线包启动（无需 ghcr.io）
#   ./scripts/quickstart.sh --no-start       # 只准备 .env，不启动容器
#
# 详见 README「如何启动」与 docker/README.md。
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RELEASE_TAG=""
IMAGE_TAG=""
DO_START=1

while [ $# -gt 0 ]; do
  case "$1" in
    --release)
      RELEASE_TAG="${2:-v1.0.0}"
      shift 2 || shift
      ;;
    --tag)
      IMAGE_TAG="${2:?--tag 需要一个版本号，例如 --tag 1.0.0}"
      shift 2
      ;;
    --no-start)
      DO_START=0
      shift
      ;;
    -h|--help)
      cat <<'USAGE'
velotradex 一键启动脚本（面向普通用户，无需本地编译）

用法：
  ./scripts/quickstart.sh                  # 先用 GHCR，拉不到自动回退到 Release 离线包
  ./scripts/quickstart.sh --tag 1.0.0      # 指定 GHCR 镜像 tag（不回退）
  ./scripts/quickstart.sh --release v1.0.0 # 用 GitHub Release 离线包启动（无需 ghcr.io）
  ./scripts/quickstart.sh --no-start       # 只准备 .env，不启动容器
USAGE
      exit 0
      ;;
    *)
      echo "未知参数：$1（用 --help 查看用法）" >&2
      exit 1
      ;;
  esac
done

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m错误:\033[0m %s\n' "$*" >&2; exit 1; }

# ── 0. 检查 Docker ──────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "未找到 docker，请先安装 Docker Desktop / Docker Engine"
docker info >/dev/null 2>&1 || die "docker 未运行或当前用户无权限"
if docker compose version >/dev/null 2>&1; then
  DC=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  DC=(docker-compose)
else
  die "未找到 docker compose（v2）或 docker-compose（v1）"
fi

rand_hex() {
  local bytes="${1:-24}"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
  else
    head -c "$bytes" /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# 仅当变量缺失、为空或仍是占位符时才写入，避免覆盖用户已经配置好的值。
set_env() {
  local key="$1" value="$2"
  local current=""
  current="$(grep -E "^${key}=" .env 2>/dev/null | head -1 | cut -d= -f2- || true)"
  if [ -n "$current" ] && [ "$current" != "change_me_to_a_long_random_secret" ]; then
    return 0
  fi
  if grep -qE "^${key}=" .env; then
    sed -i.bak "s|^${key}=.*|${key}=${value}|" .env && rm -f .env.bak
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

# ── 1. 准备 .env ───────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  info "未发现 .env，从 .env.example 复制"
  cp .env.example .env
else
  info "已存在 .env，只补齐缺失的安全密钥"
fi

set_env SERVER_JWT_SECRET "$(rand_hex 48)"
set_env SERVER_ENCRYPTION_KEY "$(rand_hex 24)"
set_env ADMIN_DEFAULT_PASSWORD "$(rand_hex 12)"
ADMIN_PASSWORD="$(grep -E '^ADMIN_DEFAULT_PASSWORD=' .env | head -1 | cut -d= -f2- || true)"
# 若 .env 里 SERVER_ENCRYPTION_KEY 是首次自动生成的，提示用户妥善保存
info "安全密钥已写入 .env（请妥善保存 SERVER_ENCRYPTION_KEY，变更后已加密数据无法解密）"

if [ "$DO_START" -eq 0 ]; then
  info "--no-start 已指定，仅完成配置。之后可执行："
  echo "    ${DC[*]} -f docker-compose.release.yml up -d"
  exit 0
fi

# ── 2. 获取镜像 ────────────────────────────────────────────────────────────
if [ -n "$RELEASE_TAG" ]; then
  info "使用 GitHub Release 离线包 ${RELEASE_TAG}（下载 + 校验 + docker load）"
  ./scripts/docker-install-from-release.sh "$RELEASE_TAG"
  export VTX_IMAGE=velotradex VTX_TAG="$RELEASE_TAG"
elif [ -n "$IMAGE_TAG" ]; then
  export VTX_TAG="$IMAGE_TAG"
fi

# 未显式指定 --release 时，先试 GHCR；拉不到（未公开 / 无权限 / 网络不通）
# 就自动回退到公开的 GitHub Release 离线包，避免普通用户开箱即撞 401。
# 注：--tag 显式指定的版本不自动回退（用户明确指定了 GHCR 版本）。
if [ -z "$RELEASE_TAG" ] && [ -z "$IMAGE_TAG" ]; then
  IMG="ghcr.io/velotradex/velotradex:latest"
  info "尝试从 GHCR 拉取预构建镜像：$IMG"
  if docker pull "$IMG" >/dev/null 2>&1; then
    info "GHCR 镜像已就绪"
  else
    printf '\033[1;33m注意:\033[0m 无法从 GHCR 拉取（网络不通 / 无权限 / 包未公开）。\n'
    info "自动改用公开的 GitHub Release 离线包（无需任何登录）"
    ./scripts/docker-install-from-release.sh
    export VTX_IMAGE=velotradex VTX_TAG="v1.0.0"
  fi
fi

# ── 3. 启动 ────────────────────────────────────────────────────────────────
info "启动服务（Redis → 数据库迁移 → 后端/管理面板）"
if ! "${DC[@]}" -f docker-compose.release.yml up -d; then
  die "启动失败。若日志里是 ghcr.io 的 401/403 或网络超时，请改用离线包：
      ./scripts/quickstart.sh --release v1.0.0"
fi

info "等待 app 通过健康检查（最多 90 秒）"
health=""
for _ in $(seq 1 45); do
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' velotradex 2>/dev/null || true)"
  [ "$health" = "healthy" ] && break
  sleep 2
done
[ "$health" = "healthy" ] || printf '\033[1;33m注意:\033[0m app 尚未变为 healthy（当前: %s），请用下方日志命令排查。\n' "${health:-unknown}"

"${DC[@]}" -f docker-compose.release.yml ps || true

PORT="$(grep -E '^SERVER_PORT=' .env | head -1 | cut -d= -f2- || true)"
PORT="${PORT:-3000}"

cat <<EOF

$(printf '\033[1;32m启动完成\033[0m')

  管理面板   http://localhost:${PORT}/velotradex/
  健康检查   http://localhost:${PORT}/healthz
  用户名     admin
  密码       ${ADMIN_PASSWORD}

下一步：
  1) 登录后立即修改默认密码；
  2) 在「交易所实例」添加 Gate.io / Gate TradFi / Lighter，或先用虚拟交易所练手；
  3) 在「路由」把信号频道 channel_id 关联到解析器与交易所。
  默认 TRADING_MODE=observe，只解析不下单；确认无误后再改为 testnet / real。

查看日志： ${DC[*]} -f docker-compose.release.yml logs -f app
停止服务： ${DC[*]} -f docker-compose.release.yml down
EOF

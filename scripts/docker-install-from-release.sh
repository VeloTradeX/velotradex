#!/usr/bin/env bash
# =============================================================================
# 从 GitHub Release 下载并载入 velotradex 预构建镜像。
#
# 适用场景：无法访问 ghcr.io（例如 GHCR 包受组织策略限制、或网络不通），
# 也不需要本地具备 Node 工具链 —— 只需要 docker + zstd + curl。
#
# 用法：
#   ./scripts/docker-install-from-release.sh            # 默认版本见下面 DEFAULT_TAG
#   ./scripts/docker-install-from-release.sh v1.0.1     # 指定版本
#
# 可选环境变量：
#   REPO=VeloTradeX/velotradex   仓库
#   KEEP=1                       保留下载的临时目录（排查用）
#
# 载入完成后镜像名为 velotradex:<tag>，接着可以：
#   VTX_IMAGE=velotradex VTX_TAG=<tag> docker compose -f docker-compose.release.yml up -d
# =============================================================================
set -euo pipefail

DEFAULT_TAG="v1.0.0"
REPO="${REPO:-VeloTradeX/velotradex}"
TAG="${1:-$DEFAULT_TAG}"
# Release 目前只提供 linux/amd64 离线包；arm64 机器上 Docker 会以模拟方式运行它。
PLATFORM="linux-amd64"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m错误:\033[0m %s\n' "$*" >&2; exit 1; }

for bin in docker curl zstd; do
  command -v "$bin" >/dev/null || die "未找到 $bin（zstd: apt install zstd / brew install zstd）"
done
docker info >/dev/null 2>&1 || die "docker 未运行或无权限"

BASE="https://github.com/${REPO}/releases/download/${TAG}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/velotradex-release.XXXXXX")"
# 交互式终端显示下载进度条；被重定向/管道时保持安静输出
if [ -t 1 ]; then CURL_BAR=(--progress-bar); else CURL_BAR=(-sS); fi
cleanup() { [ "${KEEP:-}" = "1" ] || rm -rf "$TMP"; }
trap cleanup EXIT

cd "$TMP"

info "获取校验和清单 ${TAG}"
curl -fsSL --retry 3 --retry-delay 2 -o SHA256SUMS.txt "${BASE}/SHA256SUMS.txt" \
  || die "下载 SHA256SUMS.txt 失败：请确认 ${TAG} 存在且是公开 Release（${BASE}）"

# 分片数量事先未知，直接从校验和清单里解析出文件名，避免依赖 GitHub API（有速率限制）。
# 注意：macOS 自带的 bash 3.2 没有 mapfile，这里用可移植的 while-read 写法。
PARTS=()
part_count=0
while IFS= read -r p; do
  [ -n "$p" ] || continue
  PARTS[$part_count]="$p"
  part_count=$((part_count + 1))
done < <(grep -oE "velotradex-[^ ]+\.part-[a-z]+" SHA256SUMS.txt | sort -u)
[ "$part_count" -gt 0 ] || die "校验和清单里没有找到镜像分片，文件内容异常"

info "下载 ${part_count} 个分片"
for p in "${PARTS[@]}"; do
  printf '   %s ... ' "$p"
  curl -fL --retry 3 --retry-delay 2 -C - "${CURL_BAR[@]}" -o "$p" "${BASE}/${p}" || die "下载 ${p} 失败"
  printf 'ok\n'
done

info "校验 SHA256"
# 只校验本次实际下载的分片，避免因为没下载 load.sh 而报错退出
: > parts.sha256
for p in "${PARTS[@]}"; do
  grep -F "  ${p}" SHA256SUMS.txt >> parts.sha256 || die "校验和清单里缺少 ${p}"
done
if command -v sha256sum >/dev/null; then
  sha256sum -c parts.sha256
else
  shasum -a 256 -c parts.sha256
fi

info "解压并载入镜像 velotradex:${TAG}"
cat "${PARTS[@]}" | zstd -d | docker load

cat <<EOF

$(printf '\033[1;32m完成\033[0m')：镜像 velotradex:${TAG} 已就绪

下一步：
  1) 复制环境变量并填写 SERVER_JWT_SECRET / ADMIN_DEFAULT_PASSWORD
       cp .env.example .env
  2) 用 compose 启动（自动执行数据库迁移并拉起 Redis）
       VTX_IMAGE=velotradex VTX_TAG=${TAG} docker compose -f docker-compose.release.yml up -d
  3) 打开管理面板
       http://<host>:3000/velotradex/
EOF

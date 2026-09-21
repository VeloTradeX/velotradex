#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SIGNER_DIR="$ROOT_DIR/tools/lighter-signer"
BIN_DIR="$ROOT_DIR/bin"

build_one() {
  local goos="$1"
  local goarch="$2"
  local output="$3"

  (
    cd "$SIGNER_DIR"
    rm -f "$output"
    CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" go build \
      -trimpath \
      -ldflags="-s -w" \
      -o "$output" \
      ./cmd/lighter-signer
  )
}

mkdir -p "$BIN_DIR"

case "${1:-host}" in
  host)
    build_one "$(go env GOOS)" "$(go env GOARCH)" "$BIN_DIR/lighter-signer"
    chmod +x "$BIN_DIR/lighter-signer"
    echo "created $BIN_DIR/lighter-signer"
    ;;
  all)
    DIST_DIR="$BIN_DIR/lighter-signer-dist"
    mkdir -p "$DIST_DIR"
    build_one linux amd64 "$DIST_DIR/lighter-signer-linux-amd64"
    build_one linux arm64 "$DIST_DIR/lighter-signer-linux-arm64"
    build_one darwin amd64 "$DIST_DIR/lighter-signer-darwin-amd64"
    build_one darwin arm64 "$DIST_DIR/lighter-signer-darwin-arm64"
    build_one windows amd64 "$DIST_DIR/lighter-signer-windows-amd64.exe"
    echo "created cross-platform binaries in $DIST_DIR"
    ;;
  *)
    echo "usage: $0 [host|all]" >&2
    exit 64
    ;;
esac

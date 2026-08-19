#!/bin/bash
# Stage the Jingshan GEO Session Sidecar runtime for the current Unix host.

set -euo pipefail

NODE_VERSION="24.14.0"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESOURCE_DIR="$PROJECT_DIR/src-tauri/resources/nodejs"
CACHE_DIR="$PROJECT_DIR/src-tauri/resources/nodejs-cache"

if [ "${1:-}" = "--clean" ]; then
  rm -rf "$RESOURCE_DIR" "$CACHE_DIR"
  mkdir -p "$RESOURCE_DIR"
  touch "$RESOURCE_DIR/.gitkeep"
  exit 0
fi

platform="$(uname -s)"
machine="$(uname -m)"
case "$platform" in
  Darwin) archive_platform="darwin" ;;
  Linux) archive_platform="linux" ;;
  *)
    echo "当前脚本只负责 macOS/Linux 运行时；Windows x64 构建将在独立票据中配置。" >&2
    exit 1
    ;;
esac
case "$machine" in
  arm64|aarch64) archive_arch="arm64" ;;
  x86_64) archive_arch="x64" ;;
  *)
    echo "不支持的架构：$machine" >&2
    exit 1
    ;;
esac

cache_key="node-v${NODE_VERSION}-${archive_platform}-${archive_arch}"
cache_node="$CACHE_DIR/$cache_key/node"
if [ ! -x "$cache_node" ]; then
  work_dir="$(mktemp -d)"
  trap 'rm -rf "$work_dir"' EXIT
  archive="$cache_key.tar.xz"
  curl --fail --silent --show-error --location \
    "https://nodejs.org/dist/v${NODE_VERSION}/$archive" \
    --output "$work_dir/$archive"
  tar -xf "$work_dir/$archive" -C "$work_dir"
  mkdir -p "$(dirname "$cache_node")"
  cp "$work_dir/$cache_key/bin/node" "$cache_node"
  chmod +x "$cache_node"
fi

rm -rf "$RESOURCE_DIR"
mkdir -p "$RESOURCE_DIR/bin"
cp "$cache_node" "$RESOURCE_DIR/bin/node"
printf '%s\n' "$NODE_VERSION" > "$RESOURCE_DIR/.xiaojing-nodejs-version"
printf '%s\n' "$archive_platform" > "$RESOURCE_DIR/.xiaojing-nodejs-platform"
printf '%s\n' "$archive_arch" > "$RESOURCE_DIR/.xiaojing-nodejs-arch"

"$RESOURCE_DIR/bin/node" --version

#!/bin/bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

for command_name in node npm rustc cargo rustup; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "缺少开发依赖: $command_name" >&2
    exit 1
  fi
done

"$PROJECT_DIR/scripts/ensure_rust_toolchain.sh"
npm install
"$PROJECT_DIR/scripts/download_nodejs.sh"

if [ "$(uname -s)" = "Darwin" ]; then
  "$PROJECT_DIR/scripts/ensure_claude_sdk_package.sh"
fi

cargo check --manifest-path "$PROJECT_DIR/src-tauri/Cargo.toml"
echo "小鲸同学开发环境已就绪；运行 npm run tauri:dev 启动应用。"

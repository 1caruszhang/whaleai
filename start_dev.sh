#!/bin/bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_PATH="${1:-$PROJECT_DIR}"
SERVER_PORT=3000
NODE_BIN="$PROJECT_DIR/src-tauri/resources/nodejs/bin/node"

if [ ! -x "$NODE_BIN" ]; then
  echo "找不到 Xiaojing 内置 Node.js；请先运行 scripts/download_nodejs.sh" >&2
  exit 1
fi

cleanup() {
  kill "${SERVER_PID:-}" "${WEB_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

cd "$PROJECT_DIR"
"$NODE_BIN" --import tsx/esm --watch src/server/index.ts \
  --workspace-dir "$WORKSPACE_PATH" --port "$SERVER_PORT" &
SERVER_PID=$!
npm run dev:web &
WEB_PID=$!

wait "$SERVER_PID" "$WEB_PID"

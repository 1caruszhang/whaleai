# Local Build Troubleshooting

Ticket 21 leaves only the minimum Tauri build foundation. This guide covers current-host local verification；Windows x64 内测资源、NSIS 与签名门槛见 [`windows_x64_internal_beta.md`](windows_x64_internal_beta.md)。

## Prerequisites

- npm version from `packageManager` and Node satisfying `engines`.
- Rust toolchain pinned by `rust-toolchain.toml`.
- Current-host bundled Node plus fixed SDK/sharp resources under `src-tauri/resources/`.

Prepare the current Unix host Node resource with:

```bash
./scripts/download_nodejs.sh
```

The script does not prepare Windows resources.

## Deterministic build order

```bash
npm ci
npm run typecheck
npm run build:web
npm run build:server
cargo check --manifest-path src-tauri/Cargo.toml
npm run tauri:build -- --debug --no-bundle
```

Tauri also runs web and server builds through `beforeBuildCommand`. It never reads repository `.env`; Provider credentials are runtime-only.

## Common failures

- Missing `server-dist.js`: run `npm run build:server` and confirm the file is generated under `src-tauri/resources/`.
- Bundled Node not found: rerun `scripts/download_nodejs.sh` for the current host; do not install or probe system Node as a fallback.
- SDK/sharp resource missing: use the existing resource preparation scripts for the current target and verify package versions match `package.json`.
- Rust resource lookup fails during `--no-bundle`: create only the documented current-host placeholders or real prepared resources; do not restore deleted product bundles.
- Windows-specific build unavailable on macOS: run the static Windows contract, then stop before resource staging、NSIS 构建与实机安装；不要把本机 no-bundle 或交叉编译结果当成 Windows 验收。

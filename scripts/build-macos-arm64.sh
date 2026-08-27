#!/usr/bin/env bash
# build-macos-arm64.sh — build the 鲸杉geo macOS arm64 DMG candidate.
#
# Mirrors scripts/build-windows-x64.ps1: host admission, signing-material
# hygiene, hash-verified resource preparation, static gates, then a pinned
# Tauri build. Output lands in artifacts/macos-arm64/<mode>/ with a
# candidate.json recording the SHA-256. The script never uploads or publishes.
#
# Usage:
#   scripts/build-macos-arm64.sh [internal-unsigned] [--offline-resources]
#
# Only internal-unsigned exists today. Production signed+notarized output
# requires an Apple Developer ID admission step that is not yet registered.
set -euo pipefail

TARGET_TRIPLE="aarch64-apple-darwin"
MODE="internal-unsigned"
OFFLINE_RESOURCES=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        internal-unsigned|production-signed) MODE="$1"; shift ;;
        --offline-resources) OFFLINE_RESOURCES=1; shift ;;
        *) echo "Unknown argument: $1" >&2; exit 2 ;;
    esac
done

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_ROOT="$PROJECT_DIR/src-tauri/target/$TARGET_TRIPLE"
BUNDLE_ROOT="$TARGET_ROOT/release/bundle/dmg"
APP_ROOT="$TARGET_ROOT/release/bundle/macos"
MAIN_EXECUTABLE="$TARGET_ROOT/release/xiaojing"
ARTIFACT_ROOT="$PROJECT_DIR/artifacts/macos-arm64/$MODE"
MANIFEST_PATH="$PROJECT_DIR/scripts/macos-arm64-resources.json"

die() { echo "build-macos-arm64: $*" >&2; exit 1; }

# --- Host admission ---
[[ "$(uname -s)" == "Darwin" ]] || die "macOS packaging can run only on macOS."
[[ "$(uname -m)" == "arm64" ]] || die "macOS packaging requires a native Apple Silicon host."
for cmd in node npm cargo rustc rustup curl tar shasum file lipo hdiutil; do
    command -v "$cmd" >/dev/null 2>&1 || die "Required build command is missing: $cmd"
done
rustup target list --installed | grep -qx "$TARGET_TRIPLE" \
    || die "Rust target $TARGET_TRIPLE is not installed. Run: rustup target add $TARGET_TRIPLE"

# --- Signing admission / hygiene ---
if [[ "$MODE" == "production-signed" ]]; then
    die "production-signed macOS builds are not admitted yet: no Developer ID certificate, notarization credentials, or staple verification step is registered."
fi
# 按前缀整族拒绝（指南：任何 APPLE_* / TAURI_SIGNING_* 存在即拒绝）——
# 枚举名单会让未登记的新签名变量绕过门禁。
signing_material="$(env | awk -F= '/^(APPLE_|TAURI_SIGNING_)/ {print $1}' | sort -u)"
if [[ -n "$signing_material" ]]; then
    die "Signing material (${signing_material//$'\n'/ }) is present during an internal unsigned build. Refusing ambiguous output."
fi

cd "$PROJECT_DIR"

# --- Hash-verified resource preparation ---
prepare_args=()
[[ "$OFFLINE_RESOURCES" -eq 1 ]] && prepare_args+=(--offline)
bash scripts/prepare-macos-arm64.sh "${prepare_args[@]}"

# --- Static gates (same non-Windows-specific gates as the Windows build) ---
npm run typecheck
npm run lint

# --- Tauri build ---
build_started="$(date -u +%s)"
npm run tauri:build -- \
    --ci \
    --target "$TARGET_TRIPLE" \
    --bundles dmg \
    --no-sign

[[ -f "$MAIN_EXECUTABLE" ]] || die "Tauri did not produce the xiaojing binary for $TARGET_TRIPLE."

# --- Bundle inspection gates ---
lipo_info="$(lipo -info "$MAIN_EXECUTABLE")"
[[ "$lipo_info" == *arm64* && "$lipo_info" != *x86_64* ]] \
    || die "Main executable is not a single-arch arm64 Mach-O: $lipo_info"

app_bundle="$APP_ROOT/鲸杉geo.app"
[[ -d "$app_bundle" ]] || die "Tauri did not produce the expected .app bundle at $app_bundle."
for required in nodejs/bin/node claude-agent-sdk/claude sharp-runtime/node_modules server-dist.js; do
    [[ -e "$app_bundle/Contents/Resources/$required" ]] \
        || die "Packaged .app is missing Contents/Resources/$required."
done
[[ -x "$app_bundle/Contents/Resources/nodejs/bin/node" ]] \
    || die "Bundled node lost its executable bit inside the .app."
[[ -x "$app_bundle/Contents/Resources/claude-agent-sdk/claude" ]] \
    || die "Bundled claude lost its executable bit inside the .app."

installers=()
for dmg in "$BUNDLE_ROOT"/*.dmg; do
    [[ -f "$dmg" ]] && installers+=("$dmg")
done
[[ "${#installers[@]}" -eq 1 ]] || die "Expected exactly one produced DMG, found ${#installers[@]}."
installer="${installers[0]}"
[[ -f "$installer" ]] || die "DMG candidate vanished: $installer"
# Guard against stale output: the DMG must not predate this build by more than a minute.
dmg_mtime="$(stat -f %m "$installer")"
[[ "$dmg_mtime" -ge $((build_started - 60)) ]] || die "The only DMG in the bundle root predates this build; refusing to package stale output."

# Internal candidates must not carry a Developer ID signature.
if codesign -dv "$app_bundle" 2>&1 | grep -q "Signature=adhoc"; then
    : # ad-hoc signature is the expected unsigned-local state
elif codesign -dv "$app_bundle" >/dev/null 2>&1; then
    die "Internal candidate unexpectedly carries a non-adhoc code signature."
fi

# --- Candidate output ---
mkdir -p "$ARTIFACT_ROOT"
version="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).version)')"
label="INTERNAL-UNSIGNED"
candidate_name="JingshanGEO_${version}_arm64_${label}.dmg"
candidate_path="$ARTIFACT_ROOT/$candidate_name"
cp "$installer" "$candidate_path"

candidate_sha="$(shasum -a 256 "$candidate_path" | awk '{print $1}')"
product_name="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync("src-tauri/tauri.conf.json", "utf8")).productName)')"
CANDIDATE_PATH="$candidate_name" CANDIDATE_SHA="$candidate_sha" PRODUCT_NAME="$product_name" MODE="$MODE" node <<'EOF'
const fs = require("node:fs");
const path = require("node:path");
const record = {
    schemaVersion: 1,
    productName: process.env.PRODUCT_NAME,
    identifier: "com.xiaojing.geo",
    targetTriple: "aarch64-apple-darwin",
    mode: process.env.MODE,
    file: process.env.CANDIDATE_PATH,
    sha256: process.env.CANDIDATE_SHA,
    macosInstallValidation: "pending-on-macos-arm64",
    uploaded: false,
    published: false,
};
fs.writeFileSync(
    path.join(process.cwd(), "artifacts", "macos-arm64", process.env.MODE, "candidate.json"),
    JSON.stringify(record, null, 2),
);
EOF

echo "macOS arm64 candidate created: $candidate_path"
echo "macOS installation, upgrade, uninstall and Gatekeeper observation remain pending on a real Apple Silicon Mac."

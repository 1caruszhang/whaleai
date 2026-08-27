#!/usr/bin/env bash
# prepare-macos-arm64.sh — stage hash-verified macOS arm64 runtime resources
# for the packaged 鲸杉geo Session Sidecar.
#
# Mirrors scripts/prepare-windows-x64.ps1: every input comes from
# scripts/macos-arm64-resources.json, is digest-checked before use, and the
# staged tree is inventoried into src-tauri/resources/macos-arm64-staging.json
# (a local build product, not committed).
#
# Usage:
#   scripts/prepare-macos-arm64.sh [--offline] [--cache-dir <path>]
set -euo pipefail

TARGET_TRIPLE="aarch64-apple-darwin"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESOURCES_DIR="$PROJECT_DIR/src-tauri/resources"
MANIFEST_PATH="$PROJECT_DIR/scripts/macos-arm64-resources.json"
STAGING_RECORD_PATH="$RESOURCES_DIR/macos-arm64-staging.json"
CACHE_DIR="$PROJECT_DIR/.macos-arm64-cache"
OFFLINE=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --offline) OFFLINE=1; shift ;;
        --cache-dir) CACHE_DIR="$2"; shift 2 ;;
        *) echo "Unknown argument: $1" >&2; exit 2 ;;
    esac
done

die() { echo "prepare-macos-arm64: $*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || die "macOS arm64 resource preparation can run only on macOS."
[[ "$(uname -m)" == "arm64" ]] || die "macOS arm64 resource preparation requires a native Apple Silicon host."
[[ -f "$MANIFEST_PATH" ]] || die "macOS arm64 resource manifest is missing."
for cmd in curl tar shasum openssl file plutil; do
    command -v "$cmd" >/dev/null 2>&1 || die "Required command is missing: $cmd"
done

json_get() { # json_get <file> <dotted.path>
    node -e '
        const [file, path] = process.argv.slice(1);
        let value = JSON.parse(require("node:fs").readFileSync(file, "utf8"));
        for (const key of path.split(".")) {
            if (value == null || typeof value !== "object" || !(key in value)) process.exit(1);
            value = value[key];
        }
        process.stdout.write(String(value));
    ' "$1" "$2"
}

command -v node >/dev/null 2>&1 || die "Node.js is required on PATH to read the manifest."

[[ "$(json_get "$MANIFEST_PATH" targetTriple)" == "$TARGET_TRIPLE" ]] || die "Manifest target mismatch."
[[ "$(json_get "$MANIFEST_PATH" architecture)" == "arm64" ]] || die "Manifest architecture mismatch."

sha256_of() { shasum -a 256 "$1" | awk '{print $1}'; }

sri_of() { # sha512-<base64>
    printf 'sha512-%s' "$(openssl dgst -sha512 -binary "$1" | openssl base64 -A)"
}

# verified_download <json-prefix> <label> <hash-kind sha256|sri>
# Prints the cache path of a verified file.
verified_download() {
    local prefix="$1" label="$2" kind="$3"
    local url cache_file expected destination partial actual
    url="$(json_get "$MANIFEST_PATH" "$prefix.url")"
    cache_file="$(json_get "$MANIFEST_PATH" "$prefix.cacheFile")"
    [[ "$url" == https://* ]] || die "$label source must use HTTPS."
    mkdir -p "$CACHE_DIR"
    destination="$CACHE_DIR/$cache_file"

    if [[ ! -f "$destination" ]]; then
        [[ "$OFFLINE" -eq 0 ]] || die "$label is absent from the verified offline cache."
        partial="$destination.partial-$(uuidgen)"
        curl -fsSL --max-time 300 --retry 2 -o "$partial" "$url" || { rm -f "$partial"; die "Download failed for $label."; }
        mv "$partial" "$destination"
    fi

    case "$kind" in
        sha256)
            expected="$(json_get "$MANIFEST_PATH" "$prefix.sha256")"
            actual="$(sha256_of "$destination")"
            ;;
        sri)
            expected="$(json_get "$MANIFEST_PATH" "$prefix.integrity")"
            [[ "$expected" == sha512-* ]] || die "$label must use a SHA-512 integrity value."
            actual="$(sri_of "$destination")"
            ;;
    esac
    [[ "$actual" == "$expected" ]] || die "$label digest mismatch. Refusing to use the file."
    printf '%s' "$destination"
}

reset_staging() { # reset_staging <name>
    case "$1" in
        nodejs|claude-agent-sdk|sharp-runtime) ;;
        *) die "Refusing to reset an unregistered staging directory: $1" ;;
    esac
    rm -rf "${RESOURCES_DIR:?}/$1"
    mkdir -p "$RESOURCES_DIR/$1"
}

# expand_npm_package <json-prefix> — prints extracted package root.
expand_npm_package() {
    local prefix="$1" name version archive extract_root package_root actual_name actual_version
    name="$(json_get "$MANIFEST_PATH" "$prefix.name")"
    version="$(json_get "$MANIFEST_PATH" "$prefix.version")"
    archive="$(verified_download "$prefix" "$name" sri)"
    extract_root="$TMP_ROOT/$(uuidgen)"
    mkdir -p "$extract_root"
    tar -xzf "$archive" -C "$extract_root" || die "Verified npm archive extraction failed for $name."
    package_root="$extract_root/package"
    [[ -f "$package_root/package.json" ]] || die "Extracted npm archive is missing package.json for $name."
    actual_name="$(json_get "$package_root/package.json" name)"
    actual_version="$(json_get "$package_root/package.json" version)"
    [[ "$actual_name" == "$name" && "$actual_version" == "$version" ]] \
        || die "Extracted npm package identity mismatch for $name."
    printf '%s' "$package_root"
}

copy_contents() { # copy_contents <src> <dst>
    mkdir -p "$2"
    # dotglob semantics: copy hidden entries too, never the directory itself.
    tar -cf - -C "$1" . | tar -xf - -C "$2"
}

# Strip licenses/readmes and package metadata that cannot affect runtime,
# matching the Windows staging contract.
remove_non_runtime_material() {
    local root="$1"
    find "$root" -type f \( -iname '*.md' -o -iname 'LICENSE*' -o -iname 'LICENCE*' \
        -o -iname 'COPYING*' -o -iname 'NOTICE*' -o -iname 'AUTHORS*' \
        -o -iname 'CHANGELOG*' \) -delete
    find "$root" -type f -name 'package.json' -print0 | while IFS= read -r -d '' pkg; do
        node -e '
            const fs = require("node:fs");
            const file = process.argv[1];
            const data = JSON.parse(fs.readFileSync(file, "utf8"));
            for (const key of ["license", "author", "contributors", "funding", "homepage", "repository", "bugs"]) {
                delete data[key];
            }
            fs.writeFileSync(file, JSON.stringify(data));
        ' "$pkg"
    done
}

assert_macho_arm64() { # assert_macho_arm64 <path> <label>
    local info
    info="$(file -b "$1")"
    case "$info" in
        *"Mach-O 64-bit executable arm64"*) ;;
        *) die "$label is not an arm64 Mach-O executable: $info" ;;
    esac
}

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/xiaojing-macos-arm64.XXXXXXXX")"
cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

reset_staging nodejs
reset_staging claude-agent-sdk
reset_staging sharp-runtime

# --- Node.js darwin-arm64 (only bin/node is staged; it is self-contained) ---
node_archive="$(verified_download downloads.node "Node.js darwin-arm64" sha256)"
mkdir -p "$TMP_ROOT/node"
tar -xzf "$node_archive" -C "$TMP_ROOT/node"
node_version="$(json_get "$MANIFEST_PATH" downloads.node.version)"
node_binary="$TMP_ROOT/node/node-v$node_version-darwin-arm64/bin/node"
[[ -f "$node_binary" ]] || die "Node.js archive did not produce bin/node."
assert_macho_arm64 "$node_binary" "Node.js"
mkdir -p "$RESOURCES_DIR/nodejs/bin"
cp "$node_binary" "$RESOURCES_DIR/nodejs/bin/node"
chmod 755 "$RESOURCES_DIR/nodejs/bin/node"

# --- Claude Agent SDK darwin-arm64 native executable ---
claude_package="$(expand_npm_package npmPackages.claudeNative)"
claude_binary="$claude_package/claude"
[[ -f "$claude_binary" ]] || die "Claude Agent SDK package is missing its claude executable."
expected_claude_sha="$(json_get "$MANIFEST_PATH" npmPackages.claudeNative.binarySha256)"
[[ "$(sha256_of "$claude_binary")" == "$expected_claude_sha" ]] \
    || die "Claude Agent SDK darwin-arm64 executable SHA-256 mismatch."
assert_macho_arm64 "$claude_binary" "Claude Agent SDK executable"
cp "$claude_binary" "$RESOURCES_DIR/claude-agent-sdk/claude"
chmod 755 "$RESOURCES_DIR/claude-agent-sdk/claude"

# --- sharp runtime: pure-JS packages plus darwin-arm64 native modules ---
for key in sharp sharpNative sharpLibvips colour detectLibc semver; do
    package_root="$(expand_npm_package "npmPackages.$key")"
    stage_path="$(json_get "$MANIFEST_PATH" "npmPackages.$key.stagePath")"
    copy_contents "$package_root" "$RESOURCES_DIR/$stage_path"
done
remove_non_runtime_material "$RESOURCES_DIR/sharp-runtime"

# --- Required-path and Mach-O admission checks ---
required_count="$(json_get "$MANIFEST_PATH" requiredStagedPaths.length)"
for ((i = 0; i < required_count; i++)); do
    required="$(json_get "$MANIFEST_PATH" "requiredStagedPaths.$i")"
    [[ -e "$RESOURCES_DIR/$required" ]] || die "Required macOS arm64 resource is missing after staging: $required"
done
macho_count="$(json_get "$MANIFEST_PATH" requiredMachOArm64Paths.length)"
for ((i = 0; i < macho_count; i++)); do
    required="$(json_get "$MANIFEST_PATH" "requiredMachOArm64Paths.$i")"
    assert_macho_arm64 "$RESOURCES_DIR/$required" "$required"
    [[ -x "$RESOURCES_DIR/$required" ]] || die "$required lost its executable bit during staging."
done

# --- Staging inventory (local build product; not committed) ---
node - "$STAGING_RECORD_PATH" "$RESOURCES_DIR" "$MANIFEST_PATH" "$TARGET_TRIPLE" <<'EOF'
// argv for `node - args...` is [execPath, "-", ...args].
const [recordPath, resourcesDir, manifestPath, targetTriple] = process.argv.slice(2);
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const files = [];
const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) {
            const body = fs.readFileSync(full);
            files.push({
                path: path.relative(resourcesDir, full).split(path.sep).join("/"),
                size: body.length,
                sha256: crypto.createHash("sha256").update(body).digest("hex"),
            });
        }
    }
};
for (const dir of ["nodejs", "claude-agent-sdk", "sharp-runtime"]) {
    walk(path.join(resourcesDir, dir));
}
const sources = {};
for (const [key, spec] of Object.entries(manifest.downloads)) {
    sources[key] = { sha256: spec.sha256 };
}
const npmPackages = {};
for (const [key, spec] of Object.entries(manifest.npmPackages)) {
    npmPackages[key] = { version: spec.version, integrity: spec.integrity };
}
const record = {
    schemaVersion: 1,
    targetTriple,
    generatedAt: new Date().toISOString(),
    sources,
    npmPackages,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
};
fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
EOF

echo "macOS arm64 resources are prepared and hash-verified."

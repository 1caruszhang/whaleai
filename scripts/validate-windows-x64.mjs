#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, '..');
const TARGET = 'x86_64-pc-windows-msvc';
const PE_X64 = 0x8664;
const STAGED_DIRECTORIES = [
  'nodejs',
  'claude-agent-sdk',
  'sharp-runtime',
  'portable-git',
  'windows-prerequisites',
];
const STAGING_RECORD = 'windows-x64-staging.json';
const DOWNGRADE_KEY = ['allow', 'Downgrades'].join('');
const GENERATED_UPDATE_KEY = ['create', 'Updater', 'Artifacts'].join('');
const SECRET_CONFIG_KEYS = new Set([
  ['certificate', 'Thumbprint'].join(''),
  ['timestamp', 'Url'].join(''),
  ['pub', 'key'].join(''),
  'endpoints',
]);
const LEGAL_NAME_PARTS = [
  ['licen', 'se'].join(''),
  ['licen', 'ce'].join(''),
  ['copy', 'ing'].join(''),
  ['not', 'ice'].join(''),
  ['attri', 'bution'].join(''),
  'authors',
];
const NON_RUNTIME_NAME_PARTS = [
  ...LEGAL_NAME_PARTS,
  'readme',
  'changelog',
  ['release', 'notes'].join(''),
];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function text(path) {
  return readFileSync(path, 'utf8');
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function equalJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function addIf(failures, condition, message) {
  if (!condition) failures.push(message);
}

function findForbiddenKeys(value, path = '$', found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findForbiddenKeys(item, `${path}[${index}]`, found));
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  for (const [key, child] of Object.entries(value)) {
    if (key === GENERATED_UPDATE_KEY || SECRET_CONFIG_KEYS.has(key)) {
      found.push(`${path}.${key}`);
    }
    findForbiddenKeys(child, `${path}.${key}`, found);
  }
  return found;
}

function cspDirective(csp, name) {
  return csp
    .split(';')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${name} `)) ?? '';
}

export function readPeMachine(buffer) {
  if (buffer.length < 64 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) return null;
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset < 64 || peOffset + 24 > buffer.length) return null;
  if (buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') return null;
  return buffer.readUInt16LE(peOffset + 4);
}

export function hasDestructiveXiaojingDataOperation(hookText) {
  const lines = hookText.split(/\r?\n/).map((line) => line.replace(/;.*/, '').trim());
  return lines.some((line) => (
    /(?:rmdir|delete)/i.test(line)
    && /\$localappdata[\\/]xiaojing/i.test(line)
  ));
}

export function validateIdentityContract(manifest, packageJson, cargoText, tauri) {
  const failures = [];
  const expected = {
    package: 'xiaojing',
    crate: 'xiaojing',
    binary: 'xiaojing.exe',
    productName: '小鲸同学',
    identifier: 'com.xiaojing.geo',
    protocol: 'xiaojing',
    dataRoot: '%LOCALAPPDATA%\\Xiaojing',
  };
  addIf(failures, equalJson(manifest.identity, expected), 'resource manifest identity drifted');
  addIf(failures, packageJson.name === expected.package, 'package name must be xiaojing');
  addIf(failures, tauri.productName === expected.productName, 'Tauri productName drifted');
  addIf(failures, tauri.identifier === expected.identifier, 'Tauri identifier drifted');
  addIf(failures, new RegExp('^name = "xiaojing"$', 'm').test(cargoText), 'crate name must be xiaojing');
  return failures;
}

export function collectStaticFailures(root = DEFAULT_ROOT) {
  const failures = [];
  const manifest = readJson(join(root, 'scripts/windows-x64-resources.json'));
  const packageJson = readJson(join(root, 'package.json'));
  const packageLock = readJson(join(root, 'package-lock.json'));
  const tauri = readJson(join(root, 'src-tauri/tauri.conf.json'));
  const windows = readJson(join(root, 'src-tauri/tauri.windows.conf.json'));
  const signing = readJson(join(root, 'src-tauri/tauri.windows.signing.conf.json'));
  const cargo = text(join(root, 'src-tauri/Cargo.toml'));
  const hook = text(join(root, 'src-tauri/nsis/windows-x64-hooks.nsh'));
  const appDirs = text(join(root, 'src-tauri/src/app_dirs.rs'));
  const sessionLifecycle = text(join(root, 'src-tauri/src/sidecar/session_lifecycle.rs'));
  const processCommand = text(join(root, 'src-tauri/src/process_cmd.rs'));
  const proxy = text(join(root, 'src-tauri/src/proxy_config.rs'));
  const schema = text(join(root, 'node_modules/@tauri-apps/cli/config.schema.json'));
  const guide = text(join(root, 'specs/guides/windows_x64_internal_beta.md'));

  failures.push(...validateIdentityContract(manifest, packageJson, cargo, tauri));
  addIf(failures, manifest.schemaVersion === 1, 'resource manifest schema must be 1');
  addIf(failures, manifest.targetTriple === TARGET, 'resource manifest target must be Windows x64 MSVC');
  addIf(failures, manifest.architecture === 'x64', 'resource manifest architecture must be x64');
  addIf(failures, equalJson(manifest.toolchain, {
    tauriCli: '2.11.4',
    tauriRust: '2.11.2',
    nsisTemplateTag: 'tauri-v2.11.4',
  }), 'audited Tauri toolchain versions drifted');
  addIf(failures, packageLock.packages?.['node_modules/@tauri-apps/cli']?.version === manifest.toolchain.tauriCli, 'installed Tauri CLI version drifted');
  addIf(failures, cargo.includes(`tauri = { version = "${manifest.toolchain.tauriRust}"`), 'Tauri Rust version drifted');
  addIf(
    failures,
    equalJson(manifest.sessionSidecar, {
      kind: 'bundled-node-resource',
      entrypoint: 'server-dist.js',
      nodeExecutable: 'nodejs/node.exe',
      tauriExternalBin: [],
      targetTripleSuffix: null,
    }),
    'Session Sidecar must remain the Node resource layout without a Tauri external-binary suffix',
  );

  const expectedBaseResources = {
    '../src-tauri/resources/server-dist.js': 'server-dist.js',
    '../src-tauri/resources/claude-agent-sdk': 'claude-agent-sdk',
    '../src-tauri/resources/sharp-runtime': 'sharp-runtime',
    '../src-tauri/resources/nodejs': 'nodejs',
    '../src/shared': 'shared',
  };
  const expectedWindowsResources = {
    '../src-tauri/resources/portable-git': 'portable-git',
  };
  addIf(failures, equalJson(tauri.bundle?.resources, expectedBaseResources), 'base Tauri resources are not the minimal product set');
  addIf(failures, equalJson(windows.bundle?.resources, expectedWindowsResources), 'Windows Tauri resources are not the minimal x64 additions');
  addIf(failures, equalJson(windows.bundle?.targets, ['nsis']), 'Windows bundle target must be NSIS only');
  addIf(failures, tauri.bundle?.active === true, 'Tauri bundling must stay active');
  addIf(failures, tauri.mainBinaryName === undefined, 'main binary must inherit the xiaojing crate name');
  addIf(failures, windows.bundle?.useLocalToolsDir === true, 'Windows bundler tools must stay project-local');
  addIf(failures, windows.bundle?.windows?.[DOWNGRADE_KEY] === false, 'older-version overwrite must be rejected');
  addIf(failures, windows.bundle?.windows?.webviewInstallMode?.type === 'skip', 'Tauri mutable WebView2 download mode must stay disabled');

  const nsis = windows.bundle?.windows?.nsis ?? {};
  addIf(failures, nsis.installMode === 'currentUser', 'NSIS install mode must be currentUser');
  addIf(failures, nsis.installerHooks === 'nsis/windows-x64-hooks.nsh', 'NSIS must use the audited x64 hook');
  addIf(failures, equalJson(nsis.languages, ['SimpChinese', 'English']), 'NSIS language set drifted');
  addIf(failures, nsis.installerIcon === 'icons/icon.ico' && nsis.uninstallerIcon === 'icons/icon.ico', 'NSIS must use the current icon');
  addIf(failures, /MicrosoftEdgeWebview2Setup\.exe/.test(hook), 'NSIS hook must use the staged WebView2 bootstrapper');
  addIf(failures, hook.includes('NSIS_HOOK_PREINSTALL') && hook.includes('${__FILEDIR__}'), 'WebView2 must be embedded and admitted before program files are replaced');
  addIf(failures, /WEBVIEW2APPGUID/.test(hook), 'NSIS hook must detect WebView2 before installing it');
  addIf(failures, hook.includes('%LOCALAPPDATA%\\Xiaojing'), 'NSIS hook must document the preserved Xiaojing data root');
  addIf(failures, !hasDestructiveXiaojingDataOperation(hook), 'NSIS hook must never delete the Xiaojing data root');
  addIf(failures, !/RequestExecutionLevel\s+admin/i.test(hook), 'NSIS hook must not request elevation');

  const forbiddenConfigKeys = [
    ...findForbiddenKeys(tauri),
    ...findForbiddenKeys(windows),
  ];
  addIf(failures, forbiddenConfigKeys.length === 0, `shipping config contains retired update/signing keys: ${forbiddenConfigKeys.join(', ')}`);
  addIf(failures, Boolean(signing.bundle?.windows?.signCommand), 'production signing overlay must use a command wrapper');
  addIf(failures, findForbiddenKeys(signing).length === 0, 'signing overlay must not contain certificate or timestamp material');
  addIf(failures, JSON.stringify(signing).includes('%1'), 'signing wrapper must receive the exact Tauri artifact path');

  const csp = tauri.app?.security?.csp ?? '';
  const connect = cspDirective(csp, 'connect-src');
  addIf(failures, connect.includes('http://localhost:*') && connect.includes('http://127.0.0.1:*'), 'CSP must retain local HTTP control-plane access');
  addIf(failures, connect.includes('ws://localhost:*') && connect.includes('ws://127.0.0.1:*'), 'CSP must retain local SSE/WebSocket access');
  addIf(failures, !/https?:\/\/\*/.test(connect) && !/connect-src[^;]*\shttps?:\s/.test(csp), 'CSP must not grant general network access to the renderer');
  addIf(failures, equalJson(tauri.app?.security?.assetProtocol?.scope, ['$LOCALDATA/Xiaojing/**']), 'asset scope must remain under Xiaojing local data');
  addIf(failures, appDirs.includes('root.join("Xiaojing")'), 'Rust data owner must use the Xiaojing local-data root');
  addIf(failures, sessionLifecycle.includes('proxy_config::apply_to_subprocess(&mut cmd)'), 'Session Sidecar must retain Rust proxy admission');
  addIf(failures, proxy.includes('localhost,localhost.localdomain,127.0.0.1,127.0.0.0/8,::1'), 'localhost no-proxy contract drifted');
  addIf(failures, processCommand.includes('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE') && processCommand.includes('AssignProcessToJobObject'), 'Windows process-tree containment contract drifted');

  addIf(failures, schema.includes('"installMode"') && schema.includes('"currentUser"'), 'installed Tauri schema does not expose current-user NSIS');
  addIf(failures, schema.includes('"installerHooks"') && schema.includes('"webviewInstallMode"'), 'installed Tauri schema does not expose required Windows fields');

  const directOptional = packageJson.optionalDependencies ?? {};
  addIf(failures, directOptional['@anthropic-ai/claude-agent-sdk-win32-x64'] === manifest.npmPackages.claudeNative.version, 'x64 Claude native package pin drifted');
  addIf(failures, directOptional['@img/sharp-win32-x64'] === manifest.npmPackages.sharpNative.version, 'x64 Sharp native package pin drifted');
  const directWindowsNonX64 = Object.keys(directOptional).filter((name) => /win32-(?:arm64|ia32)/.test(name));
  addIf(failures, directWindowsNonX64.length === 0, `direct non-x64 Windows packages are forbidden: ${directWindowsNonX64.join(', ')}`);

  for (const packageSpec of [manifest.npmPackages.claudeNative, manifest.npmPackages.sharpNative]) {
    const lockEntry = packageLock.packages?.[`node_modules/${packageSpec.name}`];
    addIf(failures, lockEntry?.version === packageSpec.version, `${packageSpec.name} lock version drifted`);
    addIf(failures, lockEntry?.integrity === packageSpec.integrity, `${packageSpec.name} lock integrity drifted`);
  }
  addIf(failures, packageLock.packages?.['node_modules/sharp']?.version === manifest.npmPackages.sharp.version, 'sharp lock version drifted');

  const downloadHosts = {
    node: 'nodejs.org',
    portableGit: 'github.com',
    webview2: 'go.microsoft.com',
  };
  for (const [name, spec] of Object.entries(manifest.downloads)) {
    const source = new URL(spec.url);
    addIf(failures, source.protocol === 'https:' && source.hostname === downloadHosts[name], `unapproved download source: ${name}`);
    addIf(failures, /^[a-f0-9]{64}$/.test(spec.sha256), `invalid SHA-256 pin: ${name}`);
    addIf(failures, typeof spec.cacheFile === 'string' && spec.cacheFile.length > 0, `cache filename missing: ${name}`);
  }
  for (const [name, spec] of Object.entries(manifest.npmPackages)) {
    const source = new URL(spec.url);
    addIf(failures, source.protocol === 'https:' && source.hostname === 'registry.npmjs.org', `unapproved npm source: ${name}`);
    addIf(failures, /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(spec.integrity), `invalid npm SHA-512 pin: ${name}`);
    addIf(failures, typeof spec.stagePath === 'string' && spec.stagePath.length > 0, `npm stage path missing: ${name}`);
  }
  addIf(failures, manifest.vcRuntime?.strategy === 'not-required-by-current-import-closure', 'VC runtime policy drifted');
  addIf(failures, manifest.vcRuntime?.auditedFallback?.bundled === false, 'global VC runtime installer must not be bundled');

  for (const [iconPath, expectedHash] of Object.entries(manifest.icons)) {
    addIf(failures, existsSync(join(root, iconPath)), `icon missing: ${iconPath}`);
    if (existsSync(join(root, iconPath))) {
      addIf(failures, hashFile(join(root, iconPath)) === expectedHash, `icon hash drifted: ${iconPath}`);
    }
  }

  const scriptPaths = [
    'scripts/prepare-windows-x64.ps1',
    'scripts/build-windows-x64.ps1',
    'scripts/sign-windows-x64.ps1',
  ];
  for (const scriptPath of scriptPaths) {
    const body = text(join(root, scriptPath));
    addIf(failures, !/(?:Get-Content|readFileSync).*\.env\b/i.test(body), `${scriptPath} must not read a local environment file`);
  }
  const prepareScript = text(join(root, 'scripts/prepare-windows-x64.ps1'));
  const buildScript = text(join(root, 'scripts/build-windows-x64.ps1'));
  const signScript = text(join(root, 'scripts/sign-windows-x64.ps1'));
  addIf(failures, prepareScript.includes(TARGET) && buildScript.includes(TARGET), 'Windows scripts must pin the MSVC x64 target');
  addIf(failures, !/(?:aarch64|arm64|i686|win32-ia32)/i.test(buildScript), 'Windows build script must not contain alternate architecture targets');
  addIf(failures, [prepareScript, buildScript, signScript].every((body) => body.includes('Set-StrictMode -Version Latest')), 'Windows scripts must enable strict mode');
  addIf(failures, !prepareScript.includes('[IO.Path]::GetRelativePath') && !buildScript.includes('[IO.Path]::GetRelativePath'), 'Windows scripts must remain compatible with Windows PowerShell 5.1 path APIs');
  addIf(failures, prepareScript.includes('-UseBasicParsing'), 'resource downloads must work without the legacy Internet Explorer engine');
  addIf(failures, prepareScript.includes('Assert-FileSha256') && prepareScript.includes('Assert-FileSri') && prepareScript.includes('Assert-PeX64'), 'resource preparation must verify hashes and PE architecture');
  addIf(failures, prepareScript.includes('Assert-AuthenticodeValid') && prepareScript.includes('windows-x64-staging.json'), 'resource preparation must verify upstream signatures and write an inventory');
  addIf(failures, buildScript.includes('internal-unsigned') && buildScript.includes('production-signed'), 'build modes must distinguish unsigned internal and signed production candidates');
  addIf(failures, /XIAOJING_WINDOWS_SIGN_PFX_PASSWORD\s*=\s*\$null/.test(buildScript), 'PFX password must not propagate to build subprocesses after CI admission');
  addIf(failures, buildScript.includes('dumpbin') && buildScript.includes('pending-on-windows-10-and-11-x64'), 'build must verify PE imports and leave real-machine validation pending');
  addIf(failures, signScript.includes('XIAOJING_WINDOWS_SIGN_CERT_SHA1') && signScript.includes('XIAOJING_WINDOWS_SIGN_TIMESTAMP_URL'), 'signing wrapper must admit identity and time service from environment only');
  addIf(failures, signScript.includes('TimeStamperCertificate') && signScript.includes('SignerCertificate.Thumbprint'), 'signing wrapper must verify signer identity and timestamp');
  addIf(failures, guide.includes('均未执行') && guide.includes('Windows 10 22H2 x64') && guide.includes('Windows 11 x64'), 'Windows real-machine matrix must remain explicitly pending');
  addIf(failures, guide.includes('Unknown publisher') && guide.includes('SmartScreen'), 'internal guide must set unsigned-candidate expectations');
  addIf(
    failures,
    guide.includes('商业化场景逐格矩阵') && guide.includes('C8 卸载后数据根完整保留') && guide.includes('artifacts/windows-x64/acceptance/'),
    'ticket-13 commercial acceptance matrix and evidence archive must stay documented',
  );
  addIf(failures, !existsSync(join(root, 'src-tauri/resources/vcruntime140.dll')) && !existsSync(join(root, 'src-tauri/resources/vcruntime140_1.dll')), 'stale VC runtime files must not be bundled');
  const stagingRecordExists = existsSync(join(root, 'src-tauri/resources', STAGING_RECORD));
  const partialWindowsStaging = ['portable-git', 'windows-prerequisites']
    .filter((directory) => existsSync(join(root, 'src-tauri/resources', directory)));
  addIf(
    failures,
    stagingRecordExists || partialWindowsStaging.length === 0,
    `Windows-only staging exists without its hash inventory: ${partialWindowsStaging.join(', ')}`,
  );

  return failures;
}

function walkFiles(root, relativeRoot, failures, output) {
  const absolute = join(root, relativeRoot);
  if (!existsSync(absolute)) return;
  for (const name of readdirSync(absolute).sort()) {
    const childRelative = join(relativeRoot, name).replace(/\\/g, '/');
    const child = join(root, childRelative);
    const stat = lstatSync(child);
    if (stat.isSymbolicLink()) {
      failures.push(`staging contains a symbolic link: ${childRelative}`);
      continue;
    }
    if (stat.isDirectory()) walkFiles(root, childRelative, failures, output);
    else if (stat.isFile()) output.push(childRelative);
    else failures.push(`staging contains an unsupported filesystem entry: ${childRelative}`);
  }
}

export function collectStagingFailures(root = DEFAULT_ROOT) {
  const failures = [];
  const manifest = readJson(join(root, 'scripts/windows-x64-resources.json'));
  const resources = join(root, 'src-tauri/resources');
  const recordPath = join(resources, STAGING_RECORD);
  if (!existsSync(recordPath)) return [`staging record missing: src-tauri/resources/${STAGING_RECORD}`];
  const record = readJson(recordPath);
  addIf(failures, record.schemaVersion === 1, 'staging record schema must be 1');
  addIf(failures, record.targetTriple === TARGET, 'staging record target drifted');
  for (const [name, spec] of Object.entries(manifest.downloads)) {
    addIf(failures, record.sources?.[name]?.sha256 === spec.sha256, `staging source hash drifted: ${name}`);
  }
  for (const [name, spec] of Object.entries(manifest.npmPackages)) {
    addIf(failures, record.npmPackages?.[name]?.version === spec.version, `staging npm version drifted: ${name}`);
    if (spec.integrity) addIf(failures, record.npmPackages?.[name]?.integrity === spec.integrity, `staging npm integrity drifted: ${name}`);
  }

  const actual = [];
  for (const directory of STAGED_DIRECTORIES) walkFiles(resources, directory, failures, actual);
  actual.sort();
  const inventory = Array.isArray(record.files) ? record.files : [];
  const recordedPaths = inventory.map((entry) => entry.path).sort();
  addIf(failures, equalJson(recordedPaths, actual), 'staging file inventory does not match the resource tree');

  const inventoryByPath = new Map(inventory.map((entry) => [entry.path, entry]));
  for (const relativePath of actual) {
    const absolute = join(resources, relativePath);
    const entry = inventoryByPath.get(relativePath);
    addIf(failures, entry?.sha256 === hashFile(absolute), `staged file hash mismatch: ${relativePath}`);
    addIf(failures, entry?.size === lstatSync(absolute).size, `staged file size mismatch: ${relativePath}`);
    const lowerParts = relativePath.split('/').map((part) => part.toLowerCase());
    addIf(failures, !lowerParts.some((pathPart) => NON_RUNTIME_NAME_PARTS.some((part) => pathPart.startsWith(part))), `staging contains forbidden non-runtime material: ${relativePath}`);
    // Git for Windows ships public CA trust bundles as *.pem; they are not secrets.
    const isPortableGitCaBundle = relativePath.startsWith('portable-git/') && /\.pem$/i.test(relativePath);
    addIf(failures, !/(?:^|\/)(?:\.env(?:\.|$)|[^/]+\.(?:pem|pfx|p12|key))$/i.test(relativePath) || isPortableGitCaBundle, `staging contains secret-shaped material: ${relativePath}`);
    if (/\.(?:exe|dll|node)$/i.test(relativePath)) {
      // Microsoft's evergreen WebView2 bootstrapper stub is a 32-bit PE that
      // installs the x64 runtime; it is admitted by hash pin and Authenticode.
      if (relativePath === 'windows-prerequisites/MicrosoftEdgeWebview2Setup.exe') continue;
      // PortableGit ships a few 32-bit helper binaries (for example
      // usr/libexec/getprocaddr32.exe). The archive is Authenticode-verified
      // before extraction, and its entry points in requiredPeX64Paths are
      // still x64-checked by the loop below.
      if (relativePath.startsWith('portable-git/') && !manifest.requiredPeX64Paths.includes(relativePath)) continue;
      const machine = readPeMachine(readFileSync(absolute));
      addIf(failures, machine === PE_X64, `staged PE is not x64: ${relativePath}`);
    }
  }

  for (const required of manifest.requiredStagedPaths) {
    addIf(failures, actual.includes(required), `required staged resource missing: ${required}`);
  }
  for (const required of manifest.requiredPeX64Paths) {
    if (!actual.includes(required)) continue;
    addIf(failures, readPeMachine(readFileSync(join(resources, required))) === PE_X64, `required PE machine mismatch: ${required}`);
  }
  if (actual.includes('claude-agent-sdk/claude.exe')) {
    addIf(
      failures,
      hashFile(join(resources, 'claude-agent-sdk/claude.exe')) === manifest.npmPackages.claudeNative.binarySha256,
      'Claude native executable hash drifted',
    );
  }
  if (actual.includes('windows-prerequisites/MicrosoftEdgeWebview2Setup.exe')) {
    addIf(
      failures,
      hashFile(join(resources, 'windows-prerequisites/MicrosoftEdgeWebview2Setup.exe')) === manifest.downloads.webview2.sha256,
      'WebView2 bootstrapper hash drifted',
    );
  }
  return failures;
}

export function runValidation({ root = DEFAULT_ROOT, staging = false } = {}) {
  const failures = collectStaticFailures(root);
  const stagingRecordExists = existsSync(join(root, 'src-tauri/resources', STAGING_RECORD));
  if (staging || stagingRecordExists) failures.push(...collectStagingFailures(root));
  return failures;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const unknown = process.argv.slice(2).filter((arg) => arg !== '--staging');
  if (unknown.length > 0) {
    console.error(`Unknown arguments: ${unknown.join(' ')}`);
    process.exit(2);
  }
  const failures = runValidation({ staging: process.argv.includes('--staging') });
  if (failures.length > 0) {
    console.error('Windows x64 contract validation failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  const validatedStaging = process.argv.includes('--staging')
    || existsSync(join(DEFAULT_ROOT, 'src-tauri/resources', STAGING_RECORD));
  console.log(`Windows x64 ${validatedStaging ? 'static and staging' : 'static'} contract verified.`);
}

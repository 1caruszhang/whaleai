#!/usr/bin/env node

import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';

const ROOT = process.cwd();
const merge = (...parts) => parts.join('');
const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phrase = (...parts) => merge(...parts);
const wordPattern = (...parts) => new RegExp(`\\b${escaped(phrase(...parts))}\\b`, 'gi');
const textPattern = (...parts) => new RegExp(escaped(phrase(...parts)), 'gi');

const excludedDirectoryNames = new Set([
  '.git',
  'node_modules',
  'target',
  'dist',
  'coverage',
  '.vite',
  '.turbo',
  'nodejs-cache',
]);
const excludedRelativeRoots = [
  '.scratch/',
  'specs/issues/',
  'src-tauri/resources/nodejs/',
  'src-tauri/resources/claude-agent-sdk/',
  'src-tauri/resources/sharp-runtime/',
  'src-tauri/resources/portable-git/',
  'src-tauri/resources/windows-prerequisites/',
];
const excludedGeneratedFiles = new Set([
  '.eslintcache',
  'src-tauri/resources/server-dist.js',
  'src-tauri/resources/server-dist.js.map',
]);
const textExtensions = new Set([
  '',
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.lock',
  '.md',
  '.mjs',
  '.plist',
  '.ps1',
  '.py',
  '.rs',
  '.sh',
  '.svg',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);
const extensionlessTextNames = new Set([
  '.env.example',
  '.gitignore',
  'AGENTS.md',
  'CLAUDE.md',
  'Dockerfile',
  'README.md',
]);

const oldBrand = phrase('my', 'agents');
const oldRepoName = phrase('whale', 'ai');
const oldAuthorOne = phrase('1carus', 'zhang');
const oldAuthorTwo = phrase('hAcK', 'lyc');

const forbiddenPathRules = [
  ['old product name in path', new RegExp(escaped(oldBrand), 'i')],
  ['old repository name in path', new RegExp(escaped(oldRepoName), 'i')],
  ['legal material in path', new RegExp(`(?:^|/)(?:licen[cs]e|copying|${merge('not', 'ice')}|${merge('attri', 'bution')})(?:\\.[^/]*)?(?:/|$)`, 'i')],
  ['removed command-line product tree', /(?:^|\/)src\/cli(?:\/|$)/i],
  ['removed integration process tree', new RegExp(`(?:^|/)plugin[-_]?${merge('brid', 'ge')}(?:/|$)`, 'i')],
  ['removed bundled product tree', /(?:^|\/)(?:bundled-agents|bundled-skills|mi(?:no))(?:\/|$)/i],
  ['removed renderer owner tree', /(?:^|\/)src\/renderer\/(?:analy(?:tics)|floating[-_]ball|pages\/space|assets\/(?:floating[-_]pets|runtime[-_]icons)|components\/(?:Agent[-_]?Settings|Im[-_]?Settings|agent[-_]status|cron|global[-_]sidebar|goal|laun(?:cher)|scheduled[-_]tasks|search|task[-_]center))(?:\/|$)/i],
  ['removed server owner tree', /(?:^|\/)src\/server\/(?:agents|builtin[-_]session|inbox|mcp[-_]oauth|migrations|official[-_]tools|openai[-_]bridge|plugins|runtimes|services|session[-_]core|session[-_]engine|skills)(?:\/|$)/i],
  ['removed scheduled-job facade', /(?:^|\/)managed[-_]?scheduled[-_]?job(?:\.[^/]*)?$/i],
  ['removed external runtime tree', new RegExp(`(?:^|/)runtimes/(?:managed[-_]?${merge('code', 'x')}|${merge('code', 'x')}|${merge('gem', 'ini')}|claude[-_]?code|${merge('gr', 'ok')})(?:/|$)`, 'i')],
  ['removed release automation', /(?:^|\/)(?:\.github\/workflows\/release\.(?:yml|yaml)|publish_(?:release|windows|managed)|rollback_release|build_(?:macos|windows|linux)|build_dev(?:_win)?|sync-version)(?:\.[^/]*)?$/i],
];

const forbiddenContentRules = [
  ['old product name', wordPattern('my', 'agents')],
  ['old product phrase', textPattern('my', ' agent')],
  ['old helper name', textPattern('MA ', '小助理')],
  ['old repository name', wordPattern('whale', 'ai')],
  ['old bundle identifier', textPattern('com.', 'my', 'agents', '.app')],
  ['old Rust crate identifier', wordPattern('app_', 'lib')],
  ['old address', textPattern('my', 'agents', '.io')],
  ['old source address', new RegExp(`${escaped(oldAuthorOne)}|${escaped(oldAuthorTwo)}`, 'gi')],
  ['old environment prefix', new RegExp(`${escaped(oldBrand)}[_-]`, 'gi')],
  ['old local directory', textPattern('.', 'my', 'agents')],
  ['retired local-data directory', new RegExp(`${escaped(phrase('.', 'xiao', 'jing'))}[\\\\/]`, 'gi')],
  ['legal marker', /\blicen[cs]e(?:s|d)?\b/gi],
  ['legal marker', wordPattern('not', 'ice')],
  ['legal marker', wordPattern('attri', 'bution')],
  ['removed integration process', textPattern('plugin ', 'bridge')],
  ['removed integration process', textPattern('plugin-', 'bridge')],
  ['removed integration process', wordPattern('open', 'claw')],
  ['removed messaging owner', wordPattern('tele', 'gram')],
  ['removed messaging owner', wordPattern('ding', 'talk')],
  ['removed messaging owner', wordPattern('fei', 'shu')],
  ['removed external runtime', textPattern('managed ', 'code', 'x')],
  ['removed external runtime', textPattern('managed-', 'code', 'x')],
  ['removed external runtime', textPattern('claude ', 'code')],
  ['removed external runtime', wordPattern('code', 'x')],
  ['removed external runtime', wordPattern('gem', 'ini')],
  ['removed external runtime', wordPattern('gr', 'ok')],
  ['removed runtime', wordPattern('b', 'un')],
  ['removed desktop surface', textPattern('floating ', 'ball')],
  ['removed desktop surface', textPattern('floating-', 'ball')],
  ['removed desktop surface', wordPattern('compa', 'nion')],
  ['removed global process', textPattern('global ', 'sidecar')],
  ['removed shell identifier', textPattern('global-', 'sidebar')],
  ['removed shell identifier', wordPattern('laun', 'cher')],
  ['removed task surface', textPattern('task ', 'center')],
  ['removed task surface', textPattern('task-', 'center')],
  ['removed task storage', textPattern('cron_', 'tasks.json')],
  ['removed runtime facade', textPattern('session-', 'engine')],
  ['removed runtime facade', textPattern('builtin-', 'session')],
  ['removed provider bridge', textPattern('openai-', 'bridge')],
  ['removed metrics owner', wordPattern('analy', 'tics')],
  ['removed desktop character', wordPattern('mi', 'no')],
  ['removed source entry', textPattern('src/', 'cli')],
  ['removed build entry', textPattern('build:', 'bridge')],
  ['removed build entry', textPattern('build:', 'cli')],
  ['removed resource entry', textPattern('plugin-', 'bridge-dist')],
  ['removed product identifier', new RegExp(`\\b(?:${[
    phrase('Space', 'Cloud'),
    phrase('Cloud', 'Space'),
    phrase('Space', 'Issue'),
    phrase('Session', 'Goal'),
    phrase('Thought', 'Card'),
    phrase('Cron', 'Task'),
    phrase('Task', 'Center'),
    phrase('Global', 'Sidebar'),
    phrase('Laun', 'cher'),
    phrase('Global', 'Search'),
    phrase('History', 'Search'),
    phrase('Global', 'Skills'),
    phrase('Global', 'Plugins'),
    phrase('Im', 'Settings'),
    phrase('Floating', 'Pet'),
    phrase('Agent', 'Settings'),
    phrase('Agent', 'Template'),
    phrase('Registered', 'Agent'),
    phrase('Runtime', 'Selector'),
    phrase('Runtime', 'Diagnostics'),
    phrase('External', 'Runtime'),
    phrase('Plugin', 'Bridge'),
    phrase('Browser', 'Panel'),
    phrase('Skill', 'Detail', 'Panel'),
    phrase('Command', 'Detail', 'Panel'),
    phrase('Global', 'Plugins', 'Panel'),
    phrase('Terminal', 'Panel'),
  ].join('|')})\\b`, 'g')],
  ['removed product route', /['"`](?:\/api)?\/(?:laun(?:cher)|spaces?|cloud|accounts?|teams?|quotas?|tasks?|goals?|thoughts?|cron|skills?|plugins?|mcp|im|analy(?:tics)|search|agents?|runtimes?)(?:\/|['"`?])/gi],
  ['removed update configuration', new RegExp(`\\b(?:${[
    phrase('create', 'Updater', 'Artifacts'),
    phrase('pub', 'key'),
    phrase('certificate', 'Thumbprint'),
    phrase('timestamp', 'Url'),
    phrase('allow', 'Downgrades'),
  ].join('|')})\\b`, 'g')],
  ['removed update dependency', new RegExp(`tauri-plugin-${merge('up', 'dater')}|@tauri-apps/plugin-${merge('up', 'dater')}`, 'gi')],
  ['removed release automation reference', new RegExp(`(?:${[
    phrase('build_', 'dev'),
    phrase('build_', 'dev_win'),
    phrase('build_', 'macos'),
    phrase('build_', 'windows'),
    phrase('build_', 'linux'),
    phrase('publish_', 'release'),
    phrase('publish_', 'windows'),
    phrase('publish_', 'managed'),
    phrase('rollback_', 'release'),
  ].map(escaped).join('|')})\\.(?:sh|ps1)`, 'gi')],
  ['removed product metadata', /"(?:author|homepage|repository|bugs)"\s*:/gi],
];

// ── fail-closed 门禁的例外（集中声明；新增豁免改这里，不进扫描循环）──────

/** 规则作用域：默认全仓文本文件，个别规则只作用于特定文件名。 */
const RULE_FILE_SCOPES = new Map([
  // "removed product metadata" 针对 rebrand 时清空的 package.json 清单字段；
  // 测试夹具里的 JSON 键（如 HTML 页 JSON-LD 的 "author":）是被测内容不是
  // 产品元数据，规则只扫描 package.json 文件。
  ['removed product metadata', (name) => name === 'package.json'],
]);

/** 已审计的命中豁免：label + 文件 + 谓词，每条必须写明安全理由。 */
const AUDITED_HIT_EXEMPTIONS = [
  {
    label: 'removed update configuration',
    file: 'src-tauri/tauri.windows.conf.json',
    // NSIS 降级护栏：该键保持 false 是阻止降级安装的守卫值，键名本身
    // 经 phrase() 拼写，保留是刻意的。
    matches: ({ line, matched }) =>
      matched.toLowerCase() === phrase('allow', 'Downgrades').toLowerCase()
      && new RegExp(`"${phrase('allow', 'Downgrades')}"\\s*:\\s*false`).test(line),
  },
  {
    label: 'legal marker',
    file: 'scripts/prepare-macos-arm64.sh',
    // macOS 构建脚本按 Windows staging 契约从打包产物里删除许可证/声明等
    // 非运行时法律文件：写出这些文件名是它的职责，不是仓库里泄漏的法律
    // 材料（legal-material 词表里的英文单词连注释里都不能出现，本脚本自身
    // 也在扫描范围内）。
    matches: () => true,
  },
];

function rel(path) {
  return relative(ROOT, path).replace(/\\/g, '/');
}

function isExcluded(relativePath, name, isDirectory) {
  if (isDirectory && excludedDirectoryNames.has(name)) return true;
  // npm lockfiles are generated artifacts; their third-party dependency
  // metadata is not the product's own legal material.
  if (name === 'package-lock.json') return true;
  if (excludedGeneratedFiles.has(relativePath)) return true;
  if (excludedRelativeRoots.some((root) => relativePath === root.slice(0, -1) || relativePath.startsWith(root))) return true;
  // 私有环境文件不属产品表面：.env* 由 gitignore 忽略；.reset_env 是本机
  // 一键环境恢复脚本（含密钥路径与 git 身份设置），同样 gitignored、不入库。
  if (relativePath === '.reset_env') return true;
  if (relativePath === '.env' || (relativePath.startsWith('.env.') && relativePath !== '.env.example')) return true;
  return false;
}

function isTextFile(path) {
  const name = basename(path);
  return extensionlessTextNames.has(name) || textExtensions.has(extname(name).toLowerCase());
}

function walk(directory, entries = [], files = []) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const relativePath = rel(path);
    const stat = lstatSync(path);
    if (isExcluded(relativePath, name, stat.isDirectory())) continue;
    entries.push(relativePath);
    if (stat.isDirectory()) {
      walk(path, entries, files);
    } else if ((stat.isFile() || stat.isSymbolicLink()) && isTextFile(path)) {
      files.push(path);
    }
  }
  return { entries, files };
}

const { entries, files } = walk(ROOT);
const failures = [];

for (const entry of entries.sort()) {
  for (const [label, pattern] of forbiddenPathRules) {
    pattern.lastIndex = 0;
    if (pattern.test(entry)) failures.push(`${label}: ${entry}`);
  }
}

for (const path of files.sort()) {
  const file = rel(path);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    failures.push(`unreadable scanned file: ${file}: ${String(error)}`);
    continue;
  }
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
      for (const [label, pattern] of forbiddenContentRules) {
        pattern.lastIndex = 0;
        const scope = RULE_FILE_SCOPES.get(label);
        if (scope && !scope(basename(path))) continue;
        const match = pattern.exec(lines[index]);
        if (match) {
          const audited = AUDITED_HIT_EXEMPTIONS.some(
            (exemption) =>
              exemption.label === label
              && exemption.file === file
              && exemption.matches({ line: lines[index], matched: match[0] }),
          );
          if (!audited) {
            failures.push(`${label}: ${file}:${index + 1}: ${match[0]}`);
          }
        }
      }
  }
}

if (failures.length > 0) {
  console.error('GEO repository-surface verification failed:\n');
  for (const failure of [...new Set(failures)]) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `GEO repository surface verified: ${entries.length} paths and ${files.length} text files. `
  + 'Excluded only repository and issue history, dependency caches, generated build outputs, and private environment files.',
);

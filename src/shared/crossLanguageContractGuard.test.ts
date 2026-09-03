// 跨语言契约守卫（票 #35 建立，票 #41 收尾至零命中终态；ADR-0012）。
//
// 两条断言：
//  1. 同步注释词汇在非测试源文件中零命中——#35 以「现存命中清单为初始
//     豁免表」的 ratchet 落地，各迁移票逐项删除，票 #41 清空豁免表并统一
//     改写剩余自然语言措辞后达成终态：今后任何新增「与 TS 同步」类注释
//     直接红灯，新契约一律走 *Contract.json 裁判机制（Rust include_str! +
//     TS import 双侧 pin）。终态口径由票 #41 裁定扩展：src 的非测试 .tsx
//     一并纳入扫描（渲染器组件同样可能携带手写镜像注释）。
//  2. 每个 `*Contract.json`（不含用例型 `*ContractCases.json`）必须同时被
//     Rust `include_str!`（src-tauri/src）与 TS import（src / backend）引用，
//     防止裁判 JSON 落地后无人消费变成孤儿。
//
// 词汇命中口径：同一行内多个词只算一条命中（与 `rg -n` 行口径一致）；匹配容忍
// 跨行折行——英文词间允许空白与续行注释装饰（`[\s*]+`），中文词内仅容忍空白。
//
// 复现命令（与本测试同口径，外加 .tsx）：
//   rg -U -i "同\s*源|逐字\s*同步|逐字\s*一致|两处\s*同源|同\s*一\s*序\s*列|keep[\s*]+in[\s*]+sync|independently[\s*]+mirrors" \
//     src-tauri/src src backend/src -g '*.rs' -g '*.ts' -g '*.tsx' -g '!*.test.ts' -g '!*.test.tsx'
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const SYNC_TERM_RES: readonly RegExp[] = [
  /同\s*源/g,
  /逐字\s*同步/g,
  /逐字\s*一致/g,
  /两处\s*同源/g,
  /同\s*一\s*序\s*列/g,
  /keep[\s*]+in[\s*]+sync/gi,
  /independently[\s*]+mirrors/gi,
];

function walkFiles(rootDir: string, keep: (file: string) => boolean): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") {
        continue;
      }
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (keep(entry.name)) out.push(path);
    }
  };
  visit(join(REPO_ROOT, rootDir));
  return out;
}

function repoRelative(path: string): string {
  return relative(REPO_ROOT, path).replace(/\\/g, "/");
}

const readCache = new Map<string, string>();
function readText(path: string): string {
  let content = readCache.get(path);
  if (content === undefined) {
    content = readFileSync(path, "utf8");
    readCache.set(path, content);
  }
  return content;
}

/** 词汇扫描：返回命中键（`路径 :: 行原文`），每个命中行一条。 */
function scanSyncTerms(path: string): string[] {
  const content = readText(path);
  const lines = content.split(/\r?\n/);
  const hitLineNos = new Set<number>();
  for (const re of SYNC_TERM_RES) {
    re.lastIndex = 0;
    let match = re.exec(content);
    while (match) {
      hitLineNos.add(content.slice(0, match.index).split("\n").length);
      match = re.exec(content);
    }
  }
  return [...hitLineNos].map((lineNo) => `${repoRelative(path)} :: ${lines[lineNo - 1].trim()}`);
}

/** Rust `include_str!(...)` 宏实参内的全部字符串字面量（含 concat!/env! 嵌套）。 */
function rustIncludeStrLiterals(content: string): string[] {
  const out: string[] = [];
  const macroStart = /include_str!\s*\(/g;
  let start = macroStart.exec(content);
  while (start) {
    let depth = 1;
    let i = start.index + start[0].length;
    while (i < content.length && depth > 0) {
      const ch = content[i];
      if (ch === '"') {
        i += 1;
        while (i < content.length && content[i] !== '"') {
          if (content[i] === "\\") i += 1;
          i += 1;
        }
      } else if (ch === "(") {
        depth += 1;
      } else if (ch === ")") {
        depth -= 1;
      }
      i += 1;
    }
    const span = content.slice(start.index, i);
    for (const literal of span.match(/"(?:[^"\\]|\\.)*"/g) ?? []) {
      out.push(literal.slice(1, -1));
    }
    start = macroStart.exec(content);
  }
  return out;
}

/** TS 侧 JSON 引用说明符：import/from、动态 import、require、new URL 四种形态。 */
function tsJsonSpecifiers(content: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\bfrom\s*["']([^"']+\.json)["']/g,
    /\bimport\s*["']([^"']+\.json)["']/g,
    /\bimport\s*\(\s*["']([^"']+\.json)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+\.json)["']\s*\)/g,
    /\bnew\s+URL\s*\(\s*["']([^"']+\.json)["']/g,
  ];
  for (const pattern of patterns) {
    let match = pattern.exec(content);
    while (match) {
      out.push(match[1]);
      match = pattern.exec(content);
    }
  }
  return out;
}

/** 说明符是否指向目标契约 JSON（相对说明符按导入文件解析，别名/绝对式退化为路径后缀比对）。 */
function specifierTargets(importingFile: string, specifier: string, contractRelPath: string): boolean {
  if (specifier.startsWith(".")) {
    const resolved = repoRelative(resolve(dirname(importingFile), specifier));
    return resolved === contractRelPath;
  }
  return refPathTargets(specifier, contractRelPath);
}

/** Rust include_str! 字面量 / 非 TS 相对式说明符：比对规范化后的仓库相对路径后缀。 */
function refPathTargets(ref: string, contractRelPath: string): boolean {
  return ref.replace(/\\/g, "/").endsWith(`/${contractRelPath}`);
}

describe("跨语言契约守卫（ADR-0012）", () => {
  it("同步注释词汇在非测试源文件中零命中（票 #41 终态：无豁免表）", () => {
    // 扫描根沿票 #35 口径（src-tauri/src 的 .rs、src 与 backend/src 的
    // 非测试 .ts），票 #41 收尾扩展：src 的非测试 .tsx 一并纳入。
    const scanned = [
      ...walkFiles("src-tauri/src", (name) => name.endsWith(".rs")),
      ...walkFiles("src", (name) =>
        (name.endsWith(".ts") || name.endsWith(".tsx"))
        && !name.endsWith(".test.ts")
        && !name.endsWith(".test.tsx")),
      ...walkFiles("backend/src", (name) => name.endsWith(".ts") && !name.endsWith(".test.ts")),
    ];
    const hits = scanned.flatMap(scanSyncTerms).sort();

    expect(
      hits,
      "发现同步注释词汇命中（票 #41 后已无豁免表）。新契约请走 *Contract.json 裁判"
        + "机制（ADR-0012：Rust include_str! + TS import 双侧 pin），不要新增手写"
        + "镜像注释；确属词汇的自然语言用法请改写措辞（如「同一语义」「逐字相同」）。",
    ).toEqual([]);
  });

  it("每个 *Contract.json 都被 Rust include_str! 与 TS import 双侧引用（无孤儿裁判）", () => {
    const contractFiles = walkFiles("src/shared", (name) => (
      name.endsWith("Contract.json") && !name.endsWith("ContractCases.json")
    )).map(repoRelative);
    // 引用扫描的根比词汇扫描宽（含 *.test.ts 与 backend/tests）：ADR-0012 把
    // TS 侧 pin 测试落在模块测试与 backend/tests 里，引用发生在测试文件内。
    if (contractFiles.length === 0) return;

    const rustReferenced = new Set<string>();
    for (const rustFile of walkFiles("src-tauri/src", (name) => name.endsWith(".rs"))) {
      for (const literal of rustIncludeStrLiterals(readText(rustFile))) {
        for (const contract of contractFiles) {
          if (refPathTargets(literal, contract)) {
            rustReferenced.add(contract);
          }
        }
      }
    }

    const tsFiles = [
      ...walkFiles("src", (name) => name.endsWith(".ts") || name.endsWith(".tsx")),
      ...walkFiles("backend", (name) => name.endsWith(".ts")),
    ];
    const tsReferenced = new Set<string>();
    for (const tsFile of tsFiles) {
      for (const specifier of tsJsonSpecifiers(readText(tsFile))) {
        for (const contract of contractFiles) {
          if (specifierTargets(tsFile, specifier, contract)) {
            tsReferenced.add(contract);
          }
        }
      }
    }

    expect(
      contractFiles.filter((contract) => !rustReferenced.has(contract)).map(
        (contract) => `${contract}：缺 Rust include_str! 引用`,
      ),
      "裁判 JSON 必须被 Rust 侧 include_str! pin（先例：materialImagePlaceholderContractCases.json）。",
    ).toEqual([]);
    expect(
      contractFiles.filter((contract) => !tsReferenced.has(contract)).map(
        (contract) => `${contract}：缺 TS import 引用`,
      ),
      "裁判 JSON 必须被 TS 侧 import pin（先例：articleGeneration.test.ts 对 ContractCases 的 import）。",
    ).toEqual([]);
  });

  it("守卫工具函数：include_str! 字面量提取（含 concat!/env! 嵌套）", () => {
    expect(
      rustIncludeStrLiterals(
        'let c: T = serde_json::from_str(include_str!(concat!(\n'
          + '    env!("CARGO_MANIFEST_DIR"),\n'
          + '    "/../src/shared/geo/fooContract.json"\n'
          + '))).expect("x"); let s = include_str!("a.json");',
      ),
    ).toEqual(["CARGO_MANIFEST_DIR", "/../src/shared/geo/fooContract.json", "a.json"]);
  });

  it("守卫工具函数：TS JSON 引用说明符四种形态", () => {
    expect(tsJsonSpecifiers('import a from "./a.json"; import "./b.json";')).toEqual(["./a.json", "./b.json"]);
    expect(tsJsonSpecifiers("const m = await import('./c.json'); const r = require('./d.json');")).toEqual([
      "./c.json",
      "./d.json",
    ]);
    expect(tsJsonSpecifiers('const u = new URL("./e.json", import.meta.url);')).toEqual(["./e.json"]);
    expect(tsJsonSpecifiers('import x from "./notJson";')).toEqual([]);
  });

  it("守卫工具函数：跨行折行的英文短语可检出（词汇扫描器能力自检，防跨行漏检）", () => {
    const content = "/** Shared defaults. Rust owns persistence and independently\n * mirrors these values. */";
    expect(/independently[\s*]+mirrors/gi.test(content)).toBe(true);
  });
});

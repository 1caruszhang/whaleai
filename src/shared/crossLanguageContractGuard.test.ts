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
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { repoRelative, walkFiles } from "./repoFileScan";

const SYNC_TERM_RES: readonly RegExp[] = [
  /同\s*源/g,
  /逐字\s*同步/g,
  /逐字\s*一致/g,
  /两处\s*同源/g,
  /同\s*一\s*序\s*列/g,
  /keep[\s*]+in[\s*]+sync/gi,
  /independently[\s*]+mirrors/gi,
];

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

// ═══ 产物血缘直写守卫棘轮（ADR-0013，立项票 2026-09-04） ═══
//
// geo_operations 一表两聚合：主链操作机（geo_operations.rs）与产物血缘行。
// 血缘写路径的唯一 owner 是 artifact_lineage.rs（open_lineage /
// set_lineage_state），生产代码里对 geo_operations 的 INSERT/UPDATE SQL
// 只允许出现在这两个模块；其余现存直写按「域×写点」登记在下方豁免表——
// 它们是登记在册的过渡态而非违规，各域清零票（baseline/question-pool/
// topic-plan/distribution/articles/monitor/publish）迁写点经 owner 接口后
// 删除对应豁免项，publish 族（9 处）清零后终态零豁免。
//
// 扫描只看生产段（首个测试模块之前的文本）：测试 fixture 的裸 INSERT
// 不受约束。豁免键＝`${仓库相对路径}::${n}`，n 为该文件生产段内写点的
// 出现序号——行号会随编辑漂移故不按行号登记；七域与七个文件一一对应，
// 清零整域即整文件消块，序号不跨域漂移。

const LINEAGE_SQL_WRITE_ALLOWLIST: ReadonlySet<string> = new Set([
  "src-tauri/src/brand_workspace/geo_operations.rs",
  "src-tauri/src/brand_workspace/artifact_lineage.rs",
]);

/** 豁免表＝清零进度表：值是域标签（供清零票按域消项），键须与现实写点集严格相等。
 * 初始登记恰 27 项（2026-09-04 立项盘点：2+3+2+2+3+9+6）由该严格相等的传递性
 * 锁死，不硬编码计数断言——清零票逐项消项时硬编码计数会误红（spec 决策 5
 * 「逐票清零」与 Testing Decisions「初始恰 27 项」的相容读法）。 */
const LINEAGE_DIRECT_WRITE_EXEMPTIONS: ReadonlyMap<string, string> = new Map([
  // baseline 族 2 处（geo_baselines.rs：开行＋完成迁移）
  ["src-tauri/src/brand_workspace/geo_baselines.rs::1", "baseline"],
  ["src-tauri/src/brand_workspace/geo_baselines.rs::2", "baseline"],
  // question-pool 族 3 处（question_pools.rs：开行＋落库迁移＋决策迁移）
  ["src-tauri/src/brand_workspace/question_pools.rs::1", "question-pool"],
  ["src-tauri/src/brand_workspace/question_pools.rs::2", "question-pool"],
  ["src-tauri/src/brand_workspace/question_pools.rs::3", "question-pool"],
  // topic-plan 族 2 处（topic_plans.rs：开行＋确认迁移）
  ["src-tauri/src/brand_workspace/topic_plans.rs::1", "topic-plan"],
  ["src-tauri/src/brand_workspace/topic_plans.rs::2", "topic-plan"],
  // article-generation 族 2 处（articles.rs：开行＋状态聚合刷新）
  ["src-tauri/src/brand_workspace/articles.rs::1", "article-generation"],
  ["src-tauri/src/brand_workspace/articles.rs::2", "article-generation"],
  // distribution 族 3 处（distribution_plans.rs：开行＋发现完成＋确认迁移）
  ["src-tauri/src/brand_workspace/distribution_plans.rs::1", "distribution"],
  ["src-tauri/src/brand_workspace/distribution_plans.rs::2", "distribution"],
  ["src-tauri/src/brand_workspace/distribution_plans.rs::3", "distribution"],
  // publish 族 9 处（publish_scheduler.rs：两处旧预览废弃＋开行＋确认＋
  // 启动＋复活＋取消＋恢复＋聚合刷新）——清零后守卫达成零豁免终态
  ["src-tauri/src/brand_workspace/publish_scheduler.rs::1", "publish"],
  ["src-tauri/src/brand_workspace/publish_scheduler.rs::2", "publish"],
  ["src-tauri/src/brand_workspace/publish_scheduler.rs::3", "publish"],
  ["src-tauri/src/brand_workspace/publish_scheduler.rs::4", "publish"],
  ["src-tauri/src/brand_workspace/publish_scheduler.rs::5", "publish"],
  ["src-tauri/src/brand_workspace/publish_scheduler.rs::6", "publish"],
  ["src-tauri/src/brand_workspace/publish_scheduler.rs::7", "publish"],
  ["src-tauri/src/brand_workspace/publish_scheduler.rs::8", "publish"],
  ["src-tauri/src/brand_workspace/publish_scheduler.rs::9", "publish"],
  // monitor 族 6 处（post_publish_monitoring.rs：开行＋激活＋两处终局＋
  // 暂停＋恢复，含 paused↔active 循环回路）
  ["src-tauri/src/brand_workspace/post_publish_monitoring.rs::1", "monitor"],
  ["src-tauri/src/brand_workspace/post_publish_monitoring.rs::2", "monitor"],
  ["src-tauri/src/brand_workspace/post_publish_monitoring.rs::3", "monitor"],
  ["src-tauri/src/brand_workspace/post_publish_monitoring.rs::4", "monitor"],
  ["src-tauri/src/brand_workspace/post_publish_monitoring.rs::5", "monitor"],
  ["src-tauri/src/brand_workspace/post_publish_monitoring.rs::6", "monitor"],
]);

const LINEAGE_WRITE_SQL_RES: readonly RegExp[] = [
  /insert\s+into\s+geo_operations\b/gi,
  /update\s+geo_operations\b/gi,
];

/**
 * Rust 源文本的生产段＝首个测试模块之前的文本。边界只认「`#[cfg(test)]`
 * 之后（仅空白）紧跟 `mod` 声明」：publish_scheduler/post_publish_monitoring
 * 存在内联 `#[cfg(test)]` 静态/方法，geo_operations 注释里出现字面文本
 * `#[cfg(test)]`——它们都不切段，否则生产写点会被静默划出扫描范围。
 */
function rustProductionSegment(content: string): string {
  const testModule = /#\[cfg\(test\)\]\s*\r?\n\s*mod\s/g;
  const match = testModule.exec(content);
  return match ? content.slice(0, match.index) : content;
}

/** 扫描单文件生产段的 geo_operations 直写，按出现顺序返回 `${路径}::${n}` 键。 */
function scanLineageDirectWrites(relPath: string, production: string): string[] {
  const hitLines = new Set<number>();
  for (const re of LINEAGE_WRITE_SQL_RES) {
    re.lastIndex = 0;
    let match = re.exec(production);
    while (match) {
      hitLines.add(production.slice(0, match.index).split("\n").length);
      match = re.exec(production);
    }
  }
  return [...hitLines]
    .sort((a, b) => a - b)
    .map((_, index) => `${relPath}::${index + 1}`);
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

describe("产物血缘直写守卫棘轮（ADR-0013）", () => {
  it("geo_operations 生产 SQL 写点只允许主链与血缘 owner 两模块，豁免表与现实严格相等", () => {
    const found = new Map<string, string>();
    for (const rustFile of walkFiles("src-tauri/src", (name) => name.endsWith(".rs"))) {
      const relPath = repoRelative(rustFile);
      if (LINEAGE_SQL_WRITE_ALLOWLIST.has(relPath)) continue;
      for (const key of scanLineageDirectWrites(relPath, rustProductionSegment(readText(rustFile)))) {
        const family = LINEAGE_DIRECT_WRITE_EXEMPTIONS.get(key);
        if (family !== undefined) found.set(key, family);
        else found.set(key, "【未豁免】");
      }
    }
    const unexempted = [...found]
      .filter(([, family]) => family === "【未豁免】")
      .map(([key]) => key);
    expect(
      unexempted,
      "生产代码对 geo_operations 的新直写必红：血缘写只允许经 artifact_lineage.rs"
        + "（open_lineage/set_lineage_state）或主链模块 geo_operations.rs。"
        + "迁移某域写点后请同步删除豁免表对应项。",
    ).toEqual([]);
    const staleEntries = [...LINEAGE_DIRECT_WRITE_EXEMPTIONS.keys()].filter(
      (key) => found.get(key) !== LINEAGE_DIRECT_WRITE_EXEMPTIONS.get(key),
    );
    expect(
      staleEntries,
      "豁免表里已无对应现实写点的登记项：写点已被迁移或删除时必须同票消项"
        + "（豁免表即清零进度表，不允许悬挂登记）。",
    ).toEqual([]);
  });

  it("守卫工具函数：生产段切分只认测试模块边界（内联 cfg(test) 与注释字面量不切段）", () => {
    const sample = [
      "fn prod_one() {}",
      "#[cfg(test)]",
      "static TEST_ONLY: u8 = 0; // 内联 cfg(test) 静态（publish_scheduler 先例）",
      "",
      "    fn inline_test_helper() {} // cfg(test) 方法（post_publish_monitoring 先例）",
      "// 注释里的 #[cfg(test)] 字面文本（geo_operations 先例）",
      "#[cfg(test)]",
      "mod tests {",
      "    fn prod_lookalike_in_tests() {}",
      "}",
    ].join("\n");
    const production = rustProductionSegment(sample);
    expect(production).toContain("fn prod_one");
    expect(production).toContain("static TEST_ONLY");
    expect(production).toContain("inline_test_helper");
    expect(production).not.toContain("prod_lookalike_in_tests");
  });

  it("守卫工具函数：注入直写样例必红（变异演示——第二个写缝无法静默滋生）", () => {
    const injected = [
      "fn new_domain_write(connection: &Connection) {",
      '    connection.execute(',
      '        "UPDATE geo_operations SET state=?2 WHERE id=?1",',
      "        params![id, state],",
      "    )?;",
      "}",
      "#[cfg(test)]",
      "mod tests {",
      '    // 测试段里的裸 INSERT 不受守卫约束（守卫只看生产段）',
      '    connection.execute("INSERT INTO geo_operations (id) VALUES (?1)", []).unwrap();',
      "}",
    ].join("\n");
    const keys = scanLineageDirectWrites(
      "src-tauri/src/brand_workspace/new_domain.rs",
      rustProductionSegment(injected),
    );
    expect(keys).toEqual(["src-tauri/src/brand_workspace/new_domain.rs::1"]);
    expect(LINEAGE_DIRECT_WRITE_EXEMPTIONS.has(keys[0])).toBe(false);
  });

  it("守卫工具函数：INSERT 无空格变体可检出，allowlist 恰两模块", () => {
    const compact = 'execute("INSERT INTO geo_operations(id,session_id,state,created_at) VALUES (?,?,?,?)", []);';
    expect(scanLineageDirectWrites("x.rs", compact)).toEqual(["x.rs::1"]);
    expect(LINEAGE_SQL_WRITE_ALLOWLIST.size).toBe(2);
  });
});

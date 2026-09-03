// 跨语言契约守卫（票 #35，ADR-0012「共享 JSON 双侧 pin」机制票）。
//
// 两条断言：
//  1. ratchet——同步注释词汇在非测试源文件中的命中集合与下方豁免表完全相等：
//     新增命中（未入表）红灯，迁移票删除同步注释后豁免表条目变过期同样红灯，
//     直到该票把自己的条目一并删除；末票清空豁免表后即达成零命中终态。
//  2. 每个 `*Contract.json`（不含用例型 `*ContractCases.json`）必须同时被
//     Rust `include_str!`（src-tauri/src）与 TS import（src / backend）引用，
//     防止裁判 JSON 落地后无人消费变成孤儿。迁移开始前允许空集。
//
// 词汇命中口径：同一行内多个词只算一条命中（与 `rg -n` 行口径一致）；匹配容忍
// 跨行折行——英文词间允许空白与续行注释装饰（`[\s*]+`），中文词内仅容忍空白。
// 命中键为「仓库相对路径 :: 命中起始行 trim 后原文」，不钉行号（行号漂移不误报），
// 改写豁免条目的措辞需同步更新本表。
//
// 复现命令（与本测试同口径）：
//   rg -U -i "同\s*源|逐字\s*同步|逐字\s*一致|两处\s*同源|同\s*一\s*序\s*列|keep[\s*]+in[\s*]+sync|independently[\s*]+mirrors" \
//     src-tauri/src src backend/src -g '*.rs' -g '*.ts' -g '!*.test.ts'
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

// ─── 初始豁免表（票 #35 建立，以 2026-09-03 实际扫描为准）─────────────────────
// owner 标注契约归属：跨语言契约条目归对应迁移票逐项删除；「非跨语言」条目是
// 词汇的自然语言用法（同语言内部一致性注释、提示词文案等），无迁移票认领，
// 由收尾票统一改写措辞后删除。
type SyncCommentExemption = {
  hit: string;
  owner: string;
};

const EXEMPTIONS: readonly SyncCommentExemption[] = [
  // 迁移票①：publish_scheduler 族试点（POLICY_VERSION / RETRY / 订单状态枚举 / 退点状态）
  {
    hit: 'src/shared/geo/publishScheduler.ts :: /** 预览载荷哈希公式的输入（Rust 侧同名 POLICY_VERSION 逐字同步）：钉的是',
    owner: "迁移票①publish_scheduler 试点",
  },
  {
    hit: 'src/shared/geo/publishScheduler.ts :: /** 自动重试 2 次、间隔 3 秒（与 Rust 侧 RETRY_BACKOFF_MS 同源契约）：',
    owner: "迁移票①publish_scheduler 试点",
  },
  {
    hit: "src/shared/geo/publishScheduler.ts :: * 上游渠道订单状态码（超级媒介契约，与后端 `publish-orders` 状态机同源）：",
    owner: "迁移票①publish_scheduler 试点",
  },
  {
    hit: "src/shared/geo/publishScheduler.ts :: * 是否为原路退点状态（后端 REFUND_STATUSES 同源）：已拒稿(2)、已取消(5)、",
    owner: "迁移票①publish_scheduler 试点",
  },
  // 迁移票②：geo_operations 九表
  {
    hit: "src-tauri/src/brand_workspace/geo_operations.rs :: /// 知识段步骤 id（与 shared policy 的 KNOWLEDGE_STEPS 同一序列，票 07）：",
    owner: "迁移票②geo_operations 九表",
  },
  // 迁移票④：点数三源＋spend-limits
  {
    hit: "src/shared/geo/distributionSpendLimits.ts :: /** Shared client/Sidecar defaults. Rust owns persistence and independently",
    owner: "迁移票④点数三源＋spend-limits",
  },
  // 迁移票⑤：provider 字符串＋图片白名单
  {
    hit: "src-tauri/src/brand_workspace/publish_scheduler.rs :: /// 图片对象扩展名（与 TS capability 的白名单口径逐字一致：jpeg 统一",
    owner: "迁移票⑤provider 字符串＋图片白名单",
  },
  // 迁移票⑥：其余版本戳＋BINARY_EXTENSIONS 收尾
  {
    hit: "src-tauri/src/workspace_files/read_preview.rs :: /// Keep in sync with `src/shared/fileTypes.ts::BINARY_EXTENSIONS`.",
    owner: "迁移票⑥版本戳＋BINARY_EXTENSIONS 收尾",
  },
  // 非跨语言：词汇的自然语言用法，收尾票统一改写
  {
    hit: "backend/src/auth/tokens.ts :: // nowMs 注入校验时钟（与签发同源）：测试固定假时钟时，jose 默认按真实",
    owner: "非跨语言：backend 内部时钟语义",
  },
  {
    hit: "backend/src/domain/pricing.ts :: * 与《计费标准》公示文件同源；调价 = 改本表 + 公示文件同步。价目只定单价，",
    owner: "非跨语言：代码↔公示文档同源",
  },
  {
    hit: "backend/src/gateway/distribution-upstream.ts :: * 签名规则与票 05 资源读取完全同源（展平 HMAC-SHA256 + timestamp 现取），",
    owner: "非跨语言：backend 内部签名规则",
  },
  {
    hit: "backend/src/http/provider-proxy-routes.ts :: // 客户端不传价、传了也不看（与 permit 价目红线同源）。",
    owner: "非跨语言：backend 内部价目红线",
  },
  {
    hit: "src-tauri/src/brand_workspace/distribution_plans.rs :: // geo: 载荷必须与候选自带资源快照的 geoPlatforms 逐字一致",
    owner: "非跨语言：Rust 内部（载荷 vs 候选快照）",
  },
  {
    hit: "src-tauri/src/brand_workspace/geo_baselines.rs :: /// 冻结的已确认竞品名单：与 `baseline_brand_names` 同源的 knowledge 版本",
    owner: "非跨语言：Rust 内部（冻结名单版本）",
  },
  {
    hit: 'src-tauri/src/brand_workspace/publish_scheduler.rs :: /// "long-identifier-".repeat(8))` 的字面值，与夹具构造式逐字同源）。',
    owner: "非跨语言：Rust 测试夹具注释",
  },
  {
    hit: "src-tauri/src/brand_workspace/topic_plans.rs :: /// 「重新生成内容计划」：与 prepare 的 force_regenerate 同源——跳过",
    owner: "非跨语言：Rust 内部（force_regenerate 语义）",
  },
  {
    hit: "src-tauri/src/management_api.rs :: // 同源，接管落地后被接管会话在这里得到指明接管者的错误。",
    owner: "非跨语言：Rust 内部（所有权判定点）",
  },
  {
    hit: "src/renderer/components/account/complianceDocs.ts :: * 文件天然同源，不存在第二份可漂移的文本。价目数字与",
    owner: "非跨语言：渲染器内部（文档生成器）",
  },
  {
    hit: "src/renderer/components/xiaojing/articlePreviewDocument.ts :: * 同一个生成器，保证「预览 = 导出」——正文结构与 CSS 字节同源，仅图片",
    owner: "非跨语言：渲染器内部（预览=导出）",
  },
  {
    hit: "src/server/geo/gate-revision.ts :: * 与 MCP 组装点同源）：组合根按其取能力与计费口径，缺省回退启动单例",
    owner: "非跨语言：TS 组合根内部",
  },
  {
    hit: "src/server/geo/gate-revision.ts :: /** 卡片决策与聊天修订同源：指令都来自桌面前的用户本人。 */",
    owner: "非跨语言：产品语义（用户本人指令）",
  },
  {
    hit: "src/server/geo/knowledge-authority.ts :: * 候选审计摘录的长度闸门（propose 与 MCP 工具 schema 同源）。ADR-0007 后",
    owner: "非跨语言：TS 内部（schema 闸门）",
  },
  {
    hit: "src/server/geo/material-import.ts :: '  是谁由材料决定（targetCustomers 字段的判定同源），不套固定模板。这条',",
    owner: "非跨语言：提示词文案用词（改写会动模型行为，收尾票裁定）",
  },
  {
    hit: "src/server/geo/material-import.ts :: * 份，渠道召回侧同源）。解析失败/非 URL 原样返回，退化为每条独立成组",
    owner: "非跨语言：语料召回语义",
  },
  {
    hit: "src/server/geo/material-import.ts :: * 盘点、口碑探店、行业榜单三个中立观察者语料池，避免同词重搜同源。",
    owner: "非跨语言：语料去重语义",
  },
  {
    hit: "src/server/geo/material-import.ts :: // 事故：19/20 同四站）。裁剪后的列表同源供给模型快照与存在闸语料。",
    owner: "非跨语言：快照供给语义",
  },
  {
    hit: "src/server/geo/material-import.ts :: // 新词时续搜收束，不拿同词重搜同源浪费预算。",
    owner: "非跨语言：语料去重语义",
  },
  {
    hit: "src/server/geo/material-import.ts :: // 竞品检索词与 facts 同源同响应：抽取模型已读完材料，顺手产出",
    owner: "非跨语言：单响应内同源",
  },
  {
    hit: "src/server/geo/operation-progress.ts :: * 步骤状态集与 currentGeoOperationStep 同源 shared policy，上方以",
    owner: "非跨语言：TS 内部（server 消费 shared policy）",
  },
  {
    hit: "src/server/geo/operation-progress.ts :: // generate-question-pool 条目同源话术——按计划调用即安全；复用命中",
    owner: "非跨语言：话术三处同源（ADR-0011 域）",
  },
  {
    hit: "src/server/geo/operation-progress.ts :: // 复用契约（ADR-0011 Decision 3）：话术与工具描述、结果信封逐字同源",
    owner: "非跨语言：话术三处同源（ADR-0011 域）",
  },
  {
    hit: "src/server/geo/operation-progress.ts :: // 材料收集契约（票 03）：话术与工具描述、系统提示词材料段逐字同源",
    owner: "非跨语言：话术三处同源（ADR-0011 域）",
  },
  {
    hit: "src/server/geo/stage-order-gate.ts :: /** 当前步是 agent 工具步时：应调工具的引述（next-step 单表同源）。 */",
    owner: "非跨语言：next-step 单表",
  },
  {
    hit: "src/server/geo/topic-plan.ts :: * identity 落第二代计划（与 prepare 的 forceRegenerate 同源）。 */",
    owner: "非跨语言：TS 内部（forceRegenerate 语义）",
  },
  {
    hit: "src/server/tools/xiaojing-geo-tool.ts :: * 产物经 Rust `latest` 端点读取，与右侧工作台投影同源。Agent 在新 Session",
    owner: "非跨语言：读取口径语义",
  },
  {
    hit: "src/server/tools/xiaojing-geo-tool.ts :: // 同源的本轮聊天 token），长会话修订不再依赖过期 env 单例。",
    owner: "非跨语言：请求级 token 语义",
  },
  {
    hit: "src/shared/geo/articleGeneration.ts :: `- 首行必须是指定标题的 H1，逐字一致。`,",
    owner: "非跨语言：提示词文案用词（改写会动模型行为，收尾票裁定）",
  },
  {
    hit: "src/shared/geo/operation.ts :: * heldStep 指引按同一对区分裁决面——两处同源，防漂移。 */",
    owner: "非跨语言：TS 内部（heldStep 指引）",
  },
];

describe("跨语言契约守卫（ADR-0012）", () => {
  it("同步注释词汇命中与豁免表完全相等（不新增、不留过期条目）", () => {
    // 扫描根即票 #35 划定的口径（src-tauri/src 的 .rs、src 与 backend/src 的
    // 非测试 .ts）——不含 .tsx/backend 测试目录/仓内其余路径；终态清空豁免表时
    // 是否扩口径由收尾票裁定，勿在此静默放宽。
    const scanned = [
      ...walkFiles("src-tauri/src", (name) => name.endsWith(".rs")),
      ...walkFiles("src", (name) => name.endsWith(".ts") && !name.endsWith(".test.ts")),
      ...walkFiles("backend/src", (name) => name.endsWith(".ts") && !name.endsWith(".test.ts")),
    ];
    const actual = new Set(scanned.flatMap(scanSyncTerms));
    const exempted = new Set(EXEMPTIONS.map((entry) => entry.hit));

    const unexempted = [...actual].filter((hit) => !exempted.has(hit)).sort();
    expect(
      unexempted,
      "发现未入豁免表的同步注释词汇命中。新契约请走 *Contract.json 裁判机制（ADR-0012："
        + "Rust include_str! + TS import 双侧 pin），不要新增手写镜像注释；确属误报请改写措辞。",
    ).toEqual([]);

    const stale = EXEMPTIONS.filter((entry) => !actual.has(entry.hit));
    expect(
      stale.map((entry) => `${entry.hit}（${entry.owner}）`),
      "豁免表条目已无对应命中（过期）。请随所属迁移票删除该条目——ratchet 靠它收敛到零命中。",
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

  it("守卫工具函数：跨行折行的英文短语可检出（豁免表 distributionSpendLimits 条目的依据）", () => {
    const content = "/** Shared defaults. Rust owns persistence and independently\n * mirrors these values. */";
    expect(/independently[\s*]+mirrors/gi.test(content)).toBe(true);
  });
});

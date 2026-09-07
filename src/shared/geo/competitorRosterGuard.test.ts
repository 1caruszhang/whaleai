// 名单语义守卫（票 #43，ADR-0012 ratchet 词法缝同型）。
//
// 断言：名单语义标识符（内核 competitorRoster.ts 的全部导出函数名）的
// **定义处**只许出现在内核模块与测试文件，初值零豁免——收敛后即终态，无
// ratchet 过渡期。未来任何人在别的源文件里重新定义这些名字（哪怕是换文件
// 的整段复制）直接红灯，必须回到内核改或新增导出。
//
// 已知局限（pit_of_success「名单语义只出自内核」规则文字补位）：词法守卫
// 拦不住「换个名字私建归一/合并逻辑」——改名为 myNormalizeKey 的手抄副本
// 不含被守卫标识符；也拦不住改定义形态——正则只识别 function 声明与 const
// 箭头两种形态，class 方法简写、let/var 绑定、对象属性函数均可绕过。对
// 私建的第二道防线是跨语言契约 pin（改 TS 内核或 Rust 镜像任一侧先红）
// 与 code review；守卫只承诺「既有名单语义出口不分裂」。
//
// 复现命令（与本测试同口径）：
//   rg -n "function (resolveRankingRoster|filterValidRankingCompetitors|...)\(" src backend/src -g '*.ts' -g '*.tsx'
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { repoRelative, walkFiles } from "../repoFileScan";
import * as competitorRoster from "./competitorRoster";

const KERNEL_RELATIVE = "src/shared/geo/competitorRoster.ts";

const isTestFile = (path: string) =>
  path.endsWith(".test.ts") || path.endsWith(".test.tsx");

describe("名单语义守卫（票 #43：定义处只许内核与测试，零豁免）", () => {
  it("内核导出函数名清单非空且可被词法扫描", () => {
    // 守卫的裁判面：动态取内核全部导出函数名——新增导出自动进守卫，
    // 不需要手工维护名单（ratchet 自扩）。
    const names = Object.entries(competitorRoster)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name);
    expect(names).toEqual(expect.arrayContaining([
      "resolveRankingRoster",
      "filterValidRankingCompetitors",
      "mergeRankingCompetitorTiers",
      "titleRedLineCompetitors",
      "isCompetitorTierField",
      "isDirectCompetitorTierField",
      "isPotentialCompetitorTierField",
      "competitorCardRowField",
      "competitorCardTierOrder",
      "competitorCardPotentialDividerAt",
      "sameBrandIdentity",
      "isSimilarSelfName",
      "dropSelfReferences",
      "rosterIdentityKey",
      "competitorIdentityKey",
      "toSimplifiedChinese",
      "foldFullWidthAndLowercase",
      "decodeCompetitorEvidence",
      "collectCompetitorDetails",
      "formatCompetitorDisplayNames",
      "formatCompetitorFactValue",
    ]));
  });

  it("名单语义标识符定义处零豁免（初值即终态）", () => {
    const guardedNames = Object.entries(competitorRoster)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name);
    expect(guardedNames.length).toBeGreaterThan(0);

    // 扫描根沿 crossLanguageContractGuard 同口径：src 与 backend/src 的全部
    // TS/TSX（含测试文件进扫描、但测试文件是合法定义处/消费处，只对非测试
    // 文件断言；定义形态覆盖 function 声明与 const 箭头两种）。
    const scanned = [
      ...walkFiles("src", (name) => name.endsWith(".ts") || name.endsWith(".tsx")),
      ...walkFiles("backend/src", (name) => name.endsWith(".ts")),
    ];

    const hits: string[] = [];
    for (const path of scanned) {
      const rel = repoRelative(path);
      const content = readFileSync(path, "utf8");
      for (const name of guardedNames) {
        const definitionRe = new RegExp(
          `(?:^|[^\\w$.])(?:function\\s+${name}\\s*\\(|const\\s+${name}\\s*=)`,
        );
        if (definitionRe.test(content)) {
          if (rel === KERNEL_RELATIVE || isTestFile(rel)) continue;
          hits.push(`${rel} :: ${name}`);
        }
      }
    }

    expect(
      hits.sort(),
      "名单语义标识符定义处出现在内核之外的源文件（票 #43 后无豁免表）。"
        + " 名单投影/身份判定/归一键只许定义在 src/shared/geo/competitorRoster.ts；"
        + " 请把逻辑搬进内核或复用既有导出，不要在消费方另立定义。",
    ).toEqual([]);
  });
});

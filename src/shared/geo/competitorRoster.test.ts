import { describe, expect, it } from "vitest";

import rankingCompetitorContract from "./rankingCompetitorContract.json";
import rankingCompetitorContractCases from "./rankingCompetitorContractCases.json";
import {
  competitorCardPotentialDividerAt,
  competitorCardRowField,
  competitorCardTierOrder,
  competitorIdentityKey,
  decodeCompetitorEvidence,
  dropSelfReferences,
  filterValidRankingCompetitors,
  formatCompetitorFactValue,
  isCompetitorTierField,
  isSimilarSelfName,
  mergeRankingCompetitorTiers,
  RANKING_COMPETITORS_INSUFFICIENT_CODE,
  resolveRankingRoster,
  rosterIdentityKey,
  sameBrandIdentity,
  titleRedLineCompetitors,
} from "./competitorRoster";
import { buildArticleGenerationMessages } from "./articleGeneration";

describe("ranking competitor cross-process contract", () => {
  it("insufficient-code 常量与 rankingCompetitorContract.json 裁判严格相等（票 #43 review 补充 pin）", () => {
    // Rust 侧 articles.rs #[cfg(test)] 用 include_str! 对
    // validate_ranking_competitors 的错误串做行为等值 pin；错误码值以本
    // 裁判 JSON 为唯一权威，双侧常量/字面量不得脱离它各自手写。
    expect(RANKING_COMPETITORS_INSUFFICIENT_CODE).toBe(
      rankingCompetitorContract.rankingCompetitorsInsufficientCode,
    );
  });

  it.each(rankingCompetitorContractCases.mergeCases)("$name", (contractCase) => {
    // 两层联合（与 Rust valid_ranking_competitors 同构）恒为断言主体：
    // 直接层在前、潜在层补位，跨层互斥与身份排除两层共用；expected 是
    // 联合结果。纯直接层用例额外校验单层过滤行为不变。
    const potential = contractCase.potentialCompetitors ?? [];
    if (potential.length === 0) {
      expect(
        filterValidRankingCompetitors(contractCase.competitors, contractCase),
      ).toEqual(contractCase.expected);
    }
    expect(
      mergeRankingCompetitorTiers(
        contractCase.competitors,
        potential,
        contractCase,
      ),
    ).toEqual(contractCase.expected);
  });

  it("merged sequence keeps the direct tier before the potential backfill（票 #43 契约扩容）", () => {
    // TS 侧断言序列（Rust 镜像返回无序集合，pin 测试做集合比对）：合并序列
    // 的前缀恰为直接层幸存序列，尾部恰为潜在层补位。
    const orderingCase = rankingCompetitorContractCases.mergeCases.find(
      (contractCase) =>
        contractCase.name ===
        "merged sequence keeps direct tier before potential backfill",
    );
    if (!orderingCase) throw new Error("ordering contract case missing");
    const directKept = filterValidRankingCompetitors(
      orderingCase.competitors,
      orderingCase,
    );
    const merged = mergeRankingCompetitorTiers(
      orderingCase.competitors,
      orderingCase.potentialCompetitors ?? [],
      orderingCase,
    );
    expect(merged).toEqual(orderingCase.expected);
    expect(merged.slice(0, directKept.length)).toEqual(directKept);
    expect(merged.slice(directKept.length)).toEqual(
      (orderingCase.expected ?? []).slice(directKept.length),
    );
  });

  it.each(rankingCompetitorContractCases.keyNormalizationCases)(
    "ranking key normalization: $name（双侧算法一致子集）",
    (keyCase) => {
      // 排行键归一输入向量（票 #43）：只收 TS/Rust 双侧算法一致的子集
      // （中文、全角折叠、空白折叠、ASCII 大小写）；markdown 剥离与
      // Unicode lowercase 的分歧挂起于漂移台账，不入向量。
      expect(rosterIdentityKey(keyCase.input)).toBe(keyCase.expected);
    },
  );
});

describe("ranking roster projection（自 articleGeneration.test.ts 原样搬移，票 #43）", () => {
  it("requires five confirmed competitors and injects the fixed ranking roster", () => {
    const rankingFacts = [
      {
        factKey: "brand-name",
        predicate: "enterprise-profile.fullname",
        normalizedValueJson: '"目标品牌"',
      },
      {
        factKey: "competitors",
        predicate: "enterprise-profile.competitors",
        normalizedValueJson: '["竞品甲","竞品乙","竞品丙","竞品丁","竞品戊"]',
      },
    ];
    expect(resolveRankingRoster(rankingFacts, "工作区名称")).toEqual({
      targetBrand: "目标品牌",
      competitors: ["竞品甲", "竞品乙", "竞品丙", "竞品丁", "竞品戊"],
    });
    const messages = buildArticleGenerationMessages({
      brandName: "目标品牌",
      productLine: "本地服务",
      targetRegion: "成都",
      contentType: "ranking",
      topic: "本地服务怎么选",
      requestedTitle: "本地服务六家对比",
      constraints: "",
      plannedFacts: rankingFacts,
      rankingDimensions: [
        "服务范围",
        "核心项目",
        "适用人群",
        "服务方式",
        "区域覆盖",
        "选择要点",
      ],
    });
    expect(messages.user).toContain("目标品牌固定为陈列位 1");
    expect(messages.user).toContain("竞品甲、竞品乙、竞品丙、竞品丁、竞品戊");
    expect(messages.user).toContain("五家竞品在陈列位 2–6 的顺序可自由调整");
    expect(() =>
      buildArticleGenerationMessages({
        brandName: "目标品牌",
        productLine: "本地服务",
        targetRegion: "成都",
        contentType: "ranking",
        topic: "本地服务怎么选",
        requestedTitle: "本地服务六家对比",
        constraints: "",
        plannedFacts: rankingFacts,
      }),
    ).toThrow("article_generation_ranking_dimensions_missing");

    expect(() =>
      resolveRankingRoster(
        [
          rankingFacts[0],
          { ...rankingFacts[1], normalizedValueJson: '["竞品甲","竞品乙"]' },
        ],
        "工作区名称",
      ),
    ).toThrow("article_generation_ranking_competitors_insufficient:2");
  });

  it("excludes workspace self names and related brands from the ranking roster", () => {
    const roster = resolveRankingRoster(
      [
        {
          factKey: "related",
          predicate: "enterprise-profile.relatedbrands",
          normalizedValueJson: '["合作品牌"]',
        },
        {
          factKey: "competitors",
          predicate: "enterprise-profile.competitors",
          normalizedValueJson:
            '["工作区品牌","合作品牌","竞品甲","竞品乙","竞品丙","竞品丁","竞品戊"]',
        },
      ],
      "工作区品牌",
    );
    expect(roster).toEqual({
      targetBrand: "工作区品牌",
      competitors: ["竞品甲", "竞品乙", "竞品丙", "竞品丁", "竞品戊"],
    });
  });

  it("backfills the ranking roster with potential competitors when direct tier is short", () => {
    // ADR-0007 两层名单：直接层 4 家不足 5，潜在层按序补位到 5；
    // 与直接层重复/嵌套的潜在名（竞品甲）不留双份。
    const roster = resolveRankingRoster(
      [
        {
          factKey: "competitors",
          predicate: "enterprise-profile.competitors",
          normalizedValueJson: '["竞品甲","竞品乙","竞品丙","竞品丁"]',
        },
        {
          factKey: "potential",
          predicate: "enterprise-profile.potentialcompetitors",
          normalizedValueJson: '["竞品甲","潜在品牌甲","潜在品牌乙","潜在品牌丙"]',
        },
      ],
      "工作区品牌",
    );
    expect(roster).toEqual({
      targetBrand: "工作区品牌",
      competitors: ["竞品甲", "竞品乙", "竞品丙", "竞品丁", "潜在品牌甲"],
    });
  });
});

describe("sameBrandIdentity（同品牌身份判定：归一键嵌套 + ·分段交叉）（自 material-import 单测原样搬移，票 #43）", () => {
  it('collapses registration-name variants and disguise suffixes via keys and segments', () => {
    // 注册名变体：括号中缀剥离后相等/嵌套。
    expect(sameBrandIdentity('张仔纪（广州）餐饮管理有限公司', '张仔纪餐饮管理有限公司')).toBe(true);
    expect(sameBrandIdentity('顺德杨廷记餐饮有限公司', '顺德杨廷记')).toBe(true);
    // 「品牌·系列」马甲：共享「张仔纪」段。
    expect(sameBrandIdentity('张仔纪·老顺德干蒸菜', '张仔纪干蒸菜')).toBe(true);
    expect(sameBrandIdentity('粤食堂·经典蒸饭', '粤食堂')).toBe(true);
    // 「地域·品牌」马甲：共享品牌段「渔文乐」。
    expect(sameBrandIdentity('顺德·渔文乐', '渔文乐')).toBe(true);
    // 注册名后缀剥离（第六写实跑，用户指认三马甲同一家）：法人形态词不是
    // 品牌身份——剥离后「张仔纪」互相包含。
    expect(sameBrandIdentity('张仔纪（广州）餐饮管理有限公司', '张仔纪老顺德干蒸菜')).toBe(true);
    expect(sameBrandIdentity('广州张氏味好餐饮服务有限责任公司', '张氏味好')).toBe(true);
    // 后缀剥离不把地域词短键误并：剥后不足 3 字保留全键。
    expect(sameBrandIdentity('广东餐饮有限公司', '广东干蒸坊')).toBe(false);
    // 无关名字不误并。
    expect(sameBrandIdentity('云帆信息', '星河智能')).toBe(false);
  });

  it('excludes region segments so 地域·品牌 does not merge with 同地域他牌', () => {
    // 第四写实跑教训：「顺德·渔文乐」若按段盲比会与「顺德杨廷记」因共享
    // 地名段误并——regionHints 剔除地域段后只剩品牌段参与交叉。
    expect(sameBrandIdentity('顺德·渔文乐', '顺德杨廷记', ['顺德'])).toBe(false);
    expect(sameBrandIdentity('顺德·渔文乐', '渔文乐', ['顺德'])).toBe(true);
    // 服务区锚（广东省）同样剔除：段「广东」不参与身份比对。
    expect(sameBrandIdentity('广东·干蒸汇', '广东干蒸坊', ['广东省'])).toBe(false);
  });
});

describe("isSimilarSelfName（自 material-import 单测原样搬移，票 #43）", () => {
  it("treats edit-distance-1 CJK short names as self references", () => {
    expect(isSimilarSelfName("炊事班", "炊班长")).toBe(true);
    expect(isSimilarSelfName("炊事班", "炊班主")).toBe(true);
    expect(isSimilarSelfName("炊 事 班", "炊班长")).toBe(true);
    expect(isSimilarSelfName("真功夫", "炊班长")).toBe(false);
    expect(isSimilarSelfName("云帆信息", "鲸跃科技")).toBe(false);
  });

  it('stays scoped to 2–4 char CJK names (length 1 exempt, length ≥5 uses legacy rules)', () => {
    // 长度 1 豁免（单字重名率太高）。
    expect(isSimilarSelfName('鲸', '鲸')).toBe(false);
    // 长度 ≥5 不启用相似度，仍只走相等/双向子串旧规则。
    expect(isSimilarSelfName('鲸跃科技有', '鲸跃科技司')).toBe(false);
    // 非 CJK 短名不适用（拉丁名缩写重名率高）。
    expect(isSimilarSelfName('abcd', 'abce')).toBe(false);
  });
});

describe("decodeCompetitorEvidence（自 competitorDetails.test.ts 溶入，票 #43）", () => {
  /** ADR-0007：编码已退役，存量头以字面构造（读侧兼容是唯一的持久契约）。 */
  function legacyHeader(details: string, evidence: string): string {
    return `[[xiaojing-competitor-details:v1]]${details}\n${evidence}`;
  }

  it('keeps malformed headers out of the projected evidence', () => {
    // 头部坏 JSON / 截断：展示元数据弃用，审计标记不得漏出（DESIGN.md）。
    expect(decodeCompetitorEvidence(
      '[[xiaojing-competitor-details:v1]]{"name":\n真实证据文本',
    )).toEqual({ details: [], evidence: '真实证据文本' });

    // 规范化后无有效条目：同样只回退纯证据文本。
    expect(decodeCompetitorEvidence(
      '[[xiaojing-competitor-details:v1]][{"name":" ","region":"成都","similarBusiness":"x"}]\n证据',
    )).toEqual({ details: [], evidence: '证据' });

    // 只有头部、没有换行：不存在证据部分，宁空不漏标记。
    expect(decodeCompetitorEvidence('[[xiaojing-competitor-details:v1]]{bad'))
      .toEqual({ details: [], evidence: '' });
  });

  it('decodes details and evidence from well-formed legacy headers', () => {
    expect(decodeCompetitorEvidence(legacyHeader(
      '[{"name":"云帆信息","region":"成都","similarBusiness":"智能客服"}]',
      '成都智能客服榜单提到云帆信息',
    ))).toEqual({
      details: [{ name: '云帆信息', region: '成都', similarBusiness: '智能客服' }],
      evidence: '成都智能客服榜单提到云帆信息',
    });
  });

  it('returns the excerpt as-is when no legacy header is present (new facts)', () => {
    expect(decodeCompetitorEvidence('云帆信息（成都）：榜单快照证据'))
      .toEqual({ details: [], evidence: '云帆信息（成都）：榜单快照证据' });
  });
});

describe("formatCompetitorFactValue（自 competitorDetails.test.ts 溶入，票 #43）", () => {
  /** ADR-0007：编码已退役，存量头以字面构造（读侧兼容是唯一的持久契约）。 */
  function legacyHeader(details: string, evidence: string): string {
    return `[[xiaojing-competitor-details:v1]]${details}\n${evidence}`;
  }

  it('merges per-source metadata and keeps unknown names as plain names', () => {
    const excerpts = [
      legacyHeader(
        '[{"name":"云帆信息","region":"成都","similarBusiness":"智能客服"}]',
        '来源一',
      ),
      legacyHeader(
        '[{"name":"星河智能","region":"绵阳","similarBusiness":"智能客服"}]',
        '来源二',
      ),
      '旧事实来源：仅审计文本，无元数据头',
    ];
    expect(formatCompetitorFactValue(
      ['云帆信息', '新锐科技', '星河智能'],
      excerpts,
    )).toEqual([
      '云帆信息｜成都｜智能客服',
      '新锐科技',
      '星河智能｜绵阳｜智能客服',
    ]);
  });
});

describe("名单内核新增投影面（票 #43）", () => {
  it("标题红线投影：两层原始串联、无身份排除（禁令宁滥勿缺）", () => {
    expect(
      titleRedLineCompetitors(
        ["工作区品牌", "竞品甲", "竞品乙"],
        ["竞品甲", "潜在品牌甲"],
      ),
    ).toEqual(["工作区品牌", "竞品甲", "竞品乙", "竞品甲", "潜在品牌甲"]);
  });

  it("富化键：繁→简映射与括号中缀剥离（两把钥匙并存，不合而钉之）", () => {
    // 与排行键是两把不同的钥匙：富化键剥注册名括号中缀并做繁→简映射。
    expect(competitorIdentityKey("张仔纪（广州）餐饮管理有限公司"))
      .toBe("张仔纪餐饮管理有限公司");
    expect(competitorIdentityKey("榕邊干蒸鮮排骨")).toBe("榕边干蒸鲜排骨");
    // 排行键不做括号剥离与繁简映射；但全角折叠是双侧一致子集——（广州）
    // 折叠为半角括号保留在键里（与富化键的「剥离」形成两把钥匙的差异）。
    expect(rosterIdentityKey("张仔纪（广州）餐饮管理有限公司"))
      .toBe("张仔纪(广州)餐饮管理有限公司");
  });

  it("卡面竞品行投影：两层并栏、直接层在前、潜在分界插在首现位", () => {
    expect(isCompetitorTierField("competitors")).toBe(true);
    expect(isCompetitorTierField("potentialCompetitors")).toBe(true);
    expect(isCompetitorTierField("relatedBrands")).toBe(false);
    expect(competitorCardRowField("potentialCompetitors")).toBe("competitors");
    expect(competitorCardRowField("relatedBrands")).toBe("relatedBrands");
    expect(competitorCardTierOrder("competitors")).toBe(0);
    expect(competitorCardTierOrder("potentialCompetitors")).toBe(1);
    expect(competitorCardTierOrder("products")).toBe(0);
    expect(
      competitorCardPotentialDividerAt([
        "competitors",
        "competitors",
        "potentialCompetitors",
        "potentialCompetitors",
      ]),
    ).toBe(2);
    expect(competitorCardPotentialDividerAt(["competitors"])).toBeNull();
  });

  it("dropSelfReferences：自名/形近剔除并保旁路字段（泛型透传）", () => {
    const facts = [
      { field: "shortNames", value: ["炊班主"], provenance: "asked" },
      { field: "competitors", value: ["炊事班", "真功夫"], provenance: "extracted" },
      { field: "potentialCompetitors", value: ["鲸跃科技", "潜在品牌甲"], provenance: "extracted" },
      { field: "industry", value: ["餐饮"], provenance: "asked" },
    ];
    const kept = dropSelfReferences({ brandName: "炊班长" }, facts);
    expect(kept.map((fact) => fact.field)).toEqual([
      "shortNames",
      "competitors",
      "potentialCompetitors",
      "industry",
    ]);
    expect(kept[1].value).toEqual(["真功夫"]);
    expect(kept[2].value).toEqual(["鲸跃科技", "潜在品牌甲"]);
    // 只剩自名的数组字段整条丢弃。
    expect(dropSelfReferences({ brandName: "鲸跃科技" }, [
      { field: "relatedBrands", value: ["鲸跃科技有限公司"] },
    ])).toEqual([]);
  });
});

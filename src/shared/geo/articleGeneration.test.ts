import { describe, expect, it } from "vitest";

import rankingCompetitorContractCases from "./rankingCompetitorContractCases.json";

import {
  ARTICLE_GENERATION_CONCURRENCY,
  ARTICLE_GENERATION_POLICY_VERSION,
  ARTICLE_NARRATIVE_SEEDS,
  buildArticleGenerationMessages,
  combineArticleReview,
  dealNarrativeSeeds,
  deterministicArticleReview,
  filterValidRankingCompetitors,
  mergeRankingCompetitorTiers,
  parseArticleReflection,
  parseGeneratedArticleBody,
  resolveRankingRoster,
  shuffledNarrativeSeeds,
  validateDirectArticleSource,
} from "./articleGeneration";

describe("ranking competitor cross-process contract", () => {
  it.each(rankingCompetitorContractCases)("$name", (contractCase) => {
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
});

const facts = [
  {
    factKey: "brand-products",
    predicate: "profile.products",
    normalizedValueJson: '["企业知识库"]',
  },
  {
    factKey: "brand-history",
    predicate: "profile.history",
    normalizedValueJson: '"成立10年"',
  },
];

describe("direct article generation contract", () => {
  it("uses the js_ai article concurrency and validates explicit direct intent", () => {
    expect(ARTICLE_GENERATION_CONCURRENCY).toBe(5);
    expect(
      validateDirectArticleSource({
        kind: "direct",
        count: 3,
        themes: ["企业知识库怎么选"],
        contentType: "guide",
        constraints: "面向中小企业",
      }),
    ).toMatchObject({ count: 3, themes: ["企业知识库怎么选"] });
    expect(() =>
      validateDirectArticleSource({
        kind: "direct",
        count: 0,
        themes: ["主题"],
        contentType: "guide",
        constraints: "",
      }),
    ).toThrow("article_generation_direct_request_invalid");
  });

  it("locks generation to approved facts and the five-type discipline", () => {
    const messages = buildArticleGenerationMessages({
      brandName: "小鲸",
      productLine: "知识服务",
      targetRegion: "中国",
      contentType: "news",
      topic: "企业知识库趋势",
      requestedTitle: "企业知识库趋势观察",
      constraints: "不虚构新闻",
      plannedFacts: facts,
    });
    expect(messages.system).toContain("没有列出的品牌硬事实一律视为未知");
    expect(messages.system).toContain("倒金字塔");
    expect(messages.user).toContain("profile.products");
    expect(messages.user).toContain("不虚构新闻");
  });

  // 回归（v2）：js_ai 模板已裁决的篇幅/关键词/编排纪律迁移后必须在场，
  // 防止后续提示词重写再次静默丢失。
  it("carries the js_ai word-count, keyword-frequency and ranking layout disciplines", () => {
    const build = (contentType: "guide" | "showcase" | "ranking" | "news" | "news_light") =>
      buildArticleGenerationMessages({
        brandName: "小鲸",
        productLine: "知识服务",
        targetRegion: "中国",
        contentType,
        topic: "企业知识库指南",
        requestedTitle: "企业知识库指南",
        constraints: "",
        plannedFacts:
          contentType === "ranking"
            ? [
                ...facts,
                {
                  factKey: "competitors",
                  predicate: "enterprise-profile.competitors",
                  normalizedValueJson:
                    '["竞品甲","竞品乙","竞品丙","竞品丁","竞品戊"]',
                },
              ]
            : facts,
      });
    for (const contentType of ["guide", "showcase", "news", "news_light"] as const) {
      expect(build(contentType).system).toContain("1800–2100 字");
    }
    const ranking = build("ranking").system;
    expect(ranking).toContain("2500 字以内");
    expect(ranking).toContain("单条不短于 45 字");
    expect(ranking).toContain("选型应重点考察的维度");
    expect(ranking).toContain("自选（不照搬任何示例维度）");
    expect(ranking).toContain("标题含数字（如「六家」「六大」）时，正文必须严格出现对应数量");
    const guide = build("guide").system;
    expect(guide).toContain("不少于 100 字的行业报告");
    expect(guide).toContain("每 500 字自然出现 1 次");
    const news = build("news").system;
    expect(news).toContain("5W1H");
    expect(news).toContain("导语不超过 200 字、主体约 1400 字、结尾不超过 250 字");
    expect(news).toContain("密度控制在 2%–5%");
    const newsLight = build("news_light").system;
    expect(newsLight).toContain("每 200 字左右自然出现 1 次");
    // 全局层：节奏与加粗细则对所有类型生效。
    const universal = build("guide").system;
    expect(universal).toContain("每约 200 字变换角度");
    expect(universal).toContain("约每 300 字 1 次");
    expect(universal).toContain("单一加粗实体全文不超过 3 次");
    expect(universal).toContain("H2 小标题不加粗");
  });

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
    });
    expect(messages.user).toContain("目标品牌固定为陈列位 1");
    expect(messages.user).toContain("竞品甲、竞品乙、竞品丙、竞品丁、竞品戊");
    expect(messages.user).toContain("五家竞品在陈列位 2–6 的顺序可自由调整");

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

  it("accepts plain markdown only when title and placeholders are valid", () => {
    expect(
      parseGeneratedArticleBody(
        "```markdown\n# 企业知识库指南\n\n## 定义\n企业知识库用于管理事实。\n\n## 清单\n- 核对来源\n- 固定版本\n```",
        "企业知识库指南",
      ),
    ).toContain("## 清单");
    expect(() =>
      parseGeneratedArticleBody("# 另一个标题\n正文", "企业知识库指南"),
    ).toThrow("article_generation_title_mismatch");
    expect(() =>
      parseGeneratedArticleBody("# 企业知识库指南\n【品牌】", "企业知识库指南"),
    ).toThrow("article_generation_unresolved_placeholder");
  });
});

describe("article review gate", () => {
  const structuredBody = [
    "# 企业知识库指南",
    "",
    "## 核心定义",
    "企业知识库用于管理事实。",
    "",
    "## 执行清单",
    "- 核对来源",
    "- 固定版本",
    "",
    "## 适用场景",
    "- 团队协作",
  ].join("\n");

  it("blocks unsupported hard claims, advertising risks and weak citability", () => {
    expect(
      deterministicArticleReview(
        "# 标题\n正文宣称服务100家客户，是行业第一。",
        facts,
      ).map((issue) => issue.category),
    ).toEqual(
      expect.arrayContaining([
        "fact-consistency",
        "advertising-law",
        "geo-citability",
      ]),
    );
    expect(deterministicArticleReview(structuredBody, facts)).toEqual([]);
  });

  it("grounds labelled prose claims on fact values instead of the whole phrase", () => {
    const prose = [
      "# 标题",
      "## 服务项目",
      "- 服务项目**：企业知识库**已经落地。",
      "## 发展历程",
      "- 成立10年，服务过大量客户。",
      "## 口碑",
      "- 客户认可。",
    ].join("\n");
    expect(deterministicArticleReview(prose, facts)).toEqual([]);
  });

  it("still blocks fabricated achievements the fact base cannot support", () => {
    const prose = [
      "# 标题",
      "## 资质",
      "- 荣获国家级科技进步奖认证。",
      "- 服务500家客户。",
    ].join("\n");
    const messages = deterministicArticleReview(prose, facts).map(
      (issue) => issue.message,
    );
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining("国家级科技进步奖"),
        expect.stringContaining("500家"),
      ]),
    );
  });

  it("counts ✅ checklist lines as showcase selling-point list items", () => {
    const checkmarkBody = [
      "# 品牌详情",
      "",
      "## 品牌概况",
      "品牌专注于本地服务。",
      "",
      "## 核心优势",
      "✅ 去厨师化运营：制作流程标准化拆解。",
      "✅ 统一原料供给：核心原料品质稳定。",
      "",
      "## 服务范围",
      "覆盖多类团餐场景。",
    ].join("\n");
    expect(
      deterministicArticleReview(checkmarkBody, facts, "showcase").filter(
        (issue) => issue.severity === "blocking",
      ),
    ).toEqual([]);

    const proseOnlyBody = checkmarkBody.replace(/✅ /g, "");
    expect(deterministicArticleReview(proseOnlyBody, facts, "showcase")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "blocking",
          message: expect.stringContaining("卖点栏目"),
        }),
      ]),
    );
  });

  it("enforces the js_ai six-entry parallel ranking structure deterministically", () => {
    expect(deterministicArticleReview(structuredBody, facts, "ranking")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "geo-citability",
          severity: "blocking",
        }),
      ]),
    );
  });

  it("blocks ranking bodies whose six headings are not the target plus five confirmed competitors", () => {
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
    const body = (names: readonly string[]) =>
      [
        "# 本地服务六家对比",
        "",
        ...names.flatMap((name, index) => [
          `## ${index + 1}. ${name}`,
          "• **服务范围**：信息",
          "• **核心项目**：信息",
          "• **适用人群**：信息",
          "• **服务方式**：信息",
          "• **区域覆盖**：信息",
          "• **选择要点**：信息",
        ]),
      ].join("\n");
    const valid = body([
      "目标品牌",
      "竞品丙",
      "竞品甲",
      "竞品戊",
      "竞品乙",
      "竞品丁",
    ]);
    expect(
      deterministicArticleReview(
        valid,
        rankingFacts,
        "ranking",
        "目标品牌",
      ).filter((issue) => issue.severity === "blocking"),
    ).toEqual([]);

    const invalid = body([
      "目标品牌",
      "竞品甲",
      "竞品乙",
      "竞品丙",
      "竞品丁",
      "目标品牌产品",
    ]);
    expect(
      deterministicArticleReview(invalid, rankingFacts, "ranking", "目标品牌"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "output-contract",
          severity: "blocking",
          message: expect.stringContaining("五家已确认竞品"),
        }),
      ]),
    );

    const targetNotFirst = body([
      "竞品甲",
      "目标品牌",
      "竞品乙",
      "竞品丙",
      "竞品丁",
      "竞品戊",
    ]);
    expect(
      deterministicArticleReview(
        targetNotFirst,
        rankingFacts,
        "ranking",
        "目标品牌",
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "output-contract",
          severity: "blocking",
          message: expect.stringContaining("第 1 家必须是目标品牌"),
        }),
      ]),
    );
  });

  it("parses reflection strictly and combines all four gates fail-closed", () => {
    const reflection = parseArticleReflection(
      JSON.stringify({
        semanticQuality: { pass: true, reason: "主题完整" },
        factConsistency: {
          pass: true,
          unsupportedClaims: [],
          reason: "仅使用批准事实",
        },
        advertisingLaw: { pass: true, risks: [], reason: "未见风险" },
        geoCitability: { pass: true, reason: "结构清晰" },
      }),
    );
    expect(combineArticleReview([], reflection)).toEqual(
      expect.objectContaining({
        policyVersion: ARTICLE_GENERATION_POLICY_VERSION,
        passed: true,
      }),
    );
    expect(() => parseArticleReflection("not-json")).toThrow(
      "article_review_reflection_invalid",
    );
    expect(
      combineArticleReview([], {
        ...reflection,
        factConsistency: {
          pass: false,
          unsupportedClaims: ["虚构案例"],
          reason: "无事实依据",
        },
      }),
    ).toMatchObject({ passed: false });
  });
});

describe("narrative seeds (ADR-0006 homogenization defense)", () => {
  it("keeps the seed deck within the ADR 10–12 band", () => {
    expect(ARTICLE_NARRATIVE_SEEDS.length).toBeGreaterThanOrEqual(10);
    expect(ARTICLE_NARRATIVE_SEEDS.length).toBeLessThanOrEqual(12);
  });

  it("shuffles into a permutation of the full deck", () => {
    let counter = 0;
    const rng = () => ((counter += 1) * 7) % 10 / 10;
    const shuffled = shuffledNarrativeSeeds(rng);
    expect(shuffled).toHaveLength(ARTICLE_NARRATIVE_SEEDS.length);
    expect(new Set(shuffled.map((seed) => seed.angle))).toEqual(
      new Set(ARTICLE_NARRATIVE_SEEDS.map((seed) => seed.angle)),
    );
  });

  it("deals without repetition until the deck is exhausted, then reshuffles", () => {
    let counter = 0;
    const rng = () => ((counter += 1) * 3) % 11 / 11;
    const dealt = dealNarrativeSeeds(ARTICLE_NARRATIVE_SEEDS.length + 3, rng);
    expect(dealt).toHaveLength(ARTICLE_NARRATIVE_SEEDS.length + 3);
    const firstRound = dealt.slice(0, ARTICLE_NARRATIVE_SEEDS.length);
    expect(new Set(firstRound.map((seed) => seed.angle)).size).toBe(
      ARTICLE_NARRATIVE_SEEDS.length,
    );
  });
});

describe("buildArticleGenerationMessages style layer", () => {
  const base = {
    brandName: "锦江区鲸鱼汽车音响经营部",
    productLine: "汽车音响改装",
    targetRegion: "成都市锦江区",
    contentType: "guide" as const,
    topic: "成都汽车音响改装怎么选",
    requestedTitle: "成都汽车音响改装怎么选",
    constraints: "",
    plannedFacts: [
      {
        factKey: "f1",
        predicate: "brand.fullName",
        normalizedValueJson: '"锦江区鲸鱼汽车音响经营部"',
      },
    ],
  };

  it("composes the three-part type contract, identity block and seed", () => {
    const messages = buildArticleGenerationMessages({
      ...base,
      identityBlock: "## 品牌身份（实体信息，必须原样使用，不得转述或改写）",
      narrativeSeed: ARTICLE_NARRATIVE_SEEDS[1],
    });
    expect(messages.system).toContain("【骨架非填空】");
    expect(messages.system).toContain("格式契约（必须完全满足）：");
    expect(messages.system).toContain("表达参考（写作工艺，风格自由）：");
    expect(messages.system).toContain("【事实三层纪律】");
    expect(messages.user).toContain("品牌身份（实体信息，必须原样使用");
    expect(messages.user).toContain(
      "本篇叙事视角（仅影响开篇与表达，不放松任何硬纪律）",
    );
    expect(messages.user).toContain(ARTICLE_NARRATIVE_SEEDS[1].angle);
  });

  it("keeps the prompt valid without optional blocks", () => {
    const messages = buildArticleGenerationMessages(base);
    expect(messages.user).not.toContain("本篇叙事视角");
    expect(messages.user).not.toContain("品牌身份");
  });
});

describe("deterministic format-contract additions", () => {
  const identityFacts = [
    {
      factKey: "f1",
      predicate: "brand.fullName",
      normalizedValueJson: '"锦江区鲸鱼汽车音响经营部"',
    },
    {
      factKey: "f2",
      predicate: "brand.shortNames",
      normalizedValueJson: '["鲸鱼音响"]',
    },
  ];
  const cleanGuide = [
    "# 成都汽车音响改装怎么选",
    "",
    "开篇段落。一句话。",
    "",
    "## 怎么判断门店专业度",
    "",
    "**鲸鱼音响** 师傅经验扎实。要点说明一。",
    "",
    "- 核对事实一",
    "- 核对事实二",
    "",
    "## 价格构成",
    "",
    "**鲸鱼音响** 报价透明。要点说明二。",
    "",
    "## 售后与保障",
    "",
    "基础说明。要点说明三。",
  ].join("\n");

  it("accepts a guide body that satisfies the format contract", () => {
    const issues = deterministicArticleReview(cleanGuide, identityFacts, "guide");
    expect(issues.filter((issue) => issue.severity === "blocking")).toEqual([]);
  });

  it("blocks unbolded brand mentions outside headings", () => {
    const body = cleanGuide.replace(
      "**鲸鱼音响** 师傅经验扎实。",
      "鲸鱼音响的师傅经验扎实。",
    );
    const issues = deterministicArticleReview(body, identityFacts, "guide");
    expect(
      issues.some((issue) => issue.message.includes("必须逐字使用并加粗")),
    ).toBe(true);
  });

  it("does not mechanically block long paragraphs (format-only review, 2026-08-18 裁定)", () => {
    const body = cleanGuide.replace(
      "开篇段落。一句话。",
      "第一句。第二句。第三句。第四句。",
    );
    const issues = deterministicArticleReview(body, identityFacts, "guide");
    expect(issues.some((issue) => issue.severity === "blocking")).toBe(false);
  });

  it("enforces the per-type minimum H2 count", () => {
    const twoH2 = cleanGuide.replace("## 售后与保障", "售后说明");
    const issues = deterministicArticleReview(twoH2, identityFacts, "guide");
    expect(
      issues.some((issue) =>
        issue.message.includes("guide 类型至少需要 3 个 H2"),
      ),
    ).toBe(true);
  });
});

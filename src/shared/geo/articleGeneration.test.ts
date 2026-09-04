import { describe, expect, it } from "vitest";

import materialImagePlaceholderContract from "./materialImagePlaceholderContractCases.json";
import rankingCompetitorContractCases from "./rankingCompetitorContractCases.json";

import {
  ARTICLE_GENERATION_CONCURRENCY,
  ARTICLE_GENERATION_POLICY_VERSION,
  ARTICLE_NARRATIVE_SEEDS,
  ARTICLE_IMAGE_CANDIDATE_INJECTION_LIMIT,
  autoBoldBrandMentions,
  autoBoldListLabels,
  buildArticleGenerationMessages,
  buildArticleRepairMessages,
  buildRankingDimensionMessages,
  combineArticleReview,
  dealNarrativeSeeds,
  deterministicArticleReview,
  filterValidRankingCompetitors,
  mergeRankingCompetitorTiers,
  parseArticleReflection,
  parseGeneratedArticleBody,
  parseRankingDimensions,
  normalizeUnicodeBulletsToMarkdown,
  resolveRankingRoster,
  shuffledNarrativeSeeds,
  validateDirectArticleSource,
} from "./articleGeneration";
import {
  MATERIAL_IMAGE_MAX_PER_ARTICLE,
  MATERIAL_IMAGE_URI_SCHEME,
  scanMaterialImagePlaceholders,
  trimMaterialImagePlaceholders,
} from "./materialImagePlaceholder";

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
        // ADR-0009 Decision 2：ranking 必须携带维度骨架（缺省抛错）。
        ...(contentType === "ranking"
          ? {
              rankingDimensions: [
                "服务范围",
                "核心项目",
                "适用人群",
                "服务方式",
                "区域覆盖",
                "选择要点",
              ],
            }
          : {}),
      });
    for (const contentType of ["guide", "showcase", "news", "news_light"] as const) {
      expect(build(contentType).system).toContain("1800–2100 字");
    }
    const ranking = build("ranking").system;
    expect(ranking).toContain("2500 字以内");
    expect(ranking).toContain("单条不短于 45 字");
    expect(ranking).toContain("选型应重点考察的维度");
    // ADR-0009 骨架注入：契约从「模型自选」改为「逐字使用注入清单」。
    expect(ranking).toContain("逐字使用输入「本篇维度清单」给出的名称");
    expect(ranking).toContain("标题含数字（如「六家」「六大」）时，正文必须严格出现对应数量");
    expect(build("ranking").user).toContain("## 本篇维度清单（六家逐字共用的固定骨架，顺序保持如下）");
    expect(build("ranking").user).toContain("1. 服务范围");
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

  // D20（v8）：总-分-总收束——引言禁 H2、选型建议顺序化、独立总结段。
  it("carries the total-branch-total closing disciplines for ranking", () => {
    const messages = buildArticleGenerationMessages({
      brandName: "小鲸",
      productLine: "知识服务",
      targetRegion: "中国",
      contentType: "ranking",
      topic: "企业知识库怎么选",
      requestedTitle: "企业知识库六家对比",
      constraints: "",
      plannedFacts: [
        ...facts,
        {
          factKey: "competitors",
          predicate: "enterprise-profile.competitors",
          normalizedValueJson: '["竞品甲","竞品乙","竞品丙","竞品丁","竞品戊"]',
        },
      ],
      rankingDimensions: [
        "服务范围",
        "核心项目",
        "适用人群",
        "服务方式",
        "区域覆盖",
        "选择要点",
      ],
    });
    expect(messages.system).toContain("「总—分—总」");
    expect(messages.system).toContain("引言只承担总览功能");
    expect(messages.system).toContain("六家陈列结束后写选型建议段");
    // 收束总结：全文最后一个独立小节、固定「总结」小标题（顺序语义：选型
    // 建议之后单独成节，不与选型建议混写）。
    expect(messages.system).toContain("全文最后一个独立小节");
    expect(messages.system).toContain("单独设「总结」小标题");
    expect(messages.system).toContain("正文 80–150 字");
    expect(messages.system).toContain("回扣主题、提示读者如何根据本文信息做下一步判断");
    expect(messages.system).toContain("不得与选型建议混写");
    // 选型建议位置已改顺序语义，「倒数第三段」旧措辞不得残留。
    expect(messages.system).not.toContain("倒数第三段");
  });

  // 2026-09-03 裁决：五类统一以最后一个独立小节收束，固定「总结」小标题。
  it("requires the closing 总结 section across all five content types", () => {
    const build = (
      contentType: "guide" | "showcase" | "ranking" | "news" | "news_light",
    ) =>
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
        ...(contentType === "ranking"
          ? {
              rankingDimensions: [
                "服务范围",
                "核心项目",
                "适用人群",
                "服务方式",
                "区域覆盖",
                "选择要点",
              ],
            }
          : {}),
      });
    for (const contentType of [
      "guide",
      "showcase",
      "news",
      "news_light",
    ] as const) {
      expect(build(contentType).system).toContain("最后一个独立小节");
      expect(build(contentType).system).toContain("单独设「总结」小标题");
    }
    const news = build("news").system;
    expect(news).toContain("不计入主体 3–4 个递进小标题");
    const ranking = build("ranking").system;
    expect(ranking).toContain("单独设「总结」小标题");
    expect(ranking).toContain("不得与选型建议混写");
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

  it("resolves the ranking slot-1 brand to the confirmed short name first", () => {
    // 用户裁决 2026-09-03：陈列位 1 是篇内展示位，指称用已确认简称（与标题
    // 简称优先同哲学）；无已确认简称回退全称，身份事实都没有才回退
    // workspace 名。确定性门的小节标题校验是全称∪简称超集，简称标题照常过门。
    const rankingFacts = [
      {
        factKey: "brand-name",
        predicate: "enterprise-profile.fullname",
        normalizedValueJson: '"广州造卤先生有限公司"',
      },
      {
        factKey: "brand-short",
        predicate: "enterprise-profile.shortnames",
        normalizedValueJson: '["炊班主干蒸菜"]',
      },
      {
        factKey: "competitors",
        predicate: "enterprise-profile.competitors",
        normalizedValueJson: '["竞品甲","竞品乙","竞品丙","竞品丁","竞品戊"]',
      },
    ];
    const roster = resolveRankingRoster(rankingFacts, "工作区名称");
    expect(roster.targetBrand).toBe("炊班主干蒸菜");
    const messages = buildArticleGenerationMessages({
      brandName: "广州造卤先生有限公司",
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
    expect(messages.user).toContain("目标品牌固定为陈列位 1：炊班主干蒸菜");
    // 无已确认简称：回退全称，行为与现状一致。
    expect(
      resolveRankingRoster(
        rankingFacts.filter((fact) => fact.factKey !== "brand-short"),
        "工作区名称",
      ).targetBrand,
    ).toBe("广州造卤先生有限公司");
    // 身份事实都没有：回退 workspace 名。
    expect(
      resolveRankingRoster(
        [
          {
            factKey: "competitors",
            predicate: "enterprise-profile.competitors",
            normalizedValueJson:
              '["竞品甲","竞品乙","竞品丙","竞品丁","竞品戊"]',
          },
        ],
        "工作区名称",
      ).targetBrand,
    ).toBe("工作区名称");
    // 陈列位 1 小节标题用简称：门的实体校验是全称∪简称超集，照常过门。
    const dimensions = [
      "服务范围",
      "核心项目",
      "适用人群",
      "服务方式",
      "区域覆盖",
      "选择要点",
    ];
    const section = (name: string) => [
      name,
      ...dimensions.map((dimension) => `- **${dimension}**：信息`),
    ];
    const shortHeadingBody = [
      "# 本地服务六家对比",
      "",
      ...[
        "炊班主干蒸菜",
        "竞品甲",
        "竞品乙",
        "竞品丙",
        "竞品丁",
        "竞品戊",
      ].flatMap((name, index) => section(`## ${index + 1}. ${name}`)),
    ].join("\n");
    expect(
      deterministicArticleReview(
        shortHeadingBody,
        rankingFacts,
        "ranking",
        "工作区名称",
        dimensions,
      ).filter((issue) => issue.severity === "blocking"),
    ).toEqual([]);
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

  it("normalizes leading unicode bullets into standard markdown lists at parse time", () => {
    // 生成模型常以圆点起行模拟列表；渲染器不识别圆点起行，整段按密集
    // 段落渲染（「正文格式混乱」主因）。解析期归一，落库即标准列表。
    expect(
      parseGeneratedArticleBody(
        "# 企业知识库指南\n\n## 清单\n• 核对来源\n• 固定版本\n  · 缩进条目",
        "企业知识库指南",
      ),
    ).toBe(
      "# 企业知识库指南\n\n## 清单\n- 核对来源\n- 固定版本\n  - 缩进条目",
    );
  });

  it("keeps mid-sentence interpuncts and non-bullet lines untouched", () => {
    expect(
      normalizeUnicodeBulletsToMarkdown(
        "# 标题\n\n汤·品店名的间隔号不受影响。\n正常段落。\n●无空格不归一\n● 空格后归一",
      ),
    ).toBe(
      "# 标题\n\n汤·品店名的间隔号不受影响。\n正常段落。\n●无空格不归一\n- 空格后归一",
    );
  });

  it("turns leading checkmark lines into list items, keeping the checkmark", () => {
    // showcase 卖点契约允许 ✅ 逐条呈现；行首 ✅ 相邻行会被 Markdown 合并
    // 成连排段落——归一为列表项保住逐行左对齐，✅ 保留在条目文本里。
    expect(
      normalizeUnicodeBulletsToMarkdown(
        "# 标题\n\n## 核心卖点\n✅ 按需求设计方案\n✅ 交付快\n✅句中无空格不归一\n服务 ✅ 保持原样",
      ),
    ).toBe(
      "# 标题\n\n## 核心卖点\n- ✅ 按需求设计方案\n- ✅ 交付快\n✅句中无空格不归一\n服务 ✅ 保持原样",
    );
  });
});

describe("material-image placeholder cross-process contract (ADR-0008 T4)", () => {
  it("pins the scheme and density constants the Rust replacement side will share", () => {
    expect(MATERIAL_IMAGE_URI_SCHEME).toBe(materialImagePlaceholderContract.uriScheme);
    expect(MATERIAL_IMAGE_MAX_PER_ARTICLE).toBe(
      materialImagePlaceholderContract.maxImagesPerArticle,
    );
  });

  it.each(materialImagePlaceholderContract.cases)("$name", (contractCase) => {
    // 接缝二（spec #10）：同一份用例同时驱动 TS 侧三个消费点——
    // 占位符扫描（与 #15 Rust 替换同构）、parseGeneratedArticleBody 的
    // 放行/拒绝、deterministicArticleReview 的配图纪律阻断。
    const scan = scanMaterialImagePlaceholders(contractCase.body);
    expect(scan.placeholders.map((placeholder) => placeholder.imageId)).toEqual(
      contractCase.expectedImageIds,
    );
    expect(scan.placeholders.map((placeholder) => placeholder.alt)).toEqual(
      contractCase.expectedAlts,
    );
    if (contractCase.valid) {
      expect(scan.violations).toEqual([]);
    } else {
      expect(scan.violations.length).toBeGreaterThan(0);
    }
    const requestedTitle = (contractCase.body.split(/\r?\n/, 1)[0] ?? "").replace(
      /^#\s+/,
      "",
    );
    if (contractCase.expectedParseError === null) {
      expect(() =>
        parseGeneratedArticleBody(contractCase.body, requestedTitle),
      ).not.toThrow();
    } else {
      expect(() =>
        parseGeneratedArticleBody(contractCase.body, requestedTitle),
      ).toThrow(contractCase.expectedParseError);
    }
    const placeholderBlocking = deterministicArticleReview(
      contractCase.body,
      [],
      "guide",
      "",
    ).filter(
      (issue) =>
        issue.severity === "blocking" &&
        /material-image|配图|未解析占位符/.test(issue.message),
    );
    if (contractCase.expectedReviewBlocking) {
      expect(placeholderBlocking.length).toBeGreaterThan(0);
    } else {
      expect(placeholderBlocking).toEqual([]);
    }
  });
});

describe("illustration contract injection (ADR-0008 T4)", () => {
  const promptBase = {
    brandName: "小鲸",
    productLine: "知识服务",
    targetRegion: "中国",
    contentType: "guide" as const,
    topic: "企业知识库指南",
    requestedTitle: "企业知识库指南",
    constraints: "",
    plannedFacts: facts,
  };
  const candidates = [
    {
      id: "9f1c2ab4-52d8-4f6e-8a90-1c2d3e4f5a6b",
      description: "红色门头的门店外景实拍",
      category: "scene" as const,
      sourceMaterialName: "品牌手册.docx",
    },
    {
      id: "0a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
      description: "产品三件套陈列台面",
      category: "product-photo" as const,
      sourceMaterialName: "产品图集.pptx",
    },
    {
      id: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
      description: "门店就餐区顾客与店员实拍",
      category: "people" as const,
      sourceMaterialName: "品牌手册.docx",
    },
  ];

  it("injects the candidate list and the illustration discipline when candidates exist", () => {
    const messages = buildArticleGenerationMessages({
      ...promptBase,
      imageCandidates: candidates,
    });
    expect(messages.system).toContain("配图纪律（必须完全满足）");
    expect(messages.system).toContain("![alt 文本](material-image://图片ID)");
    // 类型配额 + 池感知弹性（2026-08-31 用户裁决）：guide 配额 8、池 3 张
    // 时目标张数取小为 3；池小于配额时明示全部可选、不得虚构清单外图片。
    expect(messages.system).toContain("本篇配图目标 3 张");
    expect(messages.system).toContain("类型配额上限 8 张");
    expect(messages.system).toContain("候选池 3 张弹性取小");
    expect(messages.system).toContain("从中选用 1–3 张均可");
    expect(messages.system).toContain("同一篇内不得重复引用同一张图片");
    expect(messages.system).toContain("alt 文本由你撰写");
    expect(messages.user).toContain("配图候选清单");
    expect(messages.user).toContain("你看不到图片本体");
    for (const candidate of candidates) {
      expect(messages.user).toContain(candidate.id);
      expect(messages.user).toContain(candidate.description);
      expect(messages.user).toContain(candidate.sourceMaterialName);
    }
    expect(messages.user).toContain("环境");
    expect(messages.user).toContain("产品实拍");
  });

  it("keeps the prompt illustration-free when no candidates exist (zero-image path)", () => {
    const messages = buildArticleGenerationMessages(promptBase);
    expect(messages.system).not.toContain("配图纪律");
    expect(messages.user).not.toContain("配图候选清单");
    expect(messages.user).not.toContain("material-image://");
    expect(messages.system).not.toContain("material-image://");
  });

  it("exposes the injection cap as a named constant for the pool wiring", () => {
    expect(ARTICLE_IMAGE_CANDIDATE_INJECTION_LIMIT).toBeGreaterThan(0);
    expect(ARTICLE_IMAGE_CANDIDATE_INJECTION_LIMIT).toBeLessThanOrEqual(100);
  });
});

describe("brand mention auto-bolding (ADR-0009)", () => {
  const brandFacts = [
    {
      factKey: "brand-fullname",
      predicate: "enterprise-profile.fullname",
      normalizedValueJson: '"成都鲸鱼家居有限公司"',
    },
    {
      factKey: "brand-shortnames",
      predicate: "enterprise-profile.shortnames",
      normalizedValueJson: '["鲸鱼家居"]',
    },
  ];

  it("bolds verbatim full-name and short-name occurrences, longest name first", () => {
    // 「鲸鱼家居」是全称子串：长名优先保证全称整体包粗后再独立包简称，
    // 不会把「成都鲸鱼家居有限公司」拦腰截成两段加粗。
    expect(
      autoBoldBrandMentions(
        "成都鲸鱼家居有限公司是行业老兵，鲸鱼家居口碑不错。",
        brandFacts,
      ),
    ).toBe("**成都鲸鱼家居有限公司**是行业老兵，**鲸鱼家居**口碑不错。");
  });

  it("skips heading lines, existing bold spans and fenced code blocks", () => {
    const body = [
      "# 标题",
      "",
      "## 鲸鱼家居怎么样",
      "",
      "**鲸鱼家居**已有加粗不双重包裹。",
      "",
      "```",
      "鲸鱼家居在代码块里不动。",
      "```",
    ].join("\n");
    expect(autoBoldBrandMentions(body, brandFacts)).toBe(body);
  });

  it("skips image syntax and link URLs but bolds link text", () => {
    expect(
      autoBoldBrandMentions(
        "![鲸鱼家居门头](material-image://abc123) 见[鲸鱼家居官网](https://example.com/鲸鱼家居)。",
        brandFacts,
      ),
    ).toBe(
      "![鲸鱼家居门头](material-image://abc123) 见[**鲸鱼家居**官网](https://example.com/鲸鱼家居)。",
    );
  });

  it("returns the body unchanged when the profile has no brand names", () => {
    expect(autoBoldBrandMentions("正文", [])).toBe("正文");
  });

  it("satisfies the deterministic gate's bold assertion after auto-bolding", () => {
    const body = autoBoldBrandMentions(
      [
        "# 标题",
        "",
        "## 门槛",
        "成都鲸鱼家居有限公司行业深耕。",
        "",
        "## 清单",
        "- 鲸鱼家居服务到位",
      ].join("\n"),
      brandFacts,
    );
    expect(
      deterministicArticleReview(body, brandFacts, "guide").filter(
        (issue) => issue.category === "output-contract",
      ),
    ).toEqual([]);
  });

  it("treats image alt text and fenced code as blind spots in the gate scan", () => {
    // 盲区对齐（ADR-0009）：alt/代码块里的品牌字样不是正文指称，加粗门
    // 不再误报——此前 alt 含品牌名会被判「未加粗」整篇拒掉。
    const body = [
      "# 标题",
      "",
      "## 门店",
      "![鲸鱼家居门头](material-image://abc123)",
      "",
      "## 说明",
      "- 图片说明见上",
    ].join("\n");
    expect(
      deterministicArticleReview(body, brandFacts, "guide").filter(
        (issue) => issue.category === "output-contract",
      ),
    ).toEqual([]);
  });
});

describe("list-item label auto-bolding（用户裁决 2026-09-04）", () => {
  it("bolds colon-form labels in unordered and ordered items, colon stays outside", () => {
    expect(
      autoBoldListLabels(
        ["- 服务优势：免费上门测量。", "1. 产品特点：全屋定制。", "- 交付周期: 半角也认"].join(
          "\n",
        ),
      ),
    ).toBe(
      ["- **服务优势**：免费上门测量。", "1. **产品特点**：全屋定制。", "- **交付周期**: 半角也认"].join(
        "\n",
      ),
    );
  });

  it("bolds space-form labels without rewriting the separator", () => {
    expect(autoBoldListLabels("- 服务优势 免费上门测量，覆盖全城。")).toBe(
      "- **服务优势** 免费上门测量，覆盖全城。",
    );
  });

  it("bolds labels after leading symbol prefixes without wrapping the symbols", () => {
    expect(autoBoldListLabels("- ✅ 免费上门测量：大户型也适用。")).toBe(
      "- ✅ **免费上门测量**：大户型也适用。",
    );
  });

  it("skips stop-word-led narrative items in space form", () => {
    const body = ["- 我们 先看预算再看工艺。", "- 首先 明确需求。"].join("\n");
    expect(autoBoldListLabels(body)).toBe(body);
  });

  it("skips pure-number labels and sentence-like long labels", () => {
    const body = [
      "- 2024 年行业报告显示增长。",
      "- 免费上门测量与安装售后服务：超过十二字的标签不动。",
      "- 短：一字标签不动",
    ].join("\n");
    expect(autoBoldListLabels(body)).toBe(body);
  });

  it("does not double-wrap ranking dimension items that are already bold", () => {
    const body = "- **维度名**：已有加粗不双重包裹。";
    expect(autoBoldListLabels(body)).toBe(body);
  });

  it("hits nested list items", () => {
    expect(autoBoldListLabels("  - 适用场景：三口之家。")).toBe(
      "  - **适用场景**：三口之家。",
    );
  });

  it("skips fenced code blocks and heading lines", () => {
    const body = [
      "## - 服务优势：标题行不动",
      "",
      "```",
      "- 服务优势：代码块里不动。",
      "```",
    ].join("\n");
    expect(autoBoldListLabels(body)).toBe(body);
  });

  it("skips labels containing links, images or inline code", () => {
    const body = [
      "- [官网](https://example.com)：链接标签不动。",
      "- 看图![示例](material-image://abc)：图片标签不动。",
      "- 用`code`示例：行内代码标签不动。",
    ].join("\n");
    expect(autoBoldListLabels(body)).toBe(body);
  });

  it("bolds a label containing a brand name before brand auto-bolding, no nesting", () => {
    const brandFacts = [
      {
        factKey: "brand-fullname",
        predicate: "enterprise-profile.fullname",
        normalizedValueJson: '"成都鲸鱼家居有限公司"',
      },
      {
        factKey: "brand-shortnames",
        predicate: "enterprise-profile.shortnames",
        normalizedValueJson: '["鲸鱼家居"]',
      },
    ];
    const labeled = autoBoldListLabels("- 鲸鱼家居服务优势：全屋定制。");
    expect(labeled).toBe("- **鲸鱼家居服务优势**：全屋定制。");
    // 品牌加粗把加粗块当盲区：标签内品牌名不再嵌套包裹。
    expect(autoBoldBrandMentions(labeled, brandFacts)).toBe(labeled);
  });
});

describe("image placeholder quota trimming (ADR-0009)", () => {
  const body = [
    "# 标题",
    "",
    "![首图](material-image://img-1)",
    "",
    "![第二张](material-image://img-2)",
    "",
    "![第三张](material-image://img-3)",
  ].join("\n");

  it("keeps the first N placeholders and drops the rest in order", () => {
    const trimmed = trimMaterialImagePlaceholders(body, 1);
    expect(trimmed).toContain("![首图](material-image://img-1)");
    expect(trimmed).not.toContain("img-2");
    expect(trimmed).not.toContain("img-3");
    expect(scanMaterialImagePlaceholders(trimmed).placeholders).toHaveLength(1);
  });

  it("returns the body unchanged when within quota", () => {
    expect(trimMaterialImagePlaceholders(body, 3)).toBe(body);
    expect(trimMaterialImagePlaceholders(body, 8)).toBe(body);
  });
});

describe("article repair prompt (ADR-0009 Decision 3)", () => {
  it("injects the blocking issue list verbatim with title, body and optional roster note", () => {
    const messages = buildArticleRepairMessages({
      contentType: "guide",
      requestedTitle: "修复演示标题",
      body: "# 修复演示标题\n\n## 定义\n正文。",
      issues: [
        { message: "格式契约不满足：guide 类型至少需要 3 个 H2（当前 1）。" },
      ],
      rosterNote: "陈列位 1 必须是目标品牌：甲。",
    });
    expect(messages.system).toContain("文章格式修复器");
    expect(messages.system).toContain("plain Markdown");
    expect(messages.user).toContain("# 修复演示标题");
    expect(messages.user).toContain(
      "- 格式契约不满足：guide 类型至少需要 3 个 H2（当前 1）。",
    );
    expect(messages.user).toContain("## 正文草稿");
    expect(messages.user).toContain("陈列位 1 必须是目标品牌：甲。");
  });

  it("omits the roster section when no note is given and rejects empty issue lists", () => {
    const messages = buildArticleRepairMessages({
      contentType: "news",
      requestedTitle: "标题",
      body: "# 标题\n正文",
      issues: [{ message: "格式契约不满足：news 类型至少需要 2 个 H2（当前 0）。" }],
    });
    expect(messages.user).not.toContain("## 名单硬约束");
    expect(() =>
      buildArticleRepairMessages({
        contentType: "news",
        requestedTitle: "标题",
        body: "# 标题\n正文",
        issues: [],
      }),
    ).toThrow("article_repair_issues_empty");
  });
});

describe("ranking dimension skeleton (ADR-0009 Decision 2)", () => {
  const DIMENSIONS = [
    "服务范围",
    "核心项目",
    "适用人群",
    "服务方式",
    "区域覆盖",
    "选择要点",
  ];

  it("parses a fenced or bare JSON array of six unique dimension names", () => {
    expect(parseRankingDimensions(JSON.stringify(DIMENSIONS))).toEqual(
      DIMENSIONS,
    );
    expect(
      parseRankingDimensions("```json\n" + JSON.stringify(DIMENSIONS) + "\n```"),
    ).toEqual(DIMENSIONS);
  });

  it("rejects bad json, wrong shape, duplicate or malformed names", () => {
    expect(() => parseRankingDimensions("不是 JSON")).toThrow(
      "article_generation_ranking_dimensions_invalid_json",
    );
    expect(() => parseRankingDimensions('["服务范围","核心项目"]')).toThrow(
      "article_generation_ranking_dimensions_invalid_shape",
    );
    expect(() =>
      parseRankingDimensions(JSON.stringify([...DIMENSIONS.slice(0, 5), "服务范围"])),
    ).toThrow("article_generation_ranking_dimensions_invalid_value");
    expect(() =>
      parseRankingDimensions(JSON.stringify([...DIMENSIONS.slice(0, 5), "这个名字肯定超过十个字"])),
    ).toThrow("article_generation_ranking_dimensions_invalid_value");
    expect(() =>
      parseRankingDimensions(JSON.stringify([...DIMENSIONS.slice(0, 5), "带*号的名字"])),
    ).toThrow("article_generation_ranking_dimensions_invalid_value");
  });

  it("builds the dimension planning prompt with the full brand exclusion list", () => {
    const messages = buildRankingDimensionMessages({
      brandNames: ["目标品牌", "竞品甲", "竞品乙"],
      productLine: "本地服务",
      targetRegion: "成都",
      topic: "本地服务怎么选",
    });
    expect(messages.system).toContain("6 个对比维度名");
    expect(messages.system).toContain("不得包含输入里列出的任何品牌名");
    // 排除集含目标品牌与竞品（ADR-0009：维度调用输入含品牌事实）。
    expect(messages.user).toContain(
      "以下品牌名仅作行业语境参考，一律禁止用作维度：目标品牌、竞品甲、竞品乙",
    );
  });

  it("accepts per-brand dimension order drift under the set-equality gate", () => {
    const rankingFacts = [
      {
        factKey: "brand-name",
        predicate: "enterprise-profile.fullname",
        normalizedValueJson: '"目标品牌"',
      },
      {
        factKey: "competitors",
        predicate: "enterprise-profile.competitors",
        normalizedValueJson:
          '["竞品甲","竞品乙","竞品丙","竞品丁","竞品戊"]',
      },
    ];
    const roster = [
      "目标品牌",
      "竞品甲",
      "竞品乙",
      "竞品丙",
      "竞品丁",
      "竞品戊",
    ];
    const section = (name: string, dimensions: readonly string[]) => [
      name,
      ...dimensions.map((dimension) => `- **${dimension}**：信息`),
    ];
    // 各家维度顺序不同（第 2 家倒序）：集合相等即过——用户裁定「等长非
    // 严格等长，相似即可」。
    const orderDriftBody = [
      "# 本地服务六家对比",
      "",
      ...roster.flatMap((name, index) =>
        section(
          `## ${index + 1}. ${name}`,
          index === 1 ? [...DIMENSIONS].reverse() : DIMENSIONS,
        ),
      ),
    ].join("\n");
    expect(
      deterministicArticleReview(
        orderDriftBody,
        rankingFacts,
        "ranking",
        "目标品牌",
        DIMENSIONS,
      ).filter((issue) => issue.severity === "blocking"),
    ).toEqual([]);

    // 一家把「选择要点」换成了清单外维度：集合不等，拦截。
    const swappedBody = [
      "# 本地服务六家对比",
      "",
      ...roster.flatMap((name, index) =>
        section(
          `## ${index + 1}. ${name}`,
          index === 2
            ? [...DIMENSIONS.slice(0, 5), "售后服务"]
            : DIMENSIONS,
        ),
      ),
    ].join("\n");
    expect(
      deterministicArticleReview(
        swappedBody,
        rankingFacts,
        "ranking",
        "目标品牌",
        DIMENSIONS,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "geo-citability",
          severity: "blocking",
        }),
      ]),
    );

    // 注入清单是权威对照：六家集合一致但整组偏离清单（存量自选稿），
    // 生成路径仍拦——清单与正文不同说明模型没有照抄骨架。
    const offSkeletonBody = [
      "# 本地服务六家对比",
      "",
      ...roster.flatMap((name, index) =>
        section(`## ${index + 1}. ${name}`, [
          "售后保障",
          "价格区间",
          "门店分布",
          "师傅资历",
          "响应速度",
          "口碑评价",
        ]),
      ),
    ].join("\n");
    expect(
      deterministicArticleReview(
        offSkeletonBody,
        rankingFacts,
        "ranking",
        "目标品牌",
        DIMENSIONS,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "geo-citability",
          severity: "blocking",
        }),
      ]),
    );
    // 同一偏离清单的存量稿无注入清单时回退与第一家比对：六家一致即过。
    expect(
      deterministicArticleReview(
        offSkeletonBody,
        rankingFacts,
        "ranking",
        "目标品牌",
      ).filter((issue) => issue.severity === "blocking"),
    ).toEqual([]);
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
          "- **服务范围**：信息",
          "- **核心项目**：信息",
          "- **适用人群**：信息",
          "- **服务方式**：信息",
          "- **区域覆盖**：信息",
          "- **选择要点**：信息",
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

    // 回归（2026-08-31 契约切换）：旧契约（• **维度名**）落库的存量
    // ranking 稿不经 parse 归一直接进审核门——维度匹配必须同时认 • 与 -
    // 两种行首，否则存量稿维度计数为 0，批准时被误判阻断。
    const legacyBullets = valid
      .split("\n")
      .map((line) => line.replace(/^- /, "• "))
      .join("\n");
    expect(
      deterministicArticleReview(
        legacyBullets,
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

describe("content trustworthiness and structured expression discipline (D19, v8)", () => {
  const messages = buildArticleGenerationMessages({
    brandName: "小鲸",
    productLine: "知识服务",
    targetRegion: "中国",
    contentType: "guide",
    topic: "企业知识库指南",
    requestedTitle: "企业知识库指南",
    constraints: "",
    plannedFacts: facts,
  });

  it("injects the four signals and entity-relation-expression rules", () => {
    expect(messages.system).toContain("【内容可信度与结构化表达纪律】");
    expect(messages.system).toContain("经验信号");
    expect(messages.system).toContain("专业信号");
    expect(messages.system).toContain("权威信号");
    expect(messages.system).toContain("可信信号");
    expect(messages.system).toContain("实体-关系-属性表达");
    expect(messages.system).toContain("可被清晰抽取");
    // 竞品表述限定对比清单类型，不与非 ranking 类型的竞品禁令冲突。
    expect(messages.system).toContain("若本篇为对比清单且涉及竞品对比");
  });

  it("never leaks the EEAT or knowledge-graph labels", () => {
    expect(messages.system).not.toContain("EEAT");
    expect(messages.system).not.toContain("知识图谱");
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
    "**锦江区鲸鱼汽车音响经营部**师傅经验扎实。要点说明一。",
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
      "**锦江区鲸鱼汽车音响经营部**师傅经验扎实。",
      "锦江区鲸鱼汽车音响经营部的师傅经验扎实。",
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

describe("brand name mention order（用户裁决 2026-09-03：首次全称、其后简称）", () => {
  const orderFacts = [
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
  // 「鲸鱼家居」是「成都鲸鱼家居有限公司」的子串：长名优先不得把全称
  // 拦腰计成「一次全称 + 内部简称」两次命中。
  const substringFacts = [
    {
      factKey: "f1",
      predicate: "brand.fullName",
      normalizedValueJson: '"成都鲸鱼家居有限公司"',
    },
    {
      factKey: "f2",
      predicate: "brand.shortNames",
      normalizedValueJson: '["鲸鱼家居"]',
    },
  ];
  const orderIssues = (
    body: string,
    facts: readonly (typeof orderFacts)[number][] = orderFacts,
    options?: { brandNameOrderEnforced?: boolean },
  ) =>
    deterministicArticleReview(body, facts, "guide", "", undefined, options)
      .filter((issue) => issue.message.includes("品牌指称序违约"));

  it("blocks when a short name appears before the full name", () => {
    const body = [
      "# 标题",
      "",
      "## 一段",
      "",
      "**鲸鱼音响**口碑不错。",
      "",
      "## 二段",
      "",
      "**锦江区鲸鱼汽车音响经营部**是本地老店。",
      "",
      "## 三段",
      "",
      "结尾说明。",
    ].join("\n");
    const issues = orderIssues(body);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("blocking");
    expect(issues[0].message).toContain("锦江区鲸鱼汽车音响经营部");
    expect(issues[0].message).toContain("鲸鱼音响");
  });

  it("blocks when the full name repeats after its first occurrence", () => {
    const body = [
      "# 标题",
      "",
      "## 一段",
      "",
      "**锦江区鲸鱼汽车音响经营部**是本地老店。",
      "",
      "## 二段",
      "",
      "**锦江区鲸鱼汽车音响经营部**报价透明。",
      "",
      "## 三段",
      "",
      "**鲸鱼音响**收尾。",
    ].join("\n");
    const issues = orderIssues(body);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("之后应统一使用已确认简称");
    expect(issues[0].message).toContain("鲸鱼音响");
  });

  it("accepts full name first and the confirmed short name afterwards", () => {
    const body = [
      "# 标题",
      "",
      "## 一段",
      "",
      "**锦江区鲸鱼汽车音响经营部**是本地老店。",
      "",
      "## 二段",
      "",
      "**鲸鱼音响**报价透明。",
      "",
      "## 三段",
      "",
      "**鲸鱼音响**收尾。",
    ].join("\n");
    expect(orderIssues(body)).toEqual([]);
  });

  it("requires the full name when the brand appears only once", () => {
    const body = [
      "# 标题",
      "",
      "## 一段",
      "",
      "**鲸鱼音响**口碑不错。",
      "",
      "## 二段",
      "",
      "无关说明。",
      "",
      "## 三段",
      "",
      "结尾说明。",
    ].join("\n");
    const issues = orderIssues(body);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("首次出现品牌指称必须使用全称");
  });

  it("counts a full-name mention once when the short name is its substring", () => {
    const body = [
      "# 标题",
      "",
      "## 一段",
      "",
      "**成都鲸鱼家居有限公司**是行业老兵。",
      "",
      "## 二段",
      "",
      "**鲸鱼家居**口碑不错。",
      "",
      "## 三段",
      "",
      "结尾说明。",
    ].join("\n");
    expect(orderIssues(body, substringFacts)).toEqual([]);
  });

  it("ignores headings, fenced code and image alt text", () => {
    const body = [
      "# 锦江区鲸鱼汽车音响经营部选购指南",
      "",
      "## 鲸鱼音响怎么样",
      "",
      "```",
      "锦江区鲸鱼汽车音响经营部",
      "```",
      "",
      "![鲸鱼音响门头](material-image://img-1)",
      "",
      "配图见上。",
    ].join("\n");
    expect(orderIssues(body)).toEqual([]);
  });

  it("does not apply when the profile lacks a full name", () => {
    const shortOnlyFacts = [
      {
        factKey: "f2",
        predicate: "brand.shortNames",
        normalizedValueJson: '["鲸鱼音响"]',
      },
    ];
    const body = [
      "# 标题",
      "",
      "## 一段",
      "",
      "**鲸鱼音响**口碑不错。",
      "",
      "## 二段",
      "",
      "**鲸鱼音响**收尾。",
      "",
      "## 三段",
      "",
      "结尾说明。",
    ].join("\n");
    expect(orderIssues(body, shortOnlyFacts)).toEqual([]);
  });

  it("does not apply when the full name equals the first short name", () => {
    const sameNameFacts = [
      {
        factKey: "f1",
        predicate: "brand.fullName",
        normalizedValueJson: '"造卤先生"',
      },
      {
        factKey: "f2",
        predicate: "brand.shortNames",
        normalizedValueJson: '["造卤先生"]',
      },
    ];
    const body = [
      "# 标题",
      "",
      "## 一段",
      "",
      "**造卤先生**口碑不错。",
      "",
      "## 二段",
      "",
      "**造卤先生**收尾。",
      "",
      "## 三段",
      "",
      "结尾说明。",
    ].join("\n");
    expect(orderIssues(body, sameNameFacts)).toEqual([]);
  });

  it("can be exempted for legacy articles via brandNameOrderEnforced: false", () => {
    const body = [
      "# 标题",
      "",
      "## 一段",
      "",
      "**鲸鱼音响**口碑不错。",
      "",
      "## 二段",
      "",
      "**锦江区鲸鱼汽车音响经营部**是本地老店。",
      "",
      "## 三段",
      "",
      "结尾说明。",
    ].join("\n");
    expect(
      orderIssues(body, orderFacts, { brandNameOrderEnforced: false }),
    ).toEqual([]);
  });
});

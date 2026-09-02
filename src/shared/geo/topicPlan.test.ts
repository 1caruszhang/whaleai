import { describe, expect, it } from "vitest";

import {
  TOPIC_PLAN_TITLE_DUPLICATE_THRESHOLD,
  TopicPlanTitleCandidatesError,
  buildTitlePlanningPrompt,
  buildTopicSemanticHints,
  isTopicPlanItemProtected,
  mergeRegeneratedTopicPlanItems,
  parseAndEnforceTypeRecommendations,
  parseTitlePlan,
  parseTopicClusters,
  selectContentTypePlannedFacts,
  selectDistinctTitles,
  splitAnchorTokens,
  titleBusinessAnchors,
  validateTitleCandidates,
  type TopicPlanItem,
  type TopicPlanTopic,
} from "./topicPlan";

const questions = [
  { id: "q1", text: "成都汽车音响改装哪家好？" },
  { id: "q2", text: "锦江区汽车音响改装怎么选？" },
  { id: "q3", text: "成都汽车音响改装价格是多少？" },
];

const topics: TopicPlanTopic[] = [
  {
    id: "topic-1",
    name: "成都汽车音响改装选型",
    summary: "覆盖本地门店选择与专业服务判断",
    questionIds: ["q1", "q2"],
    searchIntent: "commercial-investigation",
    namingReason: "两个问题都在比较本地服务商",
  },
  {
    id: "topic-2",
    name: "成都汽车音响改装价格",
    summary: "解释价格构成与预算范围",
    questionIds: ["q3"],
    searchIntent: "transactional",
    namingReason: "问题聚焦预算",
  },
];

function item(overrides: Partial<TopicPlanItem> = {}): TopicPlanItem {
  return {
    id: "item-topic-1-guide",
    topicId: "topic-1",
    sourceQuestionIds: ["q1", "q2"],
    contentType: "guide",
    typeSelectionReason: "适合选型科普",
    title: "成都汽车音响改装怎么选？本地服务判断指南",
    titleCandidates: ["成都汽车音响改装怎么选？本地服务判断指南"],
    titleRationale: {
      questionCoverage: "覆盖两个选型问题",
      searchIntent: "匹配比较意图",
      differentiation: "聚焦服务判断",
      brandFit: "保持品牌专家角色",
      chinaMarketExpression: "使用自然中文问句",
    },
    plannedFacts: [
      {
        factKey: "industry",
        predicate: "enterprise-profile.industry",
        normalizedValueJson: '"汽车音响改装"',
      },
    ],
    deduplication: {
      method: "embedding",
      comparedItemIds: [],
      maxSimilarity: 0,
      threshold: TOPIC_PLAN_TITLE_DUPLICATE_THRESHOLD,
    },
    userEdited: false,
    approvalStatus: "draft",
    origin: "model",
    ...overrides,
  };
}

describe("topic/type/title shared contract", () => {
  it("pins the ranking roster facts even when semantic top-five dropped them", () => {
    const selected = Array.from({ length: 5 }, (_, index) => ({
      factKey: `fact-${index}`,
      predicate: `enterprise-profile.field-${index}`,
      normalizedValueJson: `"value-${index}"`,
    }));
    const competitors = {
      factKey: "competitors",
      predicate: "enterprise-profile.competitors",
      normalizedValueJson: '["竞品甲","竞品乙","竞品丙","竞品丁","竞品戊"]',
    };
    const relatedBrands = {
      factKey: "related-brands",
      predicate: "enterprise-profile.relatedbrands",
      normalizedValueJson: '["合作品牌"]',
    };
    expect(
      selectContentTypePlannedFacts("ranking", selected, [
        ...selected,
        competitors,
        relatedBrands,
      ]),
    ).toEqual([...selected, competitors, relatedBrands]);
    expect(
      selectContentTypePlannedFacts("guide", selected, [
        ...selected,
        competitors,
        relatedBrands,
      ]),
    ).toEqual(selected);
  });

  it("turns real embeddings into deterministic semantic-neighbor evidence", () => {
    expect(
      buildTopicSemanticHints(questions, [
        [1, 0],
        [0.9, 0.1],
        [0, 1],
      ], 1),
    ).toEqual([
      { questionId: "q1", neighborQuestionId: "q2", cosineSimilarity: 0.993884 },
      { questionId: "q2", neighborQuestionId: "q1", cosineSimilarity: 0.993884 },
      { questionId: "q3", neighborQuestionId: "q2", cosineSimilarity: 0.110432 },
    ]);
  });

  it("accepts only exact one-group-per-question LLM clustering with named topics", () => {
    expect(
      parseTopicClusters(
        JSON.stringify([
          {
            questionIds: ["q1", "q2"],
            name: "成都汽车音响改装选型",
            summary: "覆盖本地门店选择与专业服务判断",
            searchIntent: "commercial-investigation",
            reason: "两个问题都在比较本地服务商",
          },
          {
            questionIds: ["q3"],
            name: "成都汽车音响改装价格",
            summary: "解释价格构成与预算范围",
            searchIntent: "transactional",
            reason: "问题聚焦预算",
          },
        ]),
        questions,
      ),
    ).toEqual(topics);

    expect(() =>
      parseTopicClusters(
        JSON.stringify([
          {
            questionIds: ["q1", "q2"],
            name: "遗漏主题",
            summary: "遗漏 q3",
            searchIntent: "informational",
            reason: "错误输出",
          },
        ]),
        questions,
      ),
    ).toThrow("topic_plan_question_coverage_incomplete");
  });

  it("keeps per-type reasons and applies the twelve-article coverage floor", () => {
    const recommendations = parseAndEnforceTypeRecommendations(
      JSON.stringify([
        {
          topicId: "topic-1",
          recommendations: [
            { type: "guide", reason: "适合选型科普" },
          ],
        },
        {
          topicId: "topic-2",
          recommendations: [
            { type: "guide", reason: "适合价格解释" },
          ],
        },
      ]),
      topics,
    );
    // 两个主题时 12 篇下限受「每主题最多五类」结构上限约束，补齐到 10 篇。
    expect(recommendations.map((recommendation) => recommendation.types)).toEqual([
      ["guide", "showcase", "ranking", "news", "news_light"],
      ["guide", "showcase", "ranking", "news", "news_light"],
    ]);
    for (const recommendation of recommendations) {
      for (const type of recommendation.types) {
        expect(recommendation.reasons[type]).toBeTruthy();
      }
    }
  });

  it("requires structured title rationales and js_ai title constraints", () => {
    const parsed = parseTitlePlan(
      JSON.stringify({
        itemId: "item-topic-1-guide",
        candidates: [
          "成都汽车音响改装怎么选？本地服务判断指南",
          "成都汽车音响改装选店要看什么？五个服务细节",
          "成都汽车音响改装避坑：从需求到方案怎么判断",
        ],
        rationale: {
          questionCoverage: "覆盖选店与判断标准",
          searchIntent: "承接比较型搜索",
          differentiation: "三个标题分别强调判断、细节和避坑",
          brandFit: "保持专业顾问定位",
          chinaMarketExpression: "使用本地用户自然问法",
        },
      }),
      "item-topic-1-guide",
    );
    expect(
      validateTitleCandidates({
        candidates: parsed.candidates,
        contentType: "guide",
        targetRegion: "成都",
        industry: "汽车音响改装",
        brandNames: ["鲸跃", "鲸跃汽车"],
        competitors: ["竞品甲"],
        currentYear: 2026,
      }),
    ).toHaveLength(3);

    expect(() =>
      validateTitleCandidates({
        candidates: [
          "2026成都汽车音响改装推荐",
          "2026成都汽车音响改装怎么选",
          "2026成都鲸跃汽车音响改装清单",
        ],
        contentType: "ranking",
        targetRegion: "成都",
        industry: "汽车音响改装",
        brandNames: ["鲸跃"],
        competitors: [],
        currentYear: 2026,
      }),
    ).toThrow("topic_plan_title_candidates_insufficient");
  });

  it("accepts business-anchor variants and reports per-rule reject counts", () => {
    // 业务词锚集（用户裁决 2026-08-19 修正）：行业后缀锚「音响改装」逐字命中
    // 或品牌业务词整体替换；「汽车音响店」这类丢业务动作的写法不合格。
    const businessTerms = [
      "汽车音响升级",
      "全车隔音降噪",
      "360°全景影像",
      "无损改装",
      "DSP功放",
    ];
    expect(
      validateTitleCandidates({
        candidates: [
          "成都音响改装升级避坑指南",
          "成都无损改装怎么选",
          "成都全景影像改装预算参考",
        ],
        contentType: "guide",
        targetRegion: "成都",
        industry: "汽车音响改装",
        businessTerms,
        brandNames: [],
        competitors: [],
        currentYear: 2026,
      }),
    ).toHaveLength(3);
    // 丢了业务动作（音响店/贴膜/洗车）全部拦截，且错误码带拒因计数。
    expect(() =>
      validateTitleCandidates({
        candidates: [
          "成都汽车音响店怎么挑",
          "成都汽车贴膜哪家快",
          "成都洗车店盘点",
        ],
        contentType: "guide",
        targetRegion: "成都",
        industry: "汽车音响改装",
        businessTerms,
        brandNames: [],
        competitors: [],
        currentYear: 2026,
      }),
    ).toThrow("topic_plan_title_candidates_insufficient:industry=3");
  });

  it("splits compound anchor-source values on separators instead of producing dead anchors", () => {
    // 复合值静默拆分（用户裁决 2026-09-01）：「医美/轻医美」曾让所有锚点带
    // 斜杠、正常标题永远无法逐字命中（industry 全灭事故）。拆分后锚集只剩
    // 干净 token 的后缀，自然标题可命中任一 token。
    expect(splitAnchorTokens("医美/轻医美")).toEqual(["医美", "轻医美"]);
    expect(splitAnchorTokens("华熙生物、爱美客")).toEqual([
      "华熙生物",
      "爱美客",
    ]);
    expect(splitAnchorTokens("轻医美")).toEqual(["轻医美"]);

    const anchors = titleBusinessAnchors({ industry: "医美/轻医美" });
    expect(anchors).toContain("医美");
    expect(anchors).toContain("轻医美");
    expect(anchors.every((anchor) => !/[/／,，、;；\s]/.test(anchor))).toBe(
      true,
    );

    // 事故复现：复合行业 + 自然标题，不再 industry 全灭。
    expect(
      validateTitleCandidates({
        candidates: [
          "杭州轻医美机构怎么选",
          "杭州轻医美价格解析",
          "杭州医美避坑指南",
        ],
        contentType: "guide",
        targetRegion: "杭州",
        industry: "医美/轻医美",
        brandNames: [],
        competitors: [],
        currentYear: 2026,
      }),
    ).toHaveLength(3);
  });

  it("forbids each competitor token and accepts any region token from compound values", () => {
    // forbid 类按 token 各自拦截：「华熙生物/爱美客」整串 includes 永假会让竞品
    // 名漏放进标题。被拦候选取真实泄漏形态——品牌点名的盘点式对比是排行榜
    // 正文（六品牌 roster）的事，标题任何类型都不得点名竞品；模型把这种写法
    // 带进 guide 槽位正是该规则要拦的场景。require 类（地域）命中任一 token
    // 即合格。
    expect(() =>
      validateTitleCandidates({
        candidates: [
          "杭州轻医美机构怎么选",
          "杭州轻医美价格解析",
          "杭州轻医美品牌对比：鲸跃、爱美客、华熙生物怎么选",
        ],
        contentType: "guide",
        targetRegion: "杭州",
        industry: "轻医美",
        brandNames: ["鲸跃"],
        competitors: ["华熙生物/爱美客"],
        currentYear: 2026,
      }),
    ).toThrow("topic_plan_title_candidates_insufficient:competitor=1");

    expect(
      validateTitleCandidates({
        candidates: [
          "杭州轻医美机构怎么选",
          "宁波轻医美价格解析",
          "杭州轻医美避坑指南",
        ],
        contentType: "guide",
        targetRegion: "杭州/宁波",
        industry: "轻医美",
        brandNames: [],
        competitors: [],
        currentYear: 2026,
      }),
    ).toHaveLength(3);
  });

  it("ranking titles forbid every brand name, including agency/distributed related brands", () => {
    // ranking 标题禁一切品牌名（用户裁决 2026-09-01）：目标品牌与竞品原本就在
    // 禁用源里，本用例补第三层——关联品牌（代理/经销、非竞品，正文 roster 会
    // 排除它，但标题同样不得点名）。被拦候选是真实泄漏形态：模型把六品牌
    // 盘点的 roster 写法带进标题。
    expect(() =>
      validateTitleCandidates({
        candidates: [
          "2026杭州轻医美机构盘点",
          "2026杭州轻医美怎么选",
          "2026杭州轻医美盘点：润百颜等六家怎么选",
        ],
        contentType: "ranking",
        targetRegion: "杭州",
        industry: "轻医美",
        brandNames: ["鲸跃"],
        relatedBrands: ["润百颜"],
        competitors: [],
        currentYear: 2026,
      }),
    ).toThrow("topic_plan_title_candidates_insufficient:ranking-brand=1");

    // 裁决范围是 ranking：guide 标题暂不受关联品牌禁令约束（提示词红线仍
    // 建议只带目标品牌，但确定性校验未扩大到全类型）。
    expect(
      validateTitleCandidates({
        candidates: [
          "杭州轻医美机构怎么选",
          "杭州轻医美价格解析",
          "杭州轻医美盘点：润百颜等六家怎么选",
        ],
        contentType: "guide",
        targetRegion: "杭州",
        industry: "轻医美",
        brandNames: ["鲸跃"],
        relatedBrands: ["润百颜"],
        competitors: [],
        currentYear: 2026,
      }),
    ).toHaveLength(3);
  });

  it("ranking brand forbid ignores single-character brand tokens", () => {
    // forbid 类清单 ≥2 字为限（用户裁决 2026-09-01）：单字简称 token（「鲸跃/
    // 跃」拆出的「跃」）会把含该字的任何正常标题全拦，禁令粒度以此为限；
    // ≥2 字 token（「鲸跃」）仍逐 token 禁。showcase require 侧不受影响
    // （单字 token 的 OR 命中只放宽通过面）。
    expect(
      validateTitleCandidates({
        candidates: [
          "2026杭州轻医美机构盘点",
          "2026杭州轻医美怎么选",
          "2026杭州轻医美价格解析",
        ],
        contentType: "ranking",
        targetRegion: "杭州",
        industry: "轻医美",
        brandNames: ["鲸跃/跃"],
        competitors: [],
        currentYear: 2026,
      }),
    ).toHaveLength(3);

    expect(() =>
      validateTitleCandidates({
        candidates: [
          "2026杭州轻医美机构盘点",
          "2026杭州轻医美怎么选",
          "2026杭州轻医美盘点：鲸跃等六家怎么选",
        ],
        contentType: "ranking",
        targetRegion: "杭州",
        industry: "轻医美",
        brandNames: ["鲸跃/跃"],
        competitors: [],
        currentYear: 2026,
      }),
    ).toThrow("topic_plan_title_candidates_insufficient:ranking-brand=1");
  });

  it("degrades to the least-similar candidate when every candidate crosses the duplicate threshold", () => {
    // 越阈降级（用户裁决 2026-09-01 少报错）：全部候选与已选标题越阈时选相
    // 似度最低者并自证越阈（evidence.maxSimilarity ≥ threshold），不再抛
    // diversity_insufficient 杀掉整批。
    const result = selectDistinctTitles({
      protectedSelections: [{ itemId: "protected", title: "旧标题" }],
      items: [
        {
          itemId: "new",
          candidates: ["近义标题甲", "近义标题乙"],
        },
      ],
      vectors: {
        "protected:旧标题": [1, 0],
        "new:近义标题甲": [1, 0.05],
        "new:近义标题乙": [1, 0.2],
      },
    });
    expect(result).toHaveLength(1);
    // 两候选均越阈（相似度 ≥ 0.92），降级选相似度较低的「乙」。
    expect(result[0].title).toBe("近义标题乙");
    expect(result[0].evidence.maxSimilarity).toBeGreaterThanOrEqual(
      TOPIC_PLAN_TITLE_DUPLICATE_THRESHOLD,
    );
  });

  it("carries surviving candidates on the insufficient error for server-side degradation", () => {
    // 幸存候选（用户裁决 2026-09-01 少报错）：错误除了拒因计数还携带通过
    // 校验的候选，服务端降级路径（重试后 ≥1 条即放行）直接采用。
    let captured: InstanceType<
      typeof TopicPlanTitleCandidatesError
    > | null = null;
    try {
      validateTitleCandidates({
        candidates: [
          "杭州轻医美机构怎么选",
          "杭州轻医美价格解析",
          "杭州洗车店盘点",
        ],
        contentType: "guide",
        targetRegion: "杭州",
        industry: "轻医美",
        brandNames: [],
        competitors: [],
        currentYear: 2026,
      });
    } catch (error) {
      if (error instanceof TopicPlanTitleCandidatesError) captured = error;
    }
    expect(captured).not.toBeNull();
    expect(captured!.rejectionCounts.get("industry")).toBe(1);
    expect(captured!.validCandidates).toEqual([
      "杭州轻医美机构怎么选",
      "杭州轻医美价格解析",
    ]);
  });

  it("records embedding-based semantic dedup and chooses a non-duplicate candidate", () => {
    const result = selectDistinctTitles({
      protectedSelections: [{ itemId: "protected", title: "既有标题" }],
      items: [
        {
          itemId: "new",
          candidates: ["近义标题", "差异标题", "备用标题"],
        },
      ],
      vectors: {
        "protected:既有标题": [1, 0],
        "new:近义标题": [0.99, 0.01],
        "new:差异标题": [0, 1],
        "new:备用标题": [-1, 0],
      },
    });
    expect(result[0]).toMatchObject({
      itemId: "new",
      title: "差异标题",
      evidence: {
        comparedItemIds: ["protected"],
        maxSimilarity: 0,
        threshold: TOPIC_PLAN_TITLE_DUPLICATE_THRESHOLD,
      },
    });
  });

  it("prefers a structurally distinct candidate when earlier picks used the same skeleton", () => {
    // 2026-08-18 裁定：批内标题句式不得同构——语义都过关时优先结构指纹不同者。
    const result = selectDistinctTitles({
      items: [
        { itemId: "a", candidates: ["成都汽车音响改装哪家好？六大维度测评"] },
        {
          itemId: "b",
          candidates: [
            "成都汽车隔音哪家好？三大维度测评",
            "成都汽车隔音升级指南：流程与价格",
          ],
        },
      ],
      vectors: {
        "a:成都汽车音响改装哪家好？六大维度测评": [1, 0],
        "b:成都汽车隔音哪家好？三大维度测评": [0.6, 0.8],
        "b:成都汽车隔音升级指南：流程与价格": [0, 1],
      },
    });
    expect(result.map((entry) => entry.title)).toEqual([
      "成都汽车音响改装哪家好？六大维度测评",
      "成都汽车隔音升级指南：流程与价格",
    ]);
  });

  it("falls back to the first passing candidate when every candidate shares the used structure", () => {
    const result = selectDistinctTitles({
      items: [
        { itemId: "a", candidates: ["成都汽车音响改装推荐"] },
        { itemId: "b", candidates: ["成都汽车隔音推荐"] },
      ],
      vectors: {
        "a:成都汽车音响改装推荐": [1, 0],
        "b:成都汽车隔音推荐": [0.2, 0.98],
      },
    });
    expect(result[1].title).toBe("成都汽车隔音推荐");
  });

  it("never overwrites user-edited or approved items during local regeneration", () => {
    const edited = item({ id: "edited", userEdited: true, title: "用户标题" });
    const approved = item({
      id: "approved",
      approvalStatus: "approved",
      title: "批准标题",
    });
    const replaceable = item({ id: "replaceable", title: "旧标题" });
    expect(isTopicPlanItemProtected(edited)).toBe(true);
    const merged = mergeRegeneratedTopicPlanItems({
      currentItems: [edited, approved, replaceable],
      targetItemIds: ["edited", "approved", "replaceable"],
      replacements: [
        item({ id: "edited", title: "不应覆盖" }),
        item({ id: "approved", title: "不应覆盖" }),
        item({ id: "replaceable", title: "新标题" }),
      ],
    });
    expect(merged.items.map((candidate) => candidate.title)).toEqual([
      "用户标题",
      "批准标题",
      "新标题",
    ]);
    expect(merged.preservedItemIds).toEqual(["edited", "approved"]);
  });

  it("makes source-question, search-intent, dedup, brand and China-market requirements explicit in the title prompt", () => {
    const prompt = buildTitlePlanningPrompt({
      itemId: "item-topic-1-guide",
      topic: topics[0],
      contentType: "guide",
      sourceQuestions: questions.slice(0, 2),
      plannedFacts: item().plannedFacts,
      brandName: "鲸跃",
      competitors: ["竞品甲"],
      industry: "汽车音响改装",
      targetRegion: "成都",
      currentYear: 2026,
      existingTitles: ["已有标题"],
    });
    expect(prompt).toContain("来源问题");
    expect(prompt).toContain("搜索意图");
    expect(prompt).toContain("避免同义重复");
    expect(prompt).toContain("目标品牌");
    expect(prompt).toContain("拟覆盖知识事实");
    // ADR-0006 标题 prompt 不变量：风格释义、占位符 few-shot、反抄录、口语化反堆砌。
    // 2026-08-18：few-shot 换为用户《标题示范》12 条的泛化母本（35 字上限）。
    expect(prompt).toContain("疑问式");
    expect(prompt).toContain("【地域】【行业】选【目标品牌】—【卖点】·【卖点】·【卖点】");
    expect(prompt).toContain("只传风格与结构元素");
    expect(prompt).toContain("严禁照抄原句");
    expect(prompt).toContain("像真人会搜的");
    expect(prompt).toContain("有点击吸引力但不标题党");
    expect(prompt).toContain("标题长度不超过 28 个中文字符");
    expect(prompt).toContain("【品牌名红线】");
    expect(prompt).toContain("内容类型：guide");
  });

  it("injects the dealt structure hint and the anti-uniform rule into the title prompt", () => {
    const prompt = buildTitlePlanningPrompt({
      itemId: "item-topic-1-guide",
      topic: topics[0],
      contentType: "guide",
      sourceQuestions: questions.slice(0, 2),
      plannedFacts: item().plannedFacts,
      brandName: "鲸跃",
      competitors: [],
      industry: "汽车音响改装",
      targetRegion: "成都",
      currentYear: 2026,
      existingTitles: [],
      structureHint: "冒号副题：主标题：副题说明（测评/解析/指南等），冒号分层",
    });
    expect(prompt).toContain("【句式错开】本条结构倾向——冒号副题");
    expect(prompt).toContain("不得复用已出现过的形态");
  });
});

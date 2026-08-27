import { describe, expect, it } from "vitest";

import {
  TOPIC_PLAN_TITLE_DUPLICATE_THRESHOLD,
  buildTitlePlanningPrompt,
  buildTopicSemanticHints,
  isTopicPlanItemProtected,
  mergeRegeneratedTopicPlanItems,
  parseAndEnforceTypeRecommendations,
  parseTitlePlan,
  parseTopicClusters,
  selectContentTypePlannedFacts,
  selectDistinctTitles,
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

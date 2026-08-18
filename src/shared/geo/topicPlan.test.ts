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

  it("keeps per-type reasons and applies the js_ai five-type coverage floor", () => {
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
    expect(recommendations.map((recommendation) => recommendation.types)).toEqual([
      ["guide", "showcase", "news"],
      ["guide", "ranking", "news_light"],
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
    expect(prompt).toContain("中国市场");
    expect(prompt).toContain("拟覆盖知识事实");
  });
});

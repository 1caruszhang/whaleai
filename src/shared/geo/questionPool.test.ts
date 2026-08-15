import { describe, expect, it } from "vitest";

import {
  buildKeywordMiningPrompt,
  parseMinedKeywords,
  parseQuestionCandidates,
  scoreQuestionPoolCandidate,
} from "./questionPool";

describe("GEO keyword and question-pool contract", () => {
  it("preserves core/scene/longtail categories, regional expansion, and brand filtering", () => {
    const keywords = parseMinedKeywords(
      JSON.stringify({
        core: [
          { term: "成都汽车改装", heat: "高" },
          { term: "鲸跃汽车改装", heat: "high" },
        ],
        scene: [
          { term: "锦江区汽车隔音", heat: "medium" },
          { term: "太古里附近汽车音响升级", heat: "低" },
        ],
        longtail: [{ term: "成都汽车改装店资质怎么看", heat: "low" }],
      }),
      ["鲸跃", "鲸跃汽车"],
    );

    expect(keywords.map(({ term, category }) => [term, category])).toEqual([
      ["成都汽车改装", "core"],
      ["锦江区汽车隔音", "scene"],
      ["太古里附近汽车音响升级", "scene"],
      ["成都汽车改装店资质怎么看", "longtail"],
    ]);
    const prompt = buildKeywordMiningPrompt({
      region: "成都",
      industry: "汽车改装",
      productLine: "汽车音响",
      brandNames: ["鲸跃"],
      knowledgeSummary: "主营汽车音响升级",
    });
    expect(prompt).toContain("直接下一级真实区县/街道/商圈");
    expect(prompt).toContain("3–5 个地域变体");
    expect(prompt).toContain("严禁输出具体品牌名");
  });

  it("fails explicitly when search returns no usable keywords", () => {
    expect(() =>
      parseMinedKeywords('{"core":[],"scene":[],"longtail":[]}', []),
    ).toThrow("question_pool_empty_keywords");
    expect(() =>
      parseMinedKeywords('{"core":[{"term":"鲸跃汽车","heat":"high"}]}', [
        "鲸跃",
      ]),
    ).toThrow("question_pool_empty_keywords");
  });

  it("keeps only candidates grounded by at least one exact keyword reference", () => {
    const keywords = parseMinedKeywords(
      '{"core":[{"term":"成都汽车改装","heat":"high"}],"scene":[],"longtail":[]}',
      [],
    );
    const questions = parseQuestionCandidates(
      JSON.stringify({
        questions: [
          {
            text: "成都汽车改装哪家好？",
            recommended: true,
            sourceKeywords: ["成都汽车改装", "编造词"],
          },
          { text: "成都汽车改装哪家好？", sourceKeywords: ["成都汽车改装"] },
          { text: "第二问", sourceKeywords: ["编造词"] },
        ],
      }),
      keywords,
      2,
    );
    expect(questions).toEqual([
      {
        text: "成都汽车改装哪家好？",
        recommended: true,
        sourceKeywords: ["成都汽车改装"],
      },
    ]);

    expect(
      parseQuestionCandidates(
        JSON.stringify({
          questions: [
            { text: "缺少来源" },
            { text: "全部杜撰", sourceKeywords: ["编造词"] },
          ],
        }),
        keywords,
        20,
      ),
    ).toEqual([]);
  });

  it("makes all three PRED-1 factors and 150/100 thresholds traceable", () => {
    const high = scoreQuestionPoolCandidate({
      questionVector: [1, 0],
      knowledgeVector: [1, 0],
      recentSelectedVectors: [[-1, 0]],
    });
    expect(high).toMatchObject({
      relevance: 100,
      recentPoolSimilarity: -100,
      optimizationPotential: 100,
      priorityTotal: 200,
      priority: "high",
      mode: "pred-1",
    });
    expect(high.formula).toContain("high >= 150");
    expect(high.formula).toContain("medium >= 100");

    expect(
      scoreQuestionPoolCandidate({
        questionVector: [1, 0],
        knowledgeVector: [0.5, Math.sqrt(0.75)],
        recentSelectedVectors: [],
      }),
    ).toMatchObject({
      relevance: 50,
      recentPoolSimilarity: 0,
      optimizationPotential: 50,
      priority: "medium",
    });

    expect(
      scoreQuestionPoolCandidate({
        questionVector: [0, 1],
        knowledgeVector: [1, 0],
        recentSelectedVectors: [[0, 1]],
      }),
    ).toMatchObject({
      relevance: 0,
      recentPoolSimilarity: 100,
      optimizationPotential: 0,
      priority: "low",
    });
  });
});

import { describe, expect, it } from "vitest";

import {
  aggregateGeoBaselineUnits,
  analyzeGeoProbeAnswer,
  classifyGeoQuestionDiagnosis,
  parseGeoProbeProviderResponse,
} from "./baseline";

describe("GEO real baseline evidence", () => {
  it("extracts the raw answer and structured citations from ARK response blocks", () => {
    const parsed = parseGeoProbeProviderResponse({
      output: [
        {
          type: "doubao_app_call",
          blocks: [
            {
              results: [
                {
                  text_card: {
                    title: "权威评测",
                    url: "https://example.cn/review",
                  },
                },
              ],
            },
          ],
        },
        {
          type: "message",
          content: [{ type: "output_text", text: "鲸跃汽车值得考虑。" }],
        },
      ],
    });

    expect(parsed.answer).toBe("鲸跃汽车值得考虑。");
    expect(parsed.citations).toEqual([
      {
        title: "权威评测",
        url: "https://example.cn/review",
        provenance: "structured-provider",
      },
    ]);
  });

  it("extracts the answer from a doubao_app_call whose only carrier is typed blocks", () => {
    const parsed = parseGeoProbeProviderResponse({
      output: [
        {
          type: "doubao_app_call",
          status: "completed",
          feature: "ai_search",
          blocks: [
            {
              type: "search",
              queries: ["新都轻医美推荐"],
              results: [
                {
                  text_card: {
                    title: "本地生活指南",
                    url: "https://example.cn/xindu",
                  },
                },
              ],
              summary: "搜索完成",
            },
            {
              type: "output_text",
              text: "新都若如初见医学美学诊所可以考虑。",
            },
          ],
        },
      ],
    });
    expect(parsed.answer).toBe("新都若如初见医学美学诊所可以考虑。");
    expect(parsed.citations).toEqual([
      {
        title: "本地生活指南",
        url: "https://example.cn/xindu",
        provenance: "structured-provider",
      },
    ]);
  });

  it("uses answer links only as explicitly labelled fallback evidence and rejects empty output", () => {
    expect(
      parseGeoProbeProviderResponse({
        output_text: "参见 [行业报道](https://news.example.com/a)。",
      }).citations,
    ).toEqual([
      {
        title: "行业报道",
        url: "https://news.example.com/a",
        provenance: "answer-link",
      },
    ]);
    expect(() => parseGeoProbeProviderResponse({ output: [] })).toThrow(
      "geo_baseline_empty_response",
    );
  });

  it("keeps mention, recommendation and citation evidence independent", () => {
    const cited = [{
      url: "https://example.cn/a",
      provenance: "structured-provider" as const,
    }];
    expect(
      analyzeGeoProbeAnswer("鲸跃汽车出现在对比名单中。", ["鲸跃汽车"], cited),
    ).toMatchObject({
      brandMentioned: true,
      brandRecommended: false,
      hasCitationEvidence: true,
    });
    expect(
      analyzeGeoProbeAnswer("不建议选择鲸跃汽车，需关注投诉风险。", ["鲸跃汽车"], []),
    ).toMatchObject({
      brandMentioned: true,
      brandRecommended: false,
      hasCitationEvidence: false,
    });
    expect(
      analyzeGeoProbeAnswer("综合资质与口碑，推荐鲸跃汽车。", ["鲸跃汽车"], []),
    ).toMatchObject({
      brandMentioned: true,
      brandRecommended: true,
      hasCitationEvidence: false,
    });
  });

  it("records frozen competitor mentions with an excerpt, independent of brand metrics", () => {
    const analysis = analyzeGeoProbeAnswer(
      "成都音响改装常见选择有声浪坊和悦听阁，鲸跃汽车也值得关注。",
      ["鲸跃汽车"],
      [],
      ["声浪坊", "悦听阁"],
    );
    expect(analysis).toMatchObject({
      brandMentioned: true,
      competitorMentions: ["声浪坊", "悦听阁"],
    });
    expect(analysis.competitorExcerpt).toContain("声浪坊");

    const missed = analyzeGeoProbeAnswer(
      "鲸跃汽车出现在对比名单中。",
      ["鲸跃汽车"],
      [],
      ["声浪坊"],
    );
    expect(missed).not.toHaveProperty("competitorMentions");
    expect(missed).not.toHaveProperty("competitorExcerpt");
  });

  it("flags a negative cue near the brand as a suspected negative, even alongside praise", () => {
    expect(
      analyzeGeoProbeAnswer("不建议选择鲸跃汽车，需关注投诉风险。", ["鲸跃汽车"], []),
    ).toMatchObject({
      brandMentioned: true,
      brandRecommended: false,
      suspectedNegative: true,
    });
    // 正负并存：推荐判定仍被负面线索压过，但 suspectedNegative 独立标记。
    expect(
      analyzeGeoProbeAnswer("鲸跃汽车口碑较好，但投诉风险需留意。", ["鲸跃汽车"], []),
    ).toMatchObject({
      brandMentioned: true,
      brandRecommended: false,
      suspectedNegative: true,
    });
    // 旧行为缺省：干净回答不带新字段，旧数据缺字段即缺省。
    const clean = analyzeGeoProbeAnswer("综合资质与口碑，推荐鲸跃汽车。", ["鲸跃汽车"], []);
    expect(clean).not.toHaveProperty("suspectedNegative");
    expect(clean).not.toHaveProperty("competitorMentions");
  });

  it("classifies each question by the fixed diagnosis priority", () => {
    // 疑似负面优先于竞品主导与排名。
    expect(
      classifyGeoQuestionDiagnosis({
        analysis: {
          brandMentioned: true,
          suspectedNegative: true,
          competitorMentions: ["声浪坊"],
        },
        rankPosition: 1,
      }),
    ).toBe("suspected-negative");
    // 品牌缺席且竞品在场 → 竞品主导。
    expect(
      classifyGeoQuestionDiagnosis({
        analysis: { brandMentioned: false, competitorMentions: ["声浪坊"] },
      }),
    ).toBe("competitor-dominated");
    // 品牌缺席且无竞品（含空名单与缺失 analysis）→ 缺席。
    expect(
      classifyGeoQuestionDiagnosis({
        analysis: { brandMentioned: false, competitorMentions: [] },
      }),
    ).toBe("absent");
    expect(classifyGeoQuestionDiagnosis({ analysis: null })).toBe("absent");
    // 提及但监测复测未进前三（显式 null）→ 排名低。
    expect(
      classifyGeoQuestionDiagnosis({
        analysis: { brandMentioned: true },
        rankPosition: null,
      }),
    ).toBe("low-ranked");
    // 进前三，或基线单元无排名概念（rankPosition 缺省）→ 正常。
    expect(
      classifyGeoQuestionDiagnosis({
        analysis: { brandMentioned: true },
        rankPosition: 3,
      }),
    ).toBe("ok");
    expect(
      classifyGeoQuestionDiagnosis({ analysis: { brandMentioned: true } }),
    ).toBe("ok");
  });

  it("aggregates only real successful evidence and exposes drill-down ids", () => {
    const metrics = aggregateGeoBaselineUnits([
      {
        id: "unit-1",
        status: "succeeded",
        analysis: {
          brandMentioned: true,
          brandRecommended: false,
          hasCitationEvidence: true,
        },
      },
      {
        id: "unit-2",
        status: "succeeded",
        analysis: {
          brandMentioned: true,
          brandRecommended: true,
          hasCitationEvidence: false,
        },
      },
      { id: "unit-3", status: "failed", analysis: null },
      { id: "unit-4", status: "pending", analysis: null },
    ]);

    expect(metrics).toMatchObject({
      total: 4,
      completed: 3,
      succeeded: 2,
      failed: 1,
      pending: 1,
      mentionRate: 100,
      recommendationRate: 50,
      citationRate: 50,
      evidenceUnitIds: {
        brandMentioned: ["unit-1", "unit-2"],
        brandRecommended: ["unit-2"],
        withCitationEvidence: ["unit-1"],
        failed: ["unit-3"],
      },
    });
    expect(
      aggregateGeoBaselineUnits([
        { id: "failed", status: "failed", analysis: null },
      ]).mentionRate,
    ).toBeNull();
  });
});

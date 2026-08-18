import { describe, expect, it } from "vitest";

import {
  aggregateGeoBaselineUnits,
  analyzeGeoProbeAnswer,
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

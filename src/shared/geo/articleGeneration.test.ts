import { describe, expect, it } from "vitest";

import {
  ARTICLE_GENERATION_CONCURRENCY,
  ARTICLE_GENERATION_POLICY_VERSION,
  buildArticleGenerationMessages,
  combineArticleReview,
  deterministicArticleReview,
  parseArticleReflection,
  parseGeneratedArticleBody,
  validateDirectArticleSource,
} from "./articleGeneration";

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

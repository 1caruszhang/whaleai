import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  ArticleGenerationService,
  mapWithArticleConcurrency,
  type ArticlePersistencePort,
} from "./article-generation";
import {
  ARTICLE_GENERATION_POLICY_VERSION,
  ARTICLE_IMAGE_CANDIDATE_INJECTION_LIMIT,
  type ArticleGenerationContext,
  type ArticleOperationProjection,
  type ArticleProjection,
} from "../../shared/geo/articleGeneration";
import type { MaterialImageAsset } from "../../shared/geo/materialImages";
import type { GeoTextCapability, GeoTextMessage } from "./provider-capabilities";

/** direct 路径先跑标题生成（guide/知识服务，满足 validateTitleCandidates）再跑正文。 */
const TITLE_CANDIDATES = [
  "测试品牌知识服务怎么选",
  "知识服务怎么选看这3点",
  "想做知识服务先搞清这几个问题",
];

type CompleteOptions = Parameters<GeoTextCapability["complete"]>[1];

function directGenerationComplete(
  messages: readonly GeoTextMessage[],
  options?: CompleteOptions,
): string {
  if (options?.purpose === "title-planning") {
    return JSON.stringify({ candidates: TITLE_CANDIDATES });
  }
  return `# ${TITLE_CANDIDATES[0]}\n\n## 定义\n品牌成立10年。\n\n## 清单\n- 核对事实\n- 固定版本`;
}

function article(id: string): ArticleProjection {
  return {
    id,
    operationId: "operation-1",
    workspaceId: "workspace-1",
    sourcePlanItemId: null,
    knowledgeVersion: 7,
    contentType: "guide",
    topic: `主题 ${id}`,
    requestedTitle: `标题 ${id}`,
    constraints: "",
    plannedFacts: [
      {
        factKey: "fact-1",
        predicate: "profile.history",
        normalizedValueJson: '"成立10年"',
      },
    ],
    status: "planned",
    revision: 0,
    approvedRevision: null,
    failureReason: null,
    generationAttempt: 0,
    currentVersion: null,
    approvedVersion: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function operation(articles: ArticleProjection[]): ArticleOperationProjection {
  return {
    id: "operation-1",
    workspaceId: "workspace-1",
    createdBySessionId: "session-1",
    sourceKind: "direct",
    topicPlanId: null,
    topicPlanRevision: null,
    knowledgeVersion: 7,
    policyVersion: "xiaojing-content-prompt-v6",
    status: "running",
    articles,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("article lifecycle concurrency", () => {
  it("keeps FIFO output order and never exceeds five workers", async () => {
    let active = 0;
    let peak = 0;
    const values = Array.from({ length: 13 }, (_, index) => index);
    const result = await mapWithArticleConcurrency(values, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return value * 2;
    });
    expect(peak).toBe(5);
    expect(result).toEqual(values.map((value) => value * 2));
  });
});

describe("ArticleGenerationService", () => {
  it("rejects a ranking draft before persistence when it omits a confirmed competitor", async () => {
    const row: ArticleProjection = {
      ...article("ranking-1"),
      sourcePlanItemId: "plan-ranking-1",
      contentType: "ranking",
      requestedTitle: "2026 年本地服务六家对比",
      plannedFacts: [
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
      ],
    };
    const rankingBody = [
      `# ${row.requestedTitle}`,
      ...[
        "目标品牌",
        "竞品甲",
        "竞品乙",
        "竞品丙",
        "竞品丁",
        "名单外品牌",
      ].flatMap((name, index) => [
        `## ${index + 1}. ${name}`,
        "• **服务范围**：信息",
        "• **核心项目**：信息",
        "• **适用人群**：信息",
        "• **服务方式**：信息",
        "• **区域覆盖**：信息",
        "• **选择要点**：信息",
      ]),
    ].join("\n");
    const port = {
      start: vi.fn(async () => operation([row])),
      getOperation: vi.fn(async () => operation([row])),
      claimGeneration: vi.fn(async () => ({
        article: row,
        brandName: "目标品牌",
        productLine: "本地服务",
        targetRegion: "成都",
        claimToken: "claim-ranking",
      })),
      finishGeneration: vi.fn(),
      failGeneration: vi.fn(async ({ failureReason }) => ({
        ...row,
        status: "generation_failed" as const,
        failureReason,
      })),
    } as unknown as ArticlePersistencePort;
    const generation = {
      slot: "generation",
      complete: vi.fn(async () => rankingBody),
    } satisfies GeoTextCapability;
    const service = new ArticleGenerationService(
      { workspaceId: "workspace-1", sessionId: "session-1" },
      port,
      generation,
      { slot: "reflection", complete: vi.fn() },
    );

    await service.start({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      source: { kind: "confirmed-topic-plan", planId: "plan-1" },
    });

    // ADR-0007 Decision 4：ranking 类型生成调用整篇联网，竞品条目由模型
    // 联网取材；非排行类型不传 webSearch（见 direct 路径用例）。
    expect(generation.complete).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ webSearch: true }),
    );

    expect(port.finishGeneration).not.toHaveBeenCalled();
    expect(port.failGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        failureReason: expect.stringContaining(
          "article_generation_ranking_output_invalid",
        ),
      }),
    );
  });

  it("isolates one provider failure and persists exact per-article retries", async () => {
    const rows = [article("a1"), article("a2")];
    const failed: string[] = [];
    const finished: string[] = [];
    const port = {
      start: vi.fn(async () => operation(rows)),
      latest: vi.fn(async () => operation(rows)),
      getOperation: vi.fn(async () => operation(rows)),
      claimGeneration: vi.fn(async ({ articleId }) => {
        const row = rows.find((candidate) => candidate.id === articleId)!;
        return {
          article: row,
          brandName: "测试品牌",
          productLine: "知识服务",
          targetRegion: "中国",
          claimToken: `claim-${articleId}`,
        } satisfies ArticleGenerationContext;
      }),
      finishGeneration: vi.fn(async ({ articleId }) => {
        finished.push(articleId);
        return { ...rows.find((row) => row.id === articleId)!, status: "draft_ready", revision: 1 };
      }),
      failGeneration: vi.fn(async ({ articleId }) => {
        failed.push(articleId);
        return { ...rows.find((row) => row.id === articleId)!, status: "generation_failed" };
      }),
    } as unknown as ArticlePersistencePort;
    const generation = {
      slot: "generation",
      complete: vi.fn(
        async (messages: readonly GeoTextMessage[], options?: CompleteOptions) => {
          const prompt = messages.map((message) => message.content).join("\n");
          if (prompt.includes("主题 a1")) throw new Error("provider unavailable");
          return directGenerationComplete(messages, options);
        },
      ),
    } satisfies GeoTextCapability;
    const reflection = {
      slot: "reflection",
      complete: vi.fn(),
    } satisfies GeoTextCapability;
    const service = new ArticleGenerationService(
      { workspaceId: "workspace-1", sessionId: "session-1" },
      port,
      generation,
      reflection,
    );
    await service.start({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      source: {
        kind: "direct",
        count: 2,
        themes: ["主题 a1", "主题 a2"],
        contentType: "guide",
        constraints: "",
      },
    });
    expect(failed).toEqual(["a1"]);
    expect(finished).toEqual(["a2"]);
    expect(port.failGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "operation-1",
        articleId: "a1",
        expectedRevision: 0,
      }),
    );
    expect(generation.complete).toHaveBeenCalledWith(
      expect.any(Array),
      { maxTokens: 8_192, temperature: 0.85, topP: 0.9, webSearch: false },
    );
    // direct 路径的标题生成调用（ADR-0006 §2）。
    expect(generation.complete).toHaveBeenCalledWith(
      expect.any(Array),
      { purpose: "title-planning", maxTokens: 2048 },
    );
  });

  it("知识库身份与 workspace 名冲突时，正文 prompt 的品牌行用知识库值（炊班长事故回归）", async () => {
    const row = {
      ...article("a1"),
      plannedFacts: [
        {
          factKey: "fact-1",
          predicate: "profile.history",
          normalizedValueJson: '"成立10年"',
        },
        {
          factKey: "identity-full-name",
          predicate: "brand.fullName",
          normalizedValueJson: '"广州造卤先生餐饮管理有限公司"',
        },
        {
          factKey: "identity-short-names",
          predicate: "brand.shortNames",
          normalizedValueJson: '["造卤先生", "炊班主"]',
        },
      ],
    };
    const rows = [row];
    const bodyPrompts: string[] = [];
    const port = {
      start: vi.fn(async () => operation(rows)),
      latest: vi.fn(async () => operation(rows)),
      getOperation: vi.fn(async () => operation(rows)),
      claimGeneration: vi.fn(async () => ({
        article: row,
        brandName: "炊班长",
        productLine: "知识服务",
        targetRegion: "中国",
        claimToken: "claim-a1",
      })),
      finishGeneration: vi.fn(async () => ({ ...row, status: "draft_ready", revision: 1 })),
      failGeneration: vi.fn(),
    } as unknown as ArticlePersistencePort;
    const generation = {
      slot: "generation",
      complete: vi.fn(
        async (messages: readonly GeoTextMessage[], options?: CompleteOptions) => {
          if (options?.purpose !== "title-planning") {
            bodyPrompts.push(messages.map((message) => message.content).join("\n"));
          }
          return directGenerationComplete(messages, options);
        },
      ),
    } satisfies GeoTextCapability;
    const service = new ArticleGenerationService(
      { workspaceId: "workspace-1", sessionId: "session-1" },
      port,
      generation,
      { slot: "reflection", complete: vi.fn() },
    );
    await service.start({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      source: {
        kind: "direct",
        count: 1,
        themes: ["主题 a1"],
        contentType: "guide",
        constraints: "",
      },
    });
    expect(bodyPrompts).toHaveLength(1);
    expect(bodyPrompts[0]).toContain("品牌：广州造卤先生餐饮管理有限公司");
    expect(bodyPrompts[0]).not.toContain("品牌：炊班长");
  });

  it("returns its exact operation when two brand Sessions interleave", async () => {
    const articleA = { ...article("article-a"), operationId: "operation-a" };
    const articleB = { ...article("article-b"), operationId: "operation-b" };
    const operationA = {
      ...operation([articleA]),
      id: "operation-a",
      createdBySessionId: "session-a",
    };
    const operationB = {
      ...operation([articleB]),
      id: "operation-b",
      createdBySessionId: "session-b",
    };
    const operations = new Map([
      [operationA.id, operationA],
      [operationB.id, operationB],
    ]);
    let latest = operationA;
    const makePort = (created: ArticleOperationProjection): ArticlePersistencePort =>
      ({
        start: vi.fn(async () => {
          latest = created;
          return created;
        }),
        latest: vi.fn(async () => latest),
        getOperation: vi.fn(async (operationId: string) => {
          const exact = operations.get(operationId);
          if (!exact) throw new Error("article_generation_operation_not_found");
          return exact;
        }),
        claimGeneration: vi.fn(async ({ articleId }) => {
          const row = created.articles.find((candidate) => candidate.id === articleId)!;
          return {
            article: row,
            brandName: "测试品牌",
            productLine: "知识服务",
            targetRegion: "中国",
            claimToken: `claim-${articleId}`,
          } satisfies ArticleGenerationContext;
        }),
        finishGeneration: vi.fn(async ({ articleId }) => ({
          ...created.articles.find((candidate) => candidate.id === articleId)!,
          status: "draft_ready" as const,
          revision: 1,
        })),
      }) as unknown as ArticlePersistencePort;
    let markAStarted!: () => void;
    let releaseA!: () => void;
    const aStarted = new Promise<void>((resolve) => {
      markAStarted = resolve;
    });
    const aCanFinish = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const generationA = {
      slot: "generation",
      complete: vi.fn(
        async (messages: readonly GeoTextMessage[], options?: CompleteOptions) => {
          markAStarted();
          await aCanFinish;
          return directGenerationComplete(messages, options);
        },
      ),
    } satisfies GeoTextCapability;
    const generationB = {
      slot: "generation",
      complete: vi.fn(
        async (messages: readonly GeoTextMessage[], options?: CompleteOptions) =>
          directGenerationComplete(messages, options),
      ),
    } satisfies GeoTextCapability;
    const portA = makePort(operationA);
    const portB = makePort(operationB);
    const serviceA = new ArticleGenerationService(
      { workspaceId: "workspace-1", sessionId: "session-a" },
      portA,
      generationA,
      { slot: "reflection", complete: vi.fn() } satisfies GeoTextCapability,
    );
    const serviceB = new ArticleGenerationService(
      { workspaceId: "workspace-1", sessionId: "session-b" },
      portB,
      generationB,
      { slot: "reflection", complete: vi.fn() } satisfies GeoTextCapability,
    );

    const pendingA = serviceA.start({
      workspaceId: "workspace-1",
      sessionId: "session-a",
      source: {
        kind: "direct",
        count: 1,
        themes: ["主题 A"],
        contentType: "guide",
        constraints: "",
      },
    });
    await aStarted;
    const resultB = await serviceB.start({
      workspaceId: "workspace-1",
      sessionId: "session-b",
      source: {
        kind: "direct",
        count: 1,
        themes: ["主题 B"],
        contentType: "guide",
        constraints: "",
      },
    });
    expect(latest.id).toBe("operation-b");
    releaseA();
    const resultA = await pendingA;

    expect(resultA.id).toBe("operation-a");
    expect(resultB.id).toBe("operation-b");
    expect(portA.getOperation).toHaveBeenCalledWith("operation-a");
    expect(portB.getOperation).toHaveBeenCalledWith("operation-b");
    expect(portA.latest).not.toHaveBeenCalled();
    expect(portB.latest).not.toHaveBeenCalled();
  });

  it("keeps deterministic fact/ad-law gates blocking when reflection says pass", async () => {
    const draft = {
      ...article("a-review"),
      status: "draft_ready" as const,
      revision: 1,
    };
    const finishReview = vi.fn(async ({ passed }: { passed: boolean }) => ({
      ...draft,
      status: passed ? ("approved" as const) : ("rejected" as const),
    }));
    const port = {
      claimReview: vi.fn(async () => ({
        context: {
          article: draft,
          brandName: "测试品牌",
          productLine: "知识服务",
          targetRegion: "中国",
          claimToken: "review-claim",
        },
        body: {
          articleId: draft.id,
          revision: 1,
          title: draft.requestedTitle,
          body: [
            `# ${draft.requestedTitle}`,
            "",
            "## 核心结论",
            "测试品牌服务100家客户，是行业第一。",
            "",
            "## 执行清单",
            "- 核对事实",
            "- 固定版本",
          ].join("\n"),
          approved: false,
        },
      })),
      finishReview,
    } as unknown as ArticlePersistencePort;
    const reflection = {
      slot: "reflection",
      complete: vi.fn(async () =>
        JSON.stringify({
          semanticQuality: { pass: true, reason: "语义完整" },
          factConsistency: {
            pass: true,
            unsupportedClaims: [],
            reason: "模型认为通过",
          },
          advertisingLaw: { pass: true, risks: [], reason: "模型认为通过" },
          geoCitability: { pass: true, reason: "结构清晰" },
        }),
      ),
    } satisfies GeoTextCapability;
    const service = new ArticleGenerationService(
      { workspaceId: "workspace-1", sessionId: "session-1" },
      port,
      { slot: "generation", complete: vi.fn() } satisfies GeoTextCapability,
      reflection,
    );

    const result = await service.approve({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      operationId: "operation-1",
      articleId: draft.id,
      expectedRevision: 1,
    });

    expect(result.status).toBe("rejected");
    expect(finishReview).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "operation-1",
        articleId: draft.id,
        expectedRevision: 1,
        claimToken: "review-claim",
        passed: false,
        review: expect.objectContaining({
          passed: false,
          issues: expect.arrayContaining([
            expect.objectContaining({ category: "fact-consistency" }),
            expect.objectContaining({ category: "advertising-law" }),
          ]),
        }),
      }),
    );
  });

  it("fails review closed when the reflection provider response is invalid", async () => {
    const draft = {
      ...article("a-reflection"),
      status: "draft_ready" as const,
      revision: 1,
    };
    const finishReview = vi.fn(async ({ passed }: { passed: boolean }) => ({
      ...draft,
      status: passed ? ("approved" as const) : ("rejected" as const),
    }));
    const port = {
      claimReview: vi.fn(async () => ({
        context: {
          article: draft,
          brandName: "测试品牌",
          productLine: "知识服务",
          targetRegion: "中国",
          claimToken: "review-claim",
        },
        body: {
          articleId: draft.id,
          revision: 1,
          title: draft.requestedTitle,
          body: `# ${draft.requestedTitle}\n\n## 定义\n知识服务。\n\n## 清单\n- 核对事实\n- 固定版本\n\n## 场景\n- 团队协作`,
          approved: false,
        },
      })),
      finishReview,
    } as unknown as ArticlePersistencePort;
    const service = new ArticleGenerationService(
      { workspaceId: "workspace-1", sessionId: "session-1" },
      port,
      { slot: "generation", complete: vi.fn() } satisfies GeoTextCapability,
      {
        slot: "reflection",
        complete: vi.fn(async () => "not-json"),
      } satisfies GeoTextCapability,
    );

    await service.approve({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      operationId: "operation-1",
      articleId: draft.id,
      expectedRevision: 1,
    });

    // 用户裁定（2026-08-18）：审核先只做格式确定性检查，反思 LLM 暂停——
    // 反思 provider 即便返回坏 JSON 也不参与裁决，格式合格即通过。
    expect(finishReview).toHaveBeenCalledWith(
      expect.objectContaining({
        passed: true,
        review: expect.objectContaining({
          passed: true,
          issues: [],
        }),
      }),
    );
    expect(
      (finishReview.mock.calls[0]?.[0] as { review?: { reflection?: unknown } })
        .review?.reflection,
    ).toBeUndefined();
  });
});

describe("ArticleGenerationService material-image candidates (ADR-0008 T4)", () => {
  /** 独立图片候选（候选池地基的资产形态）：材料图片资产直传提示词。 */
  function pooledImageAsset(
    id: string,
    description: string,
    sourceMaterialName: string,
    category: MaterialImageAsset["category"] = "product-photo",
  ): MaterialImageAsset {
    return {
      id,
      workspaceId: "workspace-1",
      sha256: `sha256-${id}`,
      fileExt: "png",
      mediaType: "image/png",
      byteSize: 2048,
      width: 1024,
      height: 768,
      description,
      category,
      sourceMaterialId: `material-${id}`,
      sourceMaterialName,
      relativePath: `media/images/${id}.png`,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
  }

  const pooledCandidates = [
    pooledImageAsset(
      "9f1c2ab4-52d8-4f6e-8a90-1c2d3e4f5a6b",
      "红色门头的门店外景实拍",
      "品牌手册.docx",
      "scene",
    ),
    pooledImageAsset(
      "0a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
      "产品三件套陈列台面",
      "产品图集.pptx",
    ),
  ];

  /** confirmed-topic-plan 路径（无标题生成腿）+ 回声正文：把 prompt 里的
   * 候选清单按 material-image 占位符逐张写回正文——模拟生成模型按契约
   * 选图，闭环演示候选池 → 提示词 → 占位符正文 → 落库。 */
  function echoIllustrationComplete(
    messages: readonly GeoTextMessage[],
  ): string {
    const prompt = messages.map((message) => message.content).join("\n");
    const ids = [...prompt.matchAll(/- 图片ID ([0-9a-f-]{36})/g)].map(
      (match) => match[1],
    );
    const images = ids
      .map((id) => `![与段落语义相关的配图](material-image://${id})`)
      .join("\n\n");
    return [
      "# 配图演示标题",
      "",
      "## 定义",
      "说明文字一段。",
      "",
      images,
      "",
      "## 清单",
      "- 核对事实",
      "- 固定版本",
    ].join("\n");
  }

  function illustrationPort(row: ArticleProjection) {
    const bodyPrompts: string[] = [];
    const finishGeneration = vi.fn(
      async (_input: { operationId: string; articleId: string; body: string }) => ({
        ...row,
        status: "draft_ready" as const,
        revision: 1,
      }),
    );
    const failGeneration = vi.fn(
      async ({ failureReason }: { failureReason: string }) => ({
        ...row,
        status: "generation_failed" as const,
        failureReason,
      }),
    );
    return {
      bodyPrompts,
      finishGeneration,
      failGeneration,
      port: {
        start: vi.fn(async () => operation([row])),
        getOperation: vi.fn(async () => operation([row])),
        claimGeneration: vi.fn(
          async () =>
            ({
              article: row,
              brandName: "测试品牌",
              productLine: "知识服务",
              targetRegion: "中国",
              claimToken: "claim-img",
            }) satisfies ArticleGenerationContext,
        ),
        finishGeneration,
        failGeneration,
      } as unknown as ArticlePersistencePort,
    };
  }

  it("生成链消费独立图片候选，产出一篇含 material-image 占位符的文章（AC5 演示）", async () => {
    const row = {
      ...article("img-1"),
      sourcePlanItemId: "plan-img-1",
      requestedTitle: "配图演示标题",
    };
    const { port, bodyPrompts, finishGeneration } = illustrationPort(row);
    const generation = {
      slot: "generation",
      complete: vi.fn(async (messages: readonly GeoTextMessage[]) => {
        const prompt = messages.map((message) => message.content).join("\n");
        bodyPrompts.push(prompt);
        return echoIllustrationComplete(messages);
      }),
    } satisfies GeoTextCapability;
    const service = new ArticleGenerationService(
      { workspaceId: "workspace-1", sessionId: "session-1" },
      port,
      generation,
      { slot: "reflection", complete: vi.fn() },
      undefined,
      async () => pooledCandidates,
    );

    await service.start({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      source: { kind: "confirmed-topic-plan", planId: "plan-1" },
    });

    // 候选清单与配图纪律都进了正文提示词（接缝二）。
    expect(bodyPrompts).toHaveLength(1);
    expect(bodyPrompts[0]).toContain("配图纪律（必须完全满足）");
    expect(bodyPrompts[0]).toContain("配图候选清单");
    for (const candidate of pooledCandidates) {
      expect(bodyPrompts[0]).toContain(candidate.id);
      expect(bodyPrompts[0]).toContain(candidate.description);
      expect(bodyPrompts[0]).toContain(candidate.sourceMaterialName);
    }
    // 正文以 markdown 图片语法携带占位符并通过解析落库（parse 放行该 scheme）。
    expect(port.failGeneration).not.toHaveBeenCalled();
    expect(finishGeneration).toHaveBeenCalledTimes(1);
    const finishedBody = (finishGeneration.mock.calls[0]?.[0] as {
      body: string;
    }).body;
    for (const candidate of pooledCandidates) {
      expect(finishedBody).toContain(
        `![与段落语义相关的配图](material-image://${candidate.id})`,
      );
    }
  });

  it("无候选时零配图照常生成（提示词不含配图块）", async () => {
    const row = {
      ...article("img-0"),
      sourcePlanItemId: "plan-img-0",
      requestedTitle: "配图演示标题",
    };
    const { port, bodyPrompts } = illustrationPort(row);
    const generation = {
      slot: "generation",
      complete: vi.fn(async (messages: readonly GeoTextMessage[]) => {
        const prompt = messages.map((message) => message.content).join("\n");
        bodyPrompts.push(prompt);
        return "# 配图演示标题\n\n## 定义\n说明。\n\n## 清单\n- 项";
      }),
    } satisfies GeoTextCapability;
    const service = new ArticleGenerationService(
      { workspaceId: "workspace-1", sessionId: "session-1" },
      port,
      generation,
      { slot: "reflection", complete: vi.fn() },
      undefined,
      async () => [],
    );

    await service.start({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      source: { kind: "confirmed-topic-plan", planId: "plan-1" },
    });

    expect(bodyPrompts[0]).not.toContain("配图候选清单");
    expect(bodyPrompts[0]).not.toContain("配图纪律");
    expect(port.failGeneration).not.toHaveBeenCalled();
    expect(port.finishGeneration).toHaveBeenCalledTimes(1);
  });

  it("候选池获取失败降级为零配图，不阻塞生成主链（ADR-0008 降级路径）", async () => {
    const row = {
      ...article("img-down"),
      sourcePlanItemId: "plan-img-down",
      requestedTitle: "配图演示标题",
    };
    const { port, bodyPrompts } = illustrationPort(row);
    const generation = {
      slot: "generation",
      complete: vi.fn(async (messages: readonly GeoTextMessage[]) => {
        const prompt = messages.map((message) => message.content).join("\n");
        bodyPrompts.push(prompt);
        return "# 配图演示标题\n\n## 定义\n说明。\n\n## 清单\n- 项";
      }),
    } satisfies GeoTextCapability;
    const service = new ArticleGenerationService(
      { workspaceId: "workspace-1", sessionId: "session-1" },
      port,
      generation,
      { slot: "reflection", complete: vi.fn() },
      undefined,
      async () => {
        throw new Error("material candidate listing unavailable");
      },
    );

    await service.start({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      source: { kind: "confirmed-topic-plan", planId: "plan-1" },
    });

    expect(bodyPrompts[0]).not.toContain("配图候选清单");
    expect(port.failGeneration).not.toHaveBeenCalled();
    expect(port.finishGeneration).toHaveBeenCalledTimes(1);
  });

  it("注入候选清单按注入上限截断（提示词预算护栏）", async () => {
    const row = {
      ...article("img-cap"),
      sourcePlanItemId: "plan-img-cap",
      requestedTitle: "配图演示标题",
    };
    const { port, bodyPrompts } = illustrationPort(row);
    const many = Array.from(
      { length: ARTICLE_IMAGE_CANDIDATE_INJECTION_LIMIT + 10 },
      (_, index) =>
        pooledImageAsset(
          `cand-${String(index).padStart(4, "0")}`,
          `候选图 ${index}`,
          "大图集.pptx",
        ),
    );
    const generation = {
      slot: "generation",
      complete: vi.fn(async (messages: readonly GeoTextMessage[]) => {
        const prompt = messages.map((message) => message.content).join("\n");
        bodyPrompts.push(prompt);
        return "# 配图演示标题\n\n## 定义\n说明。\n\n## 清单\n- 项";
      }),
    } satisfies GeoTextCapability;
    const service = new ArticleGenerationService(
      { workspaceId: "workspace-1", sessionId: "session-1" },
      port,
      generation,
      { slot: "reflection", complete: vi.fn() },
      undefined,
      async () => many,
    );

    await service.start({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      source: { kind: "confirmed-topic-plan", planId: "plan-1" },
    });

    const injected = bodyPrompts[0].match(/- 图片ID /g) ?? [];
    expect(injected).toHaveLength(ARTICLE_IMAGE_CANDIDATE_INJECTION_LIMIT);
    expect(bodyPrompts[0]).toContain("- 图片ID cand-0000");
    expect(bodyPrompts[0]).not.toContain(
      `- 图片ID cand-${String(ARTICLE_IMAGE_CANDIDATE_INJECTION_LIMIT).padStart(4, "0")}`,
    );
  });
});

describe("article generation policy version contract with BrandWorkspace", () => {
  it("stamps geo_article_operations with the policy version the Sidecar reports in model audit", () => {
    const rust = readFileSync(
      fileURLToPath(
        new URL("../../../src-tauri/src/brand_workspace/articles.rs", import.meta.url),
      ),
      "utf8",
    );
    const declared = rust.match(/const POLICY_VERSION: &str = "([^"]+)";/);
    expect(declared?.[1]).toBe(ARTICLE_GENERATION_POLICY_VERSION);
  });
});

describe("ArticleGenerationService billing permits (ticket 07)", () => {
  function permitPort() {
    const calls: Array<
      | { kind: "apply"; permitId: string; operation: string; units: number }
      | { kind: "report"; permitId: string; unit: number; outcome: string }
      | { kind: "close"; permitId: string }
    > = [];
    return {
      calls,
      port: {
        async apply(input: { permitId: string; operation: string; units: number }) {
          calls.push({ kind: "apply", ...input });
          return {
            permitId: input.permitId,
            operation: input.operation,
            units: input.units,
            totalPoints: 20 * input.units,
            status: "open" as const,
            frozenPoints: 20 * input.units,
            consumedPoints: 0,
            refundedPoints: 0,
          };
        },
        async reportUnit(permitId: string, unit: number, outcome: string) {
          calls.push({ kind: "report", permitId, unit, outcome });
        },
        async close(permitId: string) {
          calls.push({ kind: "close", permitId });
        },
      },
    };
  }

  function billedPort(rows: ArticleProjection[], failArticles: string[] = []) {
    const finished: string[] = [];
    const failed: string[] = [];
    const claimAttempt = new Map<string, number>();
    const port = {
      start: vi.fn(async () => operation(rows)),
      getOperation: vi.fn(async () => operation(rows)),
      claimGeneration: vi.fn(async ({ articleId }: { articleId: string }) => {
        const row = rows.find((candidate) => candidate.id === articleId)!;
        const attempt = (claimAttempt.get(articleId) ?? row.generationAttempt) + 1;
        claimAttempt.set(articleId, attempt);
        return {
          article: { ...row, generationAttempt: attempt },
          brandName: "测试品牌",
          productLine: "知识服务",
          targetRegion: "中国",
          claimToken: `claim-${articleId}-${attempt}`,
        } satisfies ArticleGenerationContext;
      }),
      finishGeneration: vi.fn(async ({ articleId }: { articleId: string }) => {
        finished.push(articleId);
        return { ...rows.find((row) => row.id === articleId)!, status: "draft_ready", revision: 1 };
      }),
      failGeneration: vi.fn(async ({ articleId }: { articleId: string }) => {
        failed.push(articleId);
        return { ...rows.find((row) => row.id === articleId)!, status: "generation_failed" };
      }),
      get: vi.fn(async (operationId: string, articleId: string) =>
        rows.find((row) => row.id === articleId)!),
    } as unknown as ArticlePersistencePort;
    const generation = {
      slot: "generation",
      complete: vi.fn(async (messages: readonly GeoTextMessage[], options?: CompleteOptions) => {
        const prompt = messages.map((message) => message.content).join("\n");
        const target = failArticles.find((id) => prompt.includes(`主题 ${id}`));
        // 标题腿（title-planning purpose）保持成功，让损坏文章走到正文生成
        // 才失败——单篇成败按整篇回报。
        if (target && options?.purpose !== "title-planning") throw new Error("provider unavailable");
        return directGenerationComplete(messages, options);
      }),
    } satisfies GeoTextCapability;
    return { port, generation, finished, failed };
  }

  it("applies one batch permit for the operation and reports each article by index", async () => {
    const rows = [article("a1"), article("a2")];
    const { port, generation } = billedPort(rows);
    const permits = permitPort();
    const service = new ArticleGenerationService(
      { workspaceId: "workspace-1", sessionId: "session-1" },
      port,
      generation,
      { slot: "reflection", complete: vi.fn() } satisfies GeoTextCapability,
      permits.port,
    );

    await service.start({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      source: {
        kind: "direct",
        count: 2,
        themes: ["主题 a1", "主题 a2"],
        contentType: "guide",
        constraints: "",
      },
    });

    expect(permits.calls[0]).toEqual({
      kind: "apply",
      permitId: "article:operation-1:initial",
      operation: "article_generation",
      units: 2,
    });
    const reports = permits.calls.filter((call) => call.kind === "report");
    expect(reports).toHaveLength(2);
    expect(reports).toContainEqual({
      kind: "report",
      permitId: "article:operation-1:initial",
      unit: 0,
      outcome: "success",
    });
    expect(reports).toContainEqual({
      kind: "report",
      permitId: "article:operation-1:initial",
      unit: 1,
      outcome: "success",
    });
    // 收尾结清（全单位已回报时为幂等 no-op）。
    expect(permits.calls.at(-1)).toEqual({
      kind: "close",
      permitId: "article:operation-1:initial",
    });
  });

  it("settles only successful articles when part of the batch fails (10 articles, 3 broken)", async () => {
    const rows = Array.from({ length: 10 }, (_, index) => article(`a${index + 1}`));
    const broken = ["a3", "a5", "a8"];
    const { port, generation, finished, failed } = billedPort(rows, broken);
    const permits = permitPort();
    const service = new ArticleGenerationService(
      { workspaceId: "workspace-1", sessionId: "session-1" },
      port,
      generation,
      { slot: "reflection", complete: vi.fn() } satisfies GeoTextCapability,
      permits.port,
    );

    const operation = await service.start({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      source: {
        kind: "direct",
        count: 10,
        themes: rows.map((row) => `主题 ${row.id}`),
        contentType: "guide",
        constraints: "",
      },
    });

    expect(operation.articles).toHaveLength(10);
    expect(finished).toHaveLength(7);
    expect(failed).toEqual(broken);
    const reports = permits.calls.filter((call) => call.kind === "report") as Array<{
      unit: number;
      outcome: string;
    }>;
    expect(reports).toHaveLength(10);
    const successUnits = reports.filter((report) => report.outcome === "success");
    const failureUnits = reports.filter((report) => report.outcome === "failure");
    expect(successUnits).toHaveLength(7);
    expect(failureUnits).toHaveLength(3);
    // 失败单位对应损坏文章在批次中的下标（标题生成在 direct 路径总是成功，
    // 正文损坏 → 整篇按失败回报）。
    expect(new Set(failureUnits.map((report) => report.unit))).toEqual(new Set([2, 4, 7]));
  });

  it("bills retry/regenerate as article_rewrite keyed by the claim attempt", async () => {
    const rows = [article("a1")];
    const { port, generation } = billedPort(rows);
    const permits = permitPort();
    const service = new ArticleGenerationService(
      { workspaceId: "workspace-1", sessionId: "session-1" },
      port,
      generation,
      { slot: "reflection", complete: vi.fn() } satisfies GeoTextCapability,
      permits.port,
    );

    await service.retry({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      operationId: "operation-1",
      articleId: "a1",
      expectedRevision: 0,
    });

    expect(permits.calls).toEqual([
      { kind: "apply", permitId: "art-rw:operation-1:a1:1", operation: "article_rewrite", units: 1 },
      { kind: "report", permitId: "art-rw:operation-1:a1:1", unit: 0, outcome: "success" },
    ]);
  });
});

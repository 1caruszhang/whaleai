import { describe, expect, it, vi } from "vitest";

import {
  ArticleGenerationService,
  mapWithArticleConcurrency,
  type ArticlePersistencePort,
} from "./article-generation";
import type {
  ArticleGenerationContext,
  ArticleOperationProjection,
  ArticleProjection,
} from "../../shared/geo/articleGeneration";
import type { GeoTextCapability, GeoTextMessage } from "./provider-capabilities";

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
    policyVersion: "js-ai-dev-direct-article-generation-v1",
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
      complete: vi.fn(async (messages: readonly GeoTextMessage[]) => {
        const prompt = messages.map((message) => message.content).join("\n");
        if (prompt.includes("标题 a1")) throw new Error("provider unavailable");
        return "# 标题 a2\n\n## 定义\n品牌成立10年。\n\n## 清单\n- 核对事实\n- 固定版本";
      }),
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
      { maxTokens: 8_192, temperature: 0.85, topP: 0.9 },
    );
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
      complete: vi.fn(async () => {
        markAStarted();
        await aCanFinish;
        return "# 标题 article-a\n\n## 定义\n知识服务。\n\n## 清单\n- 核对事实\n- 固定版本";
      }),
    } satisfies GeoTextCapability;
    const generationB = {
      slot: "generation",
      complete: vi.fn(async () =>
        "# 标题 article-b\n\n## 定义\n知识服务。\n\n## 清单\n- 核对事实\n- 固定版本",
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
          body: `# ${draft.requestedTitle}\n\n## 定义\n知识服务。\n\n## 清单\n- 核对事实\n- 固定版本`,
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

    expect(finishReview).toHaveBeenCalledWith(
      expect.objectContaining({
        passed: false,
        review: expect.objectContaining({
          passed: false,
          reflection: expect.objectContaining({
            semanticQuality: expect.objectContaining({ pass: false }),
          }),
        }),
      }),
    );
  });
});

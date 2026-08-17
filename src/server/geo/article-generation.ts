import {
  ARTICLE_GENERATION_CONCURRENCY,
  ARTICLE_GENERATION_POLICY_VERSION,
  buildArticleGenerationMessages,
  buildArticleReflectionMessages,
  combineArticleReview,
  deterministicArticleReview,
  parseArticleReflection,
  parseGeneratedArticleBody,
  validateDirectArticleSource,
  type ArticleBodyProjection,
  type ArticleGenerationContext,
  type ArticleOperationProjection,
  type ArticleOperationSource,
  type ArticleProjection,
  type ArticleReviewResult,
} from "../../shared/geo/articleGeneration";
import { XIAOJING_GEO_PROVIDER_DEFAULTS } from "../../shared/geo/providerCapabilities";
import { managementApi } from "../utils/management-api-client";
import type { GeoTextCapability } from "./provider-capabilities";

export interface ArticlePersistencePort {
  latest(): Promise<ArticleOperationProjection | null>;
  getOperation(operationId: string): Promise<ArticleOperationProjection>;
  start(source: ArticleOperationSource): Promise<ArticleOperationProjection>;
  get(operationId: string, articleId: string): Promise<ArticleProjection>;
  claimGeneration(input: {
    operationId: string;
    articleId: string;
    expectedRevision: number;
    mode: "initial" | "regenerate";
  }): Promise<ArticleGenerationContext>;
  finishGeneration(input: {
    operationId: string;
    articleId: string;
    expectedRevision: number;
    claimToken: string;
    title: string;
    body: string;
    modelAudit: Record<string, unknown>;
  }): Promise<ArticleProjection>;
  failGeneration(input: {
    operationId: string;
    articleId: string;
    expectedRevision: number;
    claimToken: string;
    failureReason: string;
  }): Promise<ArticleProjection>;
  edit(input: {
    operationId: string;
    articleId: string;
    expectedRevision: number;
    title: string;
    body: string;
    /** 聊天修订（票 38）携带用户指令原文，写入版本行 model_audit。 */
    reason?: string;
  }): Promise<ArticleProjection>;
  body(input: {
    operationId: string;
    articleId: string;
    revision?: number;
    approved?: boolean;
  }): Promise<ArticleBodyProjection>;
  claimReview(input: {
    operationId: string;
    articleId: string;
    expectedRevision: number;
  }): Promise<{ context: ArticleGenerationContext; body: ArticleBodyProjection }>;
  finishReview(input: {
    operationId: string;
    articleId: string;
    expectedRevision: number;
    claimToken: string;
    review: ArticleReviewResult;
    passed: boolean;
  }): Promise<ArticleProjection>;
}

function persistenceError(result: Record<string, unknown>): Error {
  return new Error(
    typeof result.error === "string"
      ? result.error
      : "article_generation_persistence_failed",
  );
}

export class RustArticlePort implements ArticlePersistencePort {
  constructor(
    private readonly identity: {
      workspaceId: string;
      sessionId: string;
      sidecarId: string;
    },
  ) {}

  private envelope(payload: Record<string, unknown>): Record<string, unknown> {
    return { ...this.identity, payload };
  }

  private async post<T>(
    path: string,
    payload: Record<string, unknown>,
    key: string,
  ): Promise<T> {
    const result = await managementApi(path, "POST", this.envelope(payload));
    if (result.ok !== true) throw persistenceError(result);
    return result[key] as T;
  }

  latest(): Promise<ArticleOperationProjection | null> {
    return this.post("/api/brand-articles/latest", {}, "operation");
  }

  getOperation(operationId: string): Promise<ArticleOperationProjection> {
    return this.post(
      "/api/brand-articles/operation/get",
      { operationId },
      "operation",
    );
  }

  start(source: ArticleOperationSource): Promise<ArticleOperationProjection> {
    return this.post(
      "/api/brand-articles/start",
      source.kind === "confirmed-topic-plan"
        ? {
            sourceKind: source.kind,
            topicPlanId: source.planId,
            directSpec: null,
          }
        : {
            sourceKind: source.kind,
            topicPlanId: null,
            directSpec: {
              count: source.count,
              themes: source.themes,
              contentType: source.contentType,
              constraints: source.constraints,
            },
          },
      "operation",
    );
  }

  get(operationId: string, articleId: string): Promise<ArticleProjection> {
    return this.post(
      "/api/brand-articles/get",
      { operationId, articleId },
      "article",
    );
  }

  claimGeneration(
    input: Parameters<ArticlePersistencePort["claimGeneration"]>[0],
  ): Promise<ArticleGenerationContext> {
    return this.post(
      "/api/brand-articles/generation/claim",
      input,
      "context",
    );
  }

  finishGeneration(
    input: Parameters<ArticlePersistencePort["finishGeneration"]>[0],
  ): Promise<ArticleProjection> {
    return this.post(
      "/api/brand-articles/generation/finish",
      input,
      "article",
    );
  }

  failGeneration(
    input: Parameters<ArticlePersistencePort["failGeneration"]>[0],
  ): Promise<ArticleProjection> {
    return this.post(
      "/api/brand-articles/generation/fail",
      input,
      "article",
    );
  }

  edit(
    input: Parameters<ArticlePersistencePort["edit"]>[0],
  ): Promise<ArticleProjection> {
    return this.post("/api/brand-articles/edit", input, "article");
  }

  body(
    input: Parameters<ArticlePersistencePort["body"]>[0],
  ): Promise<ArticleBodyProjection> {
    return this.post("/api/brand-articles/body", input, "body");
  }

  async claimReview(
    input: Parameters<ArticlePersistencePort["claimReview"]>[0],
  ): Promise<{
    context: ArticleGenerationContext;
    body: ArticleBodyProjection;
  }> {
    const result = await managementApi(
      "/api/brand-articles/review/claim",
      "POST",
      this.envelope(input),
    );
    if (result.ok !== true) throw persistenceError(result);
    return {
      context: result.context as ArticleGenerationContext,
      body: result.body as ArticleBodyProjection,
    };
  }

  finishReview(
    input: Parameters<ArticlePersistencePort["finishReview"]>[0],
  ): Promise<ArticleProjection> {
    return this.post(
      "/api/brand-articles/review/finish",
      input,
      "article",
    );
  }
}

export function createArticlePort(identity: {
  workspaceId: string;
  sessionId: string;
}): RustArticlePort {
  const sidecarId = process.env.XIAOJING_SIDECAR_ID?.trim();
  if (!sidecarId) {
    throw new Error(
      "Article generation requires an authenticated Sidecar identity",
    );
  }
  return new RustArticlePort({ ...identity, sidecarId });
}

export async function mapWithArticleConcurrency<T, R>(
  values: readonly T[],
  worker: (value: T, index: number) => Promise<R>,
  limit = ARTICLE_GENERATION_CONCURRENCY,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("article_generation_concurrency_invalid");
  }
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= values.length) return;
        results[index] = await worker(values[index], index);
      }
    }),
  );
  return results;
}

function safeFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().slice(0, 1_000) || "article_generation_failed";
}

function unavailableReflection(reason: string) {
  return {
    semanticQuality: { pass: false, reason },
    factConsistency: {
      pass: false,
      unsupportedClaims: [],
      reason,
    },
    advertisingLaw: { pass: false, risks: [], reason },
    geoCitability: { pass: false, reason },
  };
}

export class ArticleGenerationService {
  constructor(
    private readonly identity: { workspaceId: string; sessionId: string },
    private readonly persistence: ArticlePersistencePort,
    private readonly generation: GeoTextCapability,
    private readonly reflection: GeoTextCapability,
  ) {}

  private assertIdentity(input: {
    workspaceId: string;
    sessionId: string;
  }): void {
    if (
      input.workspaceId !== this.identity.workspaceId ||
      input.sessionId !== this.identity.sessionId
    ) {
      throw new Error("article_generation_identity_mismatch");
    }
  }

  latest(input: {
    workspaceId: string;
    sessionId: string;
  }): Promise<ArticleOperationProjection | null> {
    this.assertIdentity(input);
    return this.persistence.latest();
  }

  operation(input: {
    workspaceId: string;
    sessionId: string;
    operationId: string;
  }): Promise<ArticleOperationProjection> {
    this.assertIdentity(input);
    return this.persistence.getOperation(input.operationId);
  }

  async start(input: {
    workspaceId: string;
    sessionId: string;
    source: ArticleOperationSource;
  }): Promise<ArticleOperationProjection> {
    this.assertIdentity(input);
    const source =
      input.source.kind === "direct"
        ? validateDirectArticleSource(input.source)
        : input.source;
    const operation = await this.persistence.start(source);
    await mapWithArticleConcurrency(operation.articles, async (article) => {
      await this.generateOne(article, "initial");
    });
    return this.persistence.getOperation(operation.id);
  }

  private async generateOne(
    article: ArticleProjection,
    mode: "initial" | "regenerate",
  ): Promise<ArticleProjection> {
    const context = await this.persistence.claimGeneration({
      operationId: article.operationId,
      articleId: article.id,
      expectedRevision: article.revision,
      mode,
    });
    try {
      const messages = buildArticleGenerationMessages({
        brandName: context.brandName,
        productLine: context.productLine,
        targetRegion: context.targetRegion,
        contentType: context.article.contentType,
        topic: context.article.topic,
        requestedTitle: context.article.requestedTitle,
        constraints: context.article.constraints,
        plannedFacts: context.article.plannedFacts,
      });
      const raw = await this.generation.complete([
        { role: "system", content: messages.system },
        { role: "user", content: messages.user },
      ], {
        maxTokens: 8_192,
        temperature: 0.85,
        topP: 0.9,
      });
      const body = parseGeneratedArticleBody(
        raw,
        context.article.requestedTitle,
      );
      return await this.persistence.finishGeneration({
        operationId: context.article.operationId,
        articleId: context.article.id,
        expectedRevision: context.article.revision,
        claimToken: context.claimToken,
        title: context.article.requestedTitle,
        body,
        modelAudit: {
          policyVersion: ARTICLE_GENERATION_POLICY_VERSION,
          provider: "volcengine",
          capabilitySlot: "generation",
          model: XIAOJING_GEO_PROVIDER_DEFAULTS.generationModel,
          output: "plain-markdown",
          maxTokens: 8_192,
          temperature: 0.85,
          topP: 0.9,
        },
      });
    } catch (error) {
      return this.persistence.failGeneration({
        operationId: context.article.operationId,
        articleId: context.article.id,
        expectedRevision: context.article.revision,
        claimToken: context.claimToken,
        failureReason: safeFailureReason(error),
      });
    }
  }

  async retry(input: {
    workspaceId: string;
    sessionId: string;
    operationId: string;
    articleId: string;
    expectedRevision: number;
  }): Promise<ArticleProjection> {
    this.assertIdentity(input);
    const article = await this.persistence.get(
      input.operationId,
      input.articleId,
    );
    if (article.revision !== input.expectedRevision) {
      throw new Error("article_generation_revision_conflict");
    }
    return this.generateOne(article, "regenerate");
  }

  body(input: {
    workspaceId: string;
    sessionId: string;
    operationId: string;
    articleId: string;
    revision?: number;
    approved?: boolean;
  }): Promise<ArticleBodyProjection> {
    this.assertIdentity(input);
    return this.persistence.body(input);
  }

  edit(input: {
    workspaceId: string;
    sessionId: string;
    operationId: string;
    articleId: string;
    expectedRevision: number;
    title: string;
    body: string;
    /** 聊天修订（票 38）携带用户指令原文，写入版本行 model_audit。 */
    reason?: string;
  }): Promise<ArticleProjection> {
    this.assertIdentity(input);
    const firstLine = input.body.trim().split(/\r?\n/, 1)[0]?.trim();
    if (firstLine !== `# ${input.title.trim()}`) {
      throw new Error("article_generation_title_mismatch");
    }
    return this.persistence.edit(input);
  }

  async approve(input: {
    workspaceId: string;
    sessionId: string;
    operationId: string;
    articleId: string;
    expectedRevision: number;
  }): Promise<ArticleProjection> {
    this.assertIdentity(input);
    const { context, body } = await this.persistence.claimReview(input);
    const deterministic = deterministicArticleReview(
      body.body,
      context.article.plannedFacts,
      context.article.contentType,
    );
    let reflection;
    try {
      const messages = buildArticleReflectionMessages({
        body: body.body,
        facts: context.article.plannedFacts,
        contentType: context.article.contentType,
      });
      reflection = parseArticleReflection(
        await this.reflection.complete([
          { role: "system", content: messages.system },
          { role: "user", content: messages.user },
        ]),
      );
    } catch (error) {
      reflection = unavailableReflection(
        `reflection provider/response unavailable: ${safeFailureReason(error)}`,
      );
    }
    const review = combineArticleReview(deterministic, reflection);
    return this.persistence.finishReview({
      operationId: context.article.operationId,
      articleId: context.article.id,
      expectedRevision: context.article.revision,
      claimToken: context.claimToken,
      review,
      passed: review.passed,
    });
  }
}

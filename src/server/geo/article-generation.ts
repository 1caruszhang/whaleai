import {
  ARTICLE_GENERATION_CONCURRENCY,
  ARTICLE_GENERATION_POLICY_VERSION,
  buildArticleGenerationMessages,
  buildArticleReflectionMessages,
  buildDirectTitleMessages,
  combineArticleReview,
  dealNarrativeSeeds,
  deterministicArticleReview,
  parseArticleReflection,
  parseDirectTitleCandidates,
  parseGeneratedArticleBody,
  normalizeTitleIdentity,
  validateDirectArticleSource,
  type ArticleBodyProjection,
  type ArticleGenerationContext,
  type ArticleNarrativeSeed,
  type ArticleOperationProjection,
  type ArticleOperationSource,
  type ArticleProjection,
  type ArticleReviewResult,
} from "../../shared/geo/articleGeneration";
import {
  deriveServiceScope,
  firstProfileValue,
  isGenericTargetRegion,
  projectBrandProfile,
  renderBrandIdentityBlock,
  resolveBrandName,
} from "../../shared/geo/profileInjection";
import { validateTitleCandidates } from "../../shared/geo/topicPlan";
import { XIAOJING_GEO_PROVIDER_DEFAULTS } from "../../shared/geo/providerCapabilities";

/** 反思 LLM 审核开关：用户裁定（2026-08-18）先只审格式，暂停语义反思。 */
const REFLECTION_REVIEW_ENABLED = false;
import { managementApi } from "../utils/management-api-client";
import type { GeoBillingPermitPort } from "./billing-permit";
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
  // undici 的网络层错误只有泛化的 "fetch failed"，真实原因（ECONNRESET/
  // ETIMEDOUT/UND_ERR_SOCKET…）在 error.cause——不带上就无法事后定位。
  const cause = error instanceof Error ? error.cause : undefined;
  const causeText =
    cause instanceof Error
      ? cause.message
      : cause !== undefined && cause !== null
        ? String(cause)
        : undefined;
  const merged =
    causeText && !message.includes(causeText)
      ? `${message}（cause: ${causeText}）`
      : message;
  return merged.trim().slice(0, 1_000) || "article_generation_failed";
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
    /** 网关计费（票 07）：生成 20/篇、改写 10/篇；缺省时跳过 permit。 */
    private readonly permits?: GeoBillingPermitPort,
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
    /**
     * 逐篇落定钩子（同步）：每篇文章生成结束（成功或失败）后调用，
     * 参数为已落定篇数与总篇数。供上层把真实进度回报给
     * GeoOperation 步骤（进度条随 N/M 移动）；钩子不得抛错阻断批次。
     */
    onArticleSettled?: (settled: number, total: number) => void;
  }): Promise<ArticleOperationProjection> {
    this.assertIdentity(input);
    const source =
      input.source.kind === "direct"
        ? validateDirectArticleSource(input.source)
        : input.source;
    const operation = await this.persistence.start(source);
    // 叙事视角种子按操作洗牌发牌（同批不重复直到发尽，ADR-0006 §3）。
    const seeds = dealNarrativeSeeds(operation.articles.length);
    const total = operation.articles.length;
    let settled = 0;
    const reportSettled = () => {
      settled += 1;
      try {
        input.onArticleSettled?.(settled, total);
      } catch {
        // 进度回报是旁路观测，绝不阻断生成批次。
      }
    };
    // 计费（票 07）：文章生成 20 点/篇，一操作一张批量 permit（并发 5 路
    // 逐篇回报，避免逐篇 permit 撞每账号 2 并发准入）。permitId 绑定
    // operation：恢复重跑（同 operation 重放）不二次预扣；批内未回报单位
    // 在收尾 close 时按失败回补。
    if (!this.permits) {
      await mapWithArticleConcurrency(operation.articles, async (article, index) => {
        await this.generateOne(article, "initial", seeds[index]);
        reportSettled();
      });
      return this.persistence.getOperation(operation.id);
    }
    const permitId = `article:${operation.id}:initial`;
    await this.permits.apply({
      permitId,
      operation: "article_generation",
      units: operation.articles.length,
    });
    try {
      await mapWithArticleConcurrency(operation.articles, async (article, index) => {
        await this.generateOne(article, "initial", seeds[index], {
          permitId,
          unitIndex: index,
        });
        reportSettled();
      });
      return await this.persistence.getOperation(operation.id);
    } finally {
      await this.permits.close(permitId).catch(() => undefined);
    }
  }

  /**
   * direct 路径补标题生成（ADR-0006 §2）：主题字符串只作标题输入，
   * 3–5 候选 → 既有校验 → 取首个有效；失败 fail-loud 走 generation_failed。
   * region/行业从 plannedFacts 投影画像锚定，画像缺服务区时不强制地域锚。
   */
  private async generateDirectTitle(
    context: ArticleGenerationContext,
  ): Promise<string> {
    const profile = projectBrandProfile(context.article.plannedFacts);
    // 品牌名裁决：知识库身份事实优先，workspace 名仅无身份事实时兜底。
    const brandName = resolveBrandName(profile, context.brandName);
    // 地域锚（ADR-0006 修正四）：用派生的服务范围，不再透传原始 serviceArea。
    const region = deriveServiceScope(profile)?.primary ?? context.targetRegion;
    const industry = firstProfileValue(profile, "industry") ?? context.productLine;
    // 业务词锚集（用户裁决 2026-08-19 修正）：品牌产品 + 衍生关键词。
    const businessTerms = [
      ...new Set([
        ...(profile.products ?? []),
        ...(profile.derivedKeywords ?? []),
      ]),
    ].slice(0, 60);
    const currentYear = new Date().getFullYear();
    const messages = buildDirectTitleMessages({
      theme: context.article.topic,
      contentType: context.article.contentType,
      brandName,
      ...(profile.shortNames?.[0] ? { shortName: profile.shortNames[0] } : {}),
      competitors: profile.competitors ?? [],
      industry,
      businessTerms,
      targetRegion: isGenericTargetRegion(region) ? "" : region,
      currentYear,
    });
    const raw = await this.generation.complete(
      [
        { role: "system", content: messages.system },
        { role: "user", content: messages.user },
      ],
      { purpose: "title-planning", maxTokens: 2048 },
    );
    const valid = validateTitleCandidates({
      candidates: parseDirectTitleCandidates(raw),
      contentType: context.article.contentType,
      targetRegion: isGenericTargetRegion(region) ? "" : region,
      industry,
      businessTerms,
      // 校验集合 = 裁决名 + 已确认简称；无身份事实时裁决名即 workspace 兜底名。
      brandNames: [brandName, ...(profile.shortNames ?? [])].filter(Boolean),
      competitors: profile.competitors ?? [],
      currentYear,
    });
    return valid[0];
  }

  private async generateOne(
    article: ArticleProjection,
    mode: "initial" | "regenerate",
    narrativeSeed?: ArticleNarrativeSeed,
    batchPermit?: { permitId: string; unitIndex: number },
  ): Promise<ArticleProjection> {
    const context = await this.persistence.claimGeneration({
      operationId: article.operationId,
      articleId: article.id,
      expectedRevision: article.revision,
      mode,
    });
    // 计费（票 07）：改写/重生成 10 点/篇，单篇独立 permit，permitId 绑定
    // (operation, article, claim attempt)——同一 claim 的网络重试重放同一
    // permit；显式重试是新的 claim attempt（上轮失败已回补）。initial 批次
    // 走调用方预申请的批量 permit 按篇回报。
    let regenPermitId: string | null = null;
    if (this.permits && mode === "regenerate") {
      regenPermitId = `art-rw:${article.operationId}:${article.id}:${context.article.generationAttempt}`;
      try {
        await this.permits.apply({
          permitId: regenPermitId,
          operation: "article_rewrite",
          units: 1,
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
    const reportOutcome = async (outcome: "success" | "failure") => {
      if (!this.permits) return;
      if (regenPermitId) {
        await this.permits
          .reportUnit(regenPermitId, 0, outcome)
          .catch(() => undefined);
      }
      if (batchPermit) {
        await this.permits
          .reportUnit(batchPermit.permitId, batchPermit.unitIndex, outcome)
          .catch(() => undefined);
      }
    };
    try {
      const requestedTitle =
        context.article.sourcePlanItemId === null
          ? await this.generateDirectTitle(context)
          : context.article.requestedTitle;
      const articleProfile = projectBrandProfile(context.article.plannedFacts);
      const identityBlock = renderBrandIdentityBlock(articleProfile);
      const messages = buildArticleGenerationMessages({
        // 品牌名裁决：知识库身份事实优先，workspace 名仅无身份事实时兜底。
        brandName: resolveBrandName(articleProfile, context.brandName),
        productLine: context.productLine,
        targetRegion: context.targetRegion,
        contentType: context.article.contentType,
        topic: context.article.topic,
        requestedTitle,
        constraints: context.article.constraints,
        plannedFacts: context.article.plannedFacts,
        ...(identityBlock ? { identityBlock } : {}),
        ...(narrativeSeed ? { narrativeSeed } : {}),
      });
      // ADR-0007 Decision 4：ranking 类型整篇联网（竞品条目由模型联网取材，
      // 消除名单外的结构性编造）；非排行类型保持离线。目标品牌段落的
      // 「只使用已批准事实」纪律仍在 system prompt 中，属提示词层尽力约束
      // （联网素材渗入目标品牌段落的风险已由用户明示接受，登记于 ADR-0007）。
      const webSearch = context.article.contentType === "ranking";
      const raw = await this.generation.complete([
        { role: "system", content: messages.system },
        { role: "user", content: messages.user },
      ], {
        maxTokens: 8_192,
        temperature: 0.85,
        topP: 0.9,
        webSearch,
      });
      const body = parseGeneratedArticleBody(
        raw,
        requestedTitle,
      );
      if (context.article.contentType === "ranking") {
        const rankingIssues = deterministicArticleReview(
          body,
          context.article.plannedFacts,
          "ranking",
          context.brandName,
        ).filter((issue) => issue.severity === "blocking");
        if (rankingIssues.length > 0) {
          throw new Error(
            `article_generation_ranking_output_invalid:${rankingIssues.map((issue) => issue.message).join("；")}`,
          );
        }
      }
      const finished = await this.persistence.finishGeneration({
        operationId: context.article.operationId,
        articleId: context.article.id,
        expectedRevision: context.article.revision,
        claimToken: context.claimToken,
        title: requestedTitle,
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
          ...(webSearch ? { webSearch: true } : {}),
        },
      });
      await reportOutcome("success");
      return finished;
    } catch (error) {
      const failed = await this.persistence.failGeneration({
        operationId: context.article.operationId,
        articleId: context.article.id,
        expectedRevision: context.article.revision,
        claimToken: context.claimToken,
        failureReason: safeFailureReason(error),
      });
      await reportOutcome("failure");
      return failed;
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
    // 重试也发一颗种子（重洗单张），保持批次内表达多样性。
    const [retrySeed] = dealNarrativeSeeds(1);
    return this.generateOne(article, "regenerate", retrySeed);
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
    if (
      normalizeTitleIdentity(firstLine ?? "") !==
      normalizeTitleIdentity(`# ${input.title.trim()}`)
    ) {
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
      context.brandName,
    );
    // 用户裁定（2026-08-18）：审核先只做格式确定性检查，反思 LLM 审核暂停
    // （省一次 LLM 调用与等待；恢复时改回 REFLECTION_REVIEW_ENABLED=true）。
    if (!REFLECTION_REVIEW_ENABLED) {
      return this.persistence.finishReview({
        operationId: context.article.operationId,
        articleId: context.article.id,
        expectedRevision: context.article.revision,
        claimToken: context.claimToken,
        review: {
          policyVersion: ARTICLE_GENERATION_POLICY_VERSION,
          passed: !deterministic.some((issue) => issue.severity === "blocking"),
          issues: [...deterministic],
        },
        passed: !deterministic.some((issue) => issue.severity === "blocking"),
      });
    }
    let reflection;
    try {
      const messages = buildArticleReflectionMessages({
        body: body.body,
        facts: context.article.plannedFacts,
        contentType: context.article.contentType,
      });
      reflection = parseArticleReflection(
        await this.reflection.complete(
          [
            { role: "system", content: messages.system },
            { role: "user", content: messages.user },
          ],
          { maxTokens: 2048 },
        ),
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

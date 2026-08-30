import {
  TOPIC_PLAN_MAX_CONFIRMED_ITEMS,
  TOPIC_PLAN_MAX_ITEMS,
  TOPIC_PLAN_POLICY_VERSION,
  TOPIC_PLAN_TITLE_BATCH_SIZE,
  buildTitlePlanningPrompt,
  buildTopicClusteringPrompt,
  dealTitleStructureSeeds,
  buildTopicSemanticHints,
  buildTypeRecommendationPrompt,
  isTopicPlanItemProtected,
  mergeRegeneratedTopicPlanItems,
  parseAndEnforceTypeRecommendations,
  parseTitlePlan,
  parseTopicClusters,
  selectDistinctTitles,
  selectContentTypePlannedFacts,
  selectPlannedFacts,
  validateTitleCandidates,
  titleBusinessAnchors,
  type TopicPlanConfirmation,
  type TopicPlanItem,
  type TopicPlanKnowledgeFact,
  type TopicPlanModelAttempt,
  type TopicPlanMutationResult,
  type TopicPlanProjection,
  type TopicPlanSourceQuestion,
  type TopicPlanTopic,
} from "../../shared/geo/topicPlan";
import { XIAOJING_GEO_PROVIDER_DEFAULTS } from "../../shared/geo/providerCapabilities";
import {
  deriveServiceScope,
  projectBrandProfile,
  resolveBrandName,
} from "../../shared/geo/profileInjection";
import { managementApi } from "../utils/management-api-client";
import type { GeoBillingPermitPort } from "./billing-permit";
import { embedWithDegradation } from "./embedding-fallback";
import type {
  GeoEmbeddingCapability,
  GeoTextCapability,
} from "./provider-capabilities";

export interface TopicPlanKnowledgeFactContext extends TopicPlanKnowledgeFact {
  subject: string;
  scopeJson: string;
}

export interface TopicPlanContext {
  questionPoolId: string;
  questionPoolRevision: number;
  knowledgeVersion: number;
  productLine: string;
  targetRegion: string;
  brandName: string;
  questions: TopicPlanSourceQuestion[];
  facts: TopicPlanKnowledgeFactContext[];
}

export interface TopicPlanPreparation {
  context: TopicPlanContext;
  existing: TopicPlanProjection | null;
}

export interface TopicPlanPersistencePort {
  latest(status?: "confirmed"): Promise<TopicPlanProjection | null>;
  get(planId: string): Promise<TopicPlanProjection | null>;
  prepare(questionPoolId?: string): Promise<TopicPlanPreparation>;
  create(input: {
    questionPoolId: string;
    questionPoolRevision: number;
    knowledgeVersion: number;
    policyVersion: typeof TOPIC_PLAN_POLICY_VERSION;
    topics: TopicPlanTopic[];
    items: TopicPlanItem[];
    modelAudit: TopicPlanProjection["modelAudit"];
    providerSnapshot: TopicPlanProjection["providerSnapshot"];
    modelAttempts: TopicPlanModelAttempt[];
  }): Promise<TopicPlanProjection>;
  mutate(input: {
    planId: string;
    expectedRevision: number;
    kind: "user-edit" | "partial-regeneration";
    items: TopicPlanItem[];
    targetItemIds: string[];
    preservedItemIds: string[];
    actorId: "desktop-user" | "geo-domain";
    modelAttempts: TopicPlanModelAttempt[];
    /** 聊天修订（票 38）逐条携带用户指令原文，落 mutations 审计。 */
    reason?: string;
  }): Promise<TopicPlanMutationResult>;
  confirm(input: {
    planId: string;
    expectedRevision: number;
    selectedItemIds: string[];
    actorId: "desktop-user";
  }): Promise<TopicPlanConfirmation>;
}

function persistenceError(result: Record<string, unknown>): Error {
  return new Error(
    typeof result.error === "string"
      ? result.error
      : "topic_plan_persistence_failed",
  );
}

export class RustTopicPlanPort implements TopicPlanPersistencePort {
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

  latest(status?: "confirmed"): Promise<TopicPlanProjection | null> {
    return this.post("/api/brand-topic-plans/latest", { status }, "plan");
  }

  get(planId: string): Promise<TopicPlanProjection | null> {
    return this.post("/api/brand-topic-plans/get", { planId }, "plan");
  }

  prepare(questionPoolId?: string): Promise<TopicPlanPreparation> {
    return this.post(
      "/api/brand-topic-plans/prepare",
      { questionPoolId },
      "preparation",
    );
  }

  create(
    input: Parameters<TopicPlanPersistencePort["create"]>[0],
  ): Promise<TopicPlanProjection> {
    return this.post("/api/brand-topic-plans/create", input, "plan");
  }

  mutate(
    input: Parameters<TopicPlanPersistencePort["mutate"]>[0],
  ): Promise<TopicPlanMutationResult> {
    return this.post("/api/brand-topic-plans/mutate", input, "result");
  }

  confirm(
    input: Parameters<TopicPlanPersistencePort["confirm"]>[0],
  ): Promise<TopicPlanConfirmation> {
    return this.post("/api/brand-topic-plans/confirm", input, "result");
  }
}

export function createTopicPlanPort(identity: {
  workspaceId: string;
  sessionId: string;
}): RustTopicPlanPort {
  const sidecarId = process.env.XIAOJING_SIDECAR_ID?.trim();
  if (!sidecarId) {
    throw new Error("Topic planning requires an authenticated Sidecar identity");
  }
  return new RustTopicPlanPort({ ...identity, sidecarId });
}

function parsedFactValue(fact: TopicPlanKnowledgeFactContext): unknown {
  try {
    return JSON.parse(fact.normalizedValueJson);
  } catch {
    return fact.normalizedValueJson;
  }
}

function strings(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function deriveProfile(context: TopicPlanContext) {
  // 入库 predicate 已被小写化（identity 归一化契约），后缀匹配必须大小写
  // 不敏感——否则 .fullName/.shortNames 失配，品牌名回退到 workspace 名。
  const valuesFor = (suffix: string) =>
    context.facts
      .filter((fact) =>
        fact.predicate.toLowerCase().endsWith(suffix.toLowerCase()),
      )
      .flatMap((fact) => strings(parsedFactValue(fact)));
  const industry = valuesFor(".industry")[0];
  if (!industry) throw new Error("topic_plan_industry_required");
  const projected = projectBrandProfile(context.facts);
  return {
    // 品牌名裁决（与正文/标题同一口径）：知识库身份事实 fullName →
    // shortNames 优先，workspace 名仅无身份事实时兜底。
    brandName: resolveBrandName(projected, context.brandName),
    shortNames: valuesFor(".shortNames"),
    // 标题红线名单含两层竞品（ADR-0007）：排行 roster 潜在层会补位进正文，
    // 标题里同样禁止出现它们的真实品牌名。
    competitors: [
      ...valuesFor(".competitors"),
      ...valuesFor(".potentialcompetitors"),
    ],
    industry,
    // 业务词锚集来源（用户裁决 2026-08-19 修正）：品牌已确认产品与衍生关键词。
    businessTerms: [
      ...new Set([
        ...(projected.products ?? []),
        ...(projected.derivedKeywords ?? []),
      ]),
    ].slice(0, 60),
    // 地域锚（ADR-0006 修正四）：声明服务范围优先于池上透传的 targetRegion，
    // 原始 serviceArea 脏文本不再进入标题提示词与校验。
    region:
      deriveServiceScope(projectBrandProfile(context.facts))?.primary ??
      context.targetRegion,
  };
}

function factEmbeddingText(fact: TopicPlanKnowledgeFact): string {
  return `${fact.predicate} ${fact.normalizedValueJson}`;
}

function topicEmbeddingText(topic: TopicPlanTopic): string {
  return `${topic.name} ${topic.summary} ${topic.searchIntent}`;
}

async function providerCall<T>(execute: () => Promise<T>): Promise<T> {
  try {
    return await execute();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("topic_plan_")) throw error;
    throw new Error(`topic_plan_provider_unavailable:${message}`);
  }
}

function materialItemChanged(
  current: TopicPlanItem,
  incoming: TopicPlanItem,
): boolean {
  return JSON.stringify({
    topicId: current.topicId,
    sourceQuestionIds: current.sourceQuestionIds,
    contentType: current.contentType,
    typeSelectionReason: current.typeSelectionReason,
    title: current.title,
    plannedFacts: current.plannedFacts,
  }) !==
    JSON.stringify({
      topicId: incoming.topicId,
      sourceQuestionIds: incoming.sourceQuestionIds,
      contentType: incoming.contentType,
      typeSelectionReason: incoming.typeSelectionReason,
      title: incoming.title,
      plannedFacts: incoming.plannedFacts,
    });
}

function validateEditableItems(
  plan: TopicPlanProjection,
  incoming: readonly TopicPlanItem[],
): void {
  if (incoming.length === 0 || incoming.length > TOPIC_PLAN_MAX_ITEMS) {
    throw new Error("topic_plan_items_invalid");
  }
  const topicById = new Map(plan.topics.map((topic) => [topic.id, topic]));
  const factKeys = new Set(
    plan.items.flatMap((item) => item.plannedFacts.map((fact) => fact.factKey)),
  );
  const seen = new Set<string>();
  for (const item of incoming) {
    const topic = topicById.get(item.topicId);
    if (
      !item.id.trim() ||
      seen.has(item.id) ||
      !topic ||
      !item.title.trim() ||
      !item.typeSelectionReason.trim() ||
      item.sourceQuestionIds.length === 0 ||
      !item.sourceQuestionIds.every((id) => topic.questionIds.includes(id)) ||
      item.plannedFacts.length === 0 ||
      item.plannedFacts.some((fact) => !factKeys.has(fact.factKey))
    ) {
      throw new Error("topic_plan_item_invalid");
    }
    seen.add(item.id);
  }
}

export function applyTopicPlanUserEdits(
  plan: TopicPlanProjection,
  incoming: readonly TopicPlanItem[],
): TopicPlanItem[] {
  validateEditableItems(plan, incoming);
  const currentById = new Map(plan.items.map((item) => [item.id, item]));
  return incoming.map((item) => {
    const current = currentById.get(item.id);
    if (!current) {
      return {
        ...item,
        titleCandidates: [item.title],
        deduplication: {
          method: "not-evaluated-user-override",
          comparedItemIds: [],
          maxSimilarity: null,
          threshold: item.deduplication.threshold,
        },
        userEdited: true,
        approvalStatus: item.approvalStatus,
        origin: "user",
      };
    }
    const changed = materialItemChanged(current, item);
    return {
      ...item,
      userEdited: current.userEdited || changed,
      approvalStatus: changed ? "draft" : item.approvalStatus,
      origin: current.origin,
      titleCandidates: changed ? [item.title] : item.titleCandidates,
      deduplication: changed
        ? {
            method: "not-evaluated-user-override",
            comparedItemIds: [],
            maxSimilarity: null,
            threshold: item.deduplication.threshold,
          }
        : item.deduplication,
    };
  });
}

interface GeneratedTitleSeed {
  itemId: string;
  topic: TopicPlanTopic;
  contentType: TopicPlanItem["contentType"];
  sourceQuestionIds: string[];
  typeSelectionReason: string;
  plannedFacts: TopicPlanKnowledgeFact[];
}

export class TopicPlanService {
  private readonly generationInFlight = new Map<
    string,
    Promise<TopicPlanProjection>
  >();

  constructor(
    private readonly identity: { workspaceId: string; sessionId: string },
    private readonly persistence: TopicPlanPersistencePort,
    private readonly generation: GeoTextCapability,
    private readonly embedding: GeoEmbeddingCapability,
    private readonly now: () => Date = () => new Date(),
    /** 网关计费（票 07）：初次 20 点/次、重生成 10 点/次；缺省跳过。 */
    private readonly permits?: GeoBillingPermitPort,
  ) {}

  private assertIdentity(input: { workspaceId: string; sessionId: string }) {
    if (
      input.workspaceId !== this.identity.workspaceId ||
      input.sessionId !== this.identity.sessionId
    ) {
      throw new Error("topic_plan_identity_mismatch");
    }
  }

  latest(input: {
    workspaceId: string;
    sessionId: string;
    confirmedOnly?: boolean;
  }): Promise<TopicPlanProjection | null> {
    this.assertIdentity(input);
    return this.persistence.latest(input.confirmedOnly ? "confirmed" : undefined);
  }

  generate(input: {
    workspaceId: string;
    sessionId: string;
    questionPoolId?: string;
  }): Promise<TopicPlanProjection> {
    this.assertIdentity(input);
    const key = input.questionPoolId ?? "latest-confirmed";
    const existing = this.generationInFlight.get(key);
    if (existing) return existing;
    const work = this.generateInitial(input.questionPoolId).finally(() => {
      this.generationInFlight.delete(key);
    });
    this.generationInFlight.set(key, work);
    return work;
  }

  private async generateInitial(
    questionPoolId?: string,
  ): Promise<TopicPlanProjection> {
    const preparation = await this.persistence.prepare(questionPoolId);
    if (preparation.existing) return preparation.existing;
    const { context } = preparation;
    // 计费（票 07）：主题规划初次 20 点/次。permitId 绑定源快照（问题池 +
    // 知识版本）：崩溃/网络重试后重跑同一快照重放同一 permit，不二次预扣；
    // 快照变化即新操作。existing 复用（缓存）已在上面提前返回，不扣点。
    if (!this.permits) return this.runInitialGeneration(context);
    const permitId = `topic:${context.questionPoolId}:${context.questionPoolRevision}:${context.knowledgeVersion}`;
    await this.permits.apply({
      permitId,
      operation: "topic_planning",
      units: 1,
    });
    try {
      const plan = await this.runInitialGeneration(context);
      await this.permits.reportUnit(permitId, 0, "success").catch(
        () => undefined,
      );
      return plan;
    } catch (error) {
      await this.permits.reportUnit(permitId, 0, "failure").catch(
        () => undefined,
      );
      throw error;
    }
  }

  private async runInitialGeneration(
    context: TopicPlanContext,
  ): Promise<TopicPlanProjection> {
    if (context.questions.length === 0) {
      throw new Error("topic_plan_confirmed_questions_required");
    }
    const profile = deriveProfile(context);
    const modelAttempts: TopicPlanModelAttempt[] = [];
    // 瞬时 embedding 故障（网络/超时、429、5xx）回落确定性降级向量继续
    // （WARN 日志在 embedWithDegradation 内）；配置类失败显式抛出。
    const questionEmbedding = await providerCall(() =>
      embedWithDegradation(
        this.embedding,
        context.questions.map((question) => question.text),
        { logTag: "[topic-plan]" },
      ),
    );
    const questionVectors = questionEmbedding.vectors;
    modelAttempts.push({
      stage: "question-embedding",
      provider: "volcengine",
      capabilitySlot: "embedding",
      model: "doubao-embedding-vision",
      status: "success",
      inputCount: context.questions.length,
    });
    const semanticHints = buildTopicSemanticHints(
      context.questions,
      questionVectors,
    );
    const clusterRaw = await providerCall(() =>
      this.generation.complete(
        [
          {
            role: "system",
            content: "只进行语义聚类与主题命名，严格输出结构化 JSON。",
          },
          {
            role: "user",
            content: buildTopicClusteringPrompt({
              brandName: profile.brandName,
              industry: profile.industry,
              productLine: context.productLine,
              targetRegion: profile.region,
              questions: context.questions,
              semanticHints,
            }),
          },
        ],
      ),
    );
    const topics = parseTopicClusters(clusterRaw, context.questions);
    modelAttempts.push({
      stage: "topic-clustering",
      provider: "volcengine",
      capabilitySlot: "generation",
      model: XIAOJING_GEO_PROVIDER_DEFAULTS.generationModel,
      status: "success",
    });
    const typeRaw = await providerCall(() =>
      this.generation.complete([
        {
          role: "system",
          content: "只推荐已定义的五类 GEO 内容类型，严格输出结构化 JSON。",
        },
        {
          role: "user",
          content: buildTypeRecommendationPrompt({
            brandName: profile.brandName,
            industry: profile.industry,
            productLine: context.productLine,
            targetRegion: profile.region,
            topics,
          }),
        },
      ]),
    );
    const recommendations = parseAndEnforceTypeRecommendations(typeRaw, topics);
    modelAttempts.push({
      stage: "type-recommendation",
      provider: "volcengine",
      capabilitySlot: "generation",
      model: XIAOJING_GEO_PROVIDER_DEFAULTS.generationModel,
      status: "success",
    });
    const semanticTexts = [
      ...topics.map(topicEmbeddingText),
      ...context.facts.map(factEmbeddingText),
    ];
    const semanticEmbedding = await providerCall(() =>
      embedWithDegradation(this.embedding, semanticTexts, {
        logTag: "[topic-plan]",
      }),
    );
    const semanticVectors = semanticEmbedding.vectors;
    if (semanticVectors.length !== semanticTexts.length) {
      throw new Error("topic_plan_embedding_count_invalid");
    }
    modelAttempts.push({
      stage: "topic-fact-embedding",
      provider: "volcengine",
      capabilitySlot: "embedding",
      model: "doubao-embedding-vision",
      status: "success",
      inputCount: semanticTexts.length,
    });
    const factVectors = semanticVectors.slice(topics.length);
    const seeds: GeneratedTitleSeed[] = [];
    for (const recommendation of recommendations) {
      const topicIndex = topics.findIndex(
        (topic) => topic.id === recommendation.topicId,
      );
      const topic = topics[topicIndex];
      const plannedFacts = selectPlannedFacts({
        topic,
        topicVector: semanticVectors[topicIndex],
        facts: context.facts,
        factVectors,
      });
      for (const contentType of recommendation.types) {
        const contentTypeFacts = selectContentTypePlannedFacts(
          contentType,
          plannedFacts,
          context.facts,
        );
        seeds.push({
          itemId: `item-${topic.id}-${contentType}`,
          topic,
          contentType,
          sourceQuestionIds: [...topic.questionIds],
          typeSelectionReason:
            recommendation.reasons[contentType] ||
            `该类型适合${topic.searchIntent}搜索意图。`,
          plannedFacts: contentTypeFacts,
        });
      }
    }
    const cappedSeeds = seeds.slice(0, TOPIC_PLAN_MAX_ITEMS);
    const titleGeneration = await this.generateTitlePlans(
      context,
      profile,
      cappedSeeds,
      [],
    );
    modelAttempts.push(...titleGeneration.modelAttempts);
    const items: TopicPlanItem[] = cappedSeeds.map((seed) => {
      const generated = titleGeneration.plans.get(seed.itemId);
      if (!generated) throw new Error("topic_plan_title_item_missing");
      return {
        id: seed.itemId,
        topicId: seed.topic.id,
        sourceQuestionIds: seed.sourceQuestionIds,
        contentType: seed.contentType,
        typeSelectionReason: seed.typeSelectionReason,
        title: generated.title,
        titleCandidates: generated.candidates,
        titleRationale: generated.rationale,
        plannedFacts: seed.plannedFacts,
        deduplication: generated.evidence,
        userEdited: false,
        approvalStatus: "draft",
        origin: "model",
      };
    });
    return this.persistence.create({
      questionPoolId: context.questionPoolId,
      questionPoolRevision: context.questionPoolRevision,
      knowledgeVersion: context.knowledgeVersion,
      policyVersion: TOPIC_PLAN_POLICY_VERSION,
      topics,
      items,
      modelAudit: {
        clustering: "embedding+generation-llm",
        naming: "generation-llm",
        typeRecommendation: "generation-llm",
        titleGeneration: "generation-llm",
        titleDeduplication: "embedding",
      },
      providerSnapshot: {
        generation: {
          provider: "volcengine",
          capabilitySlot: "generation",
          model: XIAOJING_GEO_PROVIDER_DEFAULTS.generationModel,
        },
        titlePlanning: {
          provider: "volcengine",
          capabilitySlot: "generation",
          model: XIAOJING_GEO_PROVIDER_DEFAULTS.titlePlanningModel,
        },
        embedding: {
          provider: "volcengine",
          capabilitySlot: "embedding",
          modelFamily: "doubao-embedding-vision",
          dimensions: this.embedding.dimensions,
        },
        policyVersion: TOPIC_PLAN_POLICY_VERSION,
      },
      modelAttempts,
    });
  }

  private async generateTitlePlans(
    context: TopicPlanContext,
    profile: ReturnType<typeof deriveProfile>,
    seeds: readonly GeneratedTitleSeed[],
    protectedItems: readonly TopicPlanItem[],
  ): Promise<{
    plans: Map<
      string,
      {
        title: string;
        candidates: string[];
        rationale: TopicPlanItem["titleRationale"];
        evidence: TopicPlanItem["deduplication"];
      }
    >;
    modelAttempts: TopicPlanModelAttempt[];
  }> {
    const generated: Array<{
      itemId: string;
      candidates: string[];
      rationale: TopicPlanItem["titleRationale"];
    }> = [];
    const modelAttempts: TopicPlanModelAttempt[] = [];
    const priorTitles = protectedItems.map((item) => item.title);
    // 结构种子批内洗牌发牌（2026-08-18 裁定：每批标题句式不得同构）。
    const structureSeeds = dealTitleStructureSeeds(seeds.length);
    for (let offset = 0; offset < seeds.length; offset += TOPIC_PLAN_TITLE_BATCH_SIZE) {
      const batch = seeds.slice(offset, offset + TOPIC_PLAN_TITLE_BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (seed, indexInBatch) => {
          // 校验不足下限时补一次纠正重试（2026-08-19：业务词锚集下偶发
          // 全灭不再整批失败；corrective 明示必须命中的锚词）。
          const anchors = titleBusinessAnchors({
            industry: profile.industry,
            businessTerms: profile.businessTerms,
          })
            .filter((anchor) => anchor.length >= 3)
            .slice(0, 8);
          const corrective = [
            "上一次候选未通过确定性校验。硬性要求：",
            profile.region
              ? `每条标题必须包含「${profile.region}」；`
              : "",
            `必须逐字包含一个业务词（任选其一）：${anchors.map((anchor) => `「${anchor}」`).join("、") || `「${profile.industry}」`}；`,
            seed.contentType === "ranking"
              ? `必须包含年份「${this.now().getFullYear()}」且不得出现品牌名；`
              : "",
            seed.contentType === "showcase"
              ? `必须包含品牌「${profile.shortNames[0] || profile.brandName}」；`
              : "",
            "不得出现任何极限词（最/第一/唯一/榜等）与竞品名；重新给出 3–5 条彼此句式不同的候选。",
          ]
            .filter(Boolean)
            .join("");
          const complete = async (extra?: string) =>
            providerCall(() =>
              this.generation.complete(
                [
                  {
                    role: "system",
                    content:
                      "你是一位专业的 GEO（生成式引擎优化）标题写作专家。只返回结构化 JSON 标题候选，不要 prose、不要 markdown 代码块、不要输出正文或模板兜底。",
                  },
                  {
                    role: "user",
                    content:
                      buildTitlePlanningPrompt({
                        itemId: seed.itemId,
                        topic: seed.topic,
                        contentType: seed.contentType,
                        sourceQuestions: context.questions.filter((question) =>
                          seed.sourceQuestionIds.includes(question.id),
                        ),
                        plannedFacts: seed.plannedFacts,
                        brandName: profile.brandName,
                        shortName: profile.shortNames[0],
                        competitors: profile.competitors,
                        industry: profile.industry,
                        businessTerms: profile.businessTerms,
                        targetRegion: profile.region,
                        currentYear: this.now().getFullYear(),
                        existingTitles: [
                          ...priorTitles,
                          ...generated.map((item) => item.candidates[0]),
                        ],
                        structureHint: structureSeeds[offset + indexInBatch]?.hint,
                      }) + (extra ?? ""),
                  },
                ],
                { purpose: "title-planning", maxTokens: 2048 },
              ),
            );
          let raw = await complete();
          let parsed = parseTitlePlan(raw, seed.itemId);
          const validate = (candidates: string[]) =>
            validateTitleCandidates({
              candidates,
              contentType: seed.contentType,
              targetRegion: profile.region,
              industry: profile.industry,
              businessTerms: profile.businessTerms,
              brandNames: [profile.brandName, ...profile.shortNames],
              competitors: profile.competitors,
              currentYear: this.now().getFullYear(),
            });
          try {
            return { ...parsed, candidates: validate(parsed.candidates) };
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !error.message.startsWith("topic_plan_title_candidates_insufficient")
            ) {
              throw error;
            }
            raw = await complete(corrective);
            parsed = parseTitlePlan(raw, seed.itemId);
            return { ...parsed, candidates: validate(parsed.candidates) };
          }
        }),
      );
      generated.push(...results);
      modelAttempts.push(
        ...results.map((result) => ({
          stage: "title-generation" as const,
          provider: "volcengine" as const,
          capabilitySlot: "generation" as const,
          model: XIAOJING_GEO_PROVIDER_DEFAULTS.titlePlanningModel,
          status: "success" as const,
          itemId: result.itemId,
        })),
      );
    }
    const embeddingEntries = [
      ...protectedItems.map((item) => ({
        key: `${item.id}:${item.title}`,
        text: item.title,
      })),
      ...generated.flatMap((item) =>
        item.candidates.map((candidate) => ({
          key: `${item.itemId}:${candidate}`,
          text: candidate,
        })),
      ),
    ];
    const titleEmbedding = await providerCall(() =>
      embedWithDegradation(
        this.embedding,
        embeddingEntries.map((entry) => entry.text),
        { logTag: "[topic-plan]" },
      ),
    );
    const vectors = titleEmbedding.vectors;
    if (vectors.length !== embeddingEntries.length) {
      throw new Error("topic_plan_title_embedding_count_invalid");
    }
    modelAttempts.push({
      stage: "title-deduplication-embedding",
      provider: "volcengine",
      capabilitySlot: "embedding",
      model: "doubao-embedding-vision",
      status: "success",
      inputCount: embeddingEntries.length,
    });
    const vectorsByKey = Object.fromEntries(
      embeddingEntries.map((entry, index) => [entry.key, vectors[index]]),
    );
    const selections = selectDistinctTitles({
      items: generated,
      vectors: vectorsByKey,
      protectedSelections: protectedItems.map((item) => ({
        itemId: item.id,
        title: item.title,
      })),
    });
    const plans = new Map(
      generated.map((item) => {
        const selection = selections.find(
          (candidate) => candidate.itemId === item.itemId,
        );
        if (!selection) throw new Error("topic_plan_title_selection_missing");
        return [
          item.itemId,
          {
            title: selection.title,
            candidates: item.candidates,
            rationale: item.rationale,
            evidence: selection.evidence,
          },
        ];
      }),
    );
    return { plans, modelAttempts };
  }

  async saveItems(input: {
    workspaceId: string;
    sessionId: string;
    planId: string;
    expectedRevision: number;
    items: TopicPlanItem[];
    /** 聊天修订（票 38）携带用户指令原文写入审计；面板编辑不传。 */
    reason?: string;
  }): Promise<TopicPlanMutationResult> {
    this.assertIdentity(input);
    const plan = await this.requireMutablePlan(input.planId, input.expectedRevision);
    const items = applyTopicPlanUserEdits(plan, input.items);
    return this.persistence.mutate({
      planId: plan.id,
      expectedRevision: input.expectedRevision,
      kind: "user-edit",
      items,
      targetItemIds: items.map((item) => item.id),
      preservedItemIds: [],
      actorId: "desktop-user",
      modelAttempts: [],
      ...(input.reason ? { reason: input.reason } : {}),
    });
  }

  async regenerate(input: {
    workspaceId: string;
    sessionId: string;
    planId: string;
    expectedRevision: number;
    itemIds: string[];
  }): Promise<TopicPlanMutationResult> {
    this.assertIdentity(input);
    const plan = await this.requireMutablePlan(input.planId, input.expectedRevision);
    const targetIds = [...new Set(input.itemIds)];
    if (
      targetIds.length === 0 ||
      targetIds.some((id) => !plan.items.some((item) => item.id === id))
    ) {
      throw new Error("topic_plan_regeneration_targets_invalid");
    }
    const preserved = plan.items.filter(
      (item) => targetIds.includes(item.id) && isTopicPlanItemProtected(item),
    );
    const eligible = plan.items.filter(
      (item) => targetIds.includes(item.id) && !isTopicPlanItemProtected(item),
    );
    // 计费（票 07）：重生成 10 点/次。permitId 绑定 (plan, expectedRevision)：
    // 同一修订的网络重试重放同一 permit；修订号随每次 mutation 递增，下一轮
    // 重生成自然是新计费轮。无可再生条目（全受保护）不发起模型调用，不扣点。
    if (!this.permits || eligible.length === 0) {
      return this.runRegeneration(plan, eligible, preserved, targetIds, input.expectedRevision);
    }
    const permitId = `topic-regen:${plan.id}:${input.expectedRevision}`;
    await this.permits.apply({
      permitId,
      operation: "topic_planning_regen",
      units: 1,
    });
    try {
      const result = await this.runRegeneration(
        plan,
        eligible,
        preserved,
        targetIds,
        input.expectedRevision,
      );
      await this.permits.reportUnit(permitId, 0, "success").catch(
        () => undefined,
      );
      return result;
    } catch (error) {
      await this.permits.reportUnit(permitId, 0, "failure").catch(
        () => undefined,
      );
      throw error;
    }
  }

  private async runRegeneration(
    plan: TopicPlanProjection,
    eligible: TopicPlanItem[],
    preserved: TopicPlanItem[],
    targetIds: string[],
    expectedRevision: number,
  ): Promise<TopicPlanMutationResult> {
    let replacements: TopicPlanItem[] = [];
    let regenerationAttempts: TopicPlanModelAttempt[] = [];
    if (eligible.length > 0) {
      const preparation = await this.persistence.prepare(plan.questionPoolId);
      if (
        preparation.context.questionPoolRevision !== plan.questionPoolRevision ||
        preparation.context.knowledgeVersion !== plan.knowledgeVersion
      ) {
        throw new Error("topic_plan_source_snapshot_changed");
      }
      const profile = deriveProfile(preparation.context);
      const topicById = new Map(plan.topics.map((topic) => [topic.id, topic]));
      const seeds: GeneratedTitleSeed[] = eligible.map((item) => ({
        itemId: item.id,
        topic: topicById.get(item.topicId)!,
        contentType: item.contentType,
        sourceQuestionIds: item.sourceQuestionIds,
        typeSelectionReason: item.typeSelectionReason,
        plannedFacts: item.plannedFacts,
      }));
      const protectedForDedup = plan.items.filter(
        (item) => !eligible.some((candidate) => candidate.id === item.id),
      );
      const generated = await this.generateTitlePlans(
        preparation.context,
        profile,
        seeds,
        protectedForDedup,
      );
      regenerationAttempts = generated.modelAttempts;
      replacements = eligible.map((item) => {
        const title = generated.plans.get(item.id);
        if (!title) throw new Error("topic_plan_title_item_missing");
        return {
          ...item,
          title: title.title,
          titleCandidates: title.candidates,
          titleRationale: title.rationale,
          deduplication: title.evidence,
          userEdited: false,
          approvalStatus: "draft",
          origin: "model",
        };
      });
    }
    const merged = mergeRegeneratedTopicPlanItems({
      currentItems: plan.items,
      replacements,
      targetItemIds: targetIds,
    });
    return this.persistence.mutate({
      planId: plan.id,
      expectedRevision,
      kind: "partial-regeneration",
      items: merged.items,
      targetItemIds: targetIds,
      preservedItemIds: [
        ...new Set([...preserved.map((item) => item.id), ...merged.preservedItemIds]),
      ],
      actorId: "geo-domain",
      modelAttempts: regenerationAttempts,
    });
  }

  async confirm(input: {
    workspaceId: string;
    sessionId: string;
    planId: string;
    expectedRevision: number;
    selectedItemIds: string[];
  }): Promise<TopicPlanConfirmation> {
    this.assertIdentity(input);
    const plan = await this.requireMutablePlan(input.planId, input.expectedRevision);
    const selected = [...new Set(input.selectedItemIds)];
    if (
      selected.length === 0 ||
      selected.length > TOPIC_PLAN_MAX_CONFIRMED_ITEMS ||
      selected.some(
        (id) =>
          !plan.items.some(
            (item) => item.id === id && item.approvalStatus === "approved",
          ),
      )
    ) {
      throw new Error("topic_plan_approved_selection_required");
    }
    return this.persistence.confirm({
      planId: plan.id,
      expectedRevision: plan.revision,
      selectedItemIds: selected,
      actorId: "desktop-user",
    });
  }

  private async requireMutablePlan(
    planId: string,
    expectedRevision: number,
  ): Promise<TopicPlanProjection> {
    const plan = await this.persistence.get(planId);
    if (!plan) throw new Error("topic_plan_not_found");
    if (plan.status === "confirmed") {
      throw new Error("topic_plan_confirmed_immutable");
    }
    if (plan.revision !== expectedRevision) {
      throw new Error("topic_plan_revision_conflict");
    }
    return plan;
  }
}

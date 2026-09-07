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
  type ParsedTitlePlan,
  parseTopicClusters,
  selectDistinctTitles,
  selectContentTypePlannedFacts,
  selectPlannedFacts,
  TopicPlanTitleCandidatesError,
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
  type TopicPlanWireFact,
  type TopicPlanWireItem,
} from "../../shared/geo/topicPlan";
import { GEO_PORT_CONTRACT } from "../../shared/geo/portContract";
import { XIAOJING_GEO_PROVIDER_DEFAULTS } from "../../shared/geo/providerCapabilities";
import { titleRedLineCompetitors } from "../../shared/geo/competitorRoster";
import {
  deriveServiceScope,
  projectBrandProfile,
  resolveBrandName,
} from "../../shared/geo/profileInjection";
import { managementApi } from "../utils/management-api-client";
import { warnCompoundAnchorValues } from "./anchor-patrol";
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
  prepare(
    questionPoolId?: string,
    forceRegenerate?: boolean,
  ): Promise<TopicPlanPreparation>;
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
    /** 「重新生成内容计划」：跳过 create 复用查找、允许同一 source
     * identity 落第二代计划（与 prepare 的 forceRegenerate 同一语义）。 */
    forceRegenerate?: boolean;
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

  prepare(
    questionPoolId?: string,
    forceRegenerate?: boolean,
  ): Promise<TopicPlanPreparation> {
    return this.post(
      "/api/brand-topic-plans/prepare",
      {
        ...(questionPoolId !== undefined ? { questionPoolId } : {}),
        forceRegenerate: forceRegenerate === true,
      },
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
  // 标题红线名单消费名单内核投影（票 #43）：两层原始串联、无身份排除——
  // 禁令名单宁滥勿缺（此前是本文件手卷的后缀拼接，语义未变）。
  const competitors = titleRedLineCompetitors(
    valuesFor(".competitors"),
    valuesFor(".potentialcompetitors"),
  );
  const relatedBrands = valuesFor(".relatedbrands");
  const businessTerms = [
    ...new Set([
      ...(projected.products ?? []),
      ...(projected.derivedKeywords ?? []),
    ]),
  ].slice(0, 60);
  // 地域锚（ADR-0006 修正四）：声明服务范围优先于池上透传的 targetRegion，
  // 原始 serviceArea 脏文本不再进入标题提示词与校验。
  const region =
    deriveServiceScope(projectBrandProfile(context.facts))?.primary ??
    context.targetRegion;
  // 复合值静默拆分（用户裁决 2026-09-01）：不再拦截、不打扰用户，但服务端
  // WARN 留痕（region 锚源同巡）——复合写法说明知识登记口径有歧义，运营侧
  // 可据此回头清理事实。
  warnCompoundAnchorValues("topic-plan", [
    ["industry", industry],
    ["region", region],
    ...businessTerms.map((term) => ["businessTerm", term] as const),
    ...competitors.map((term) => ["competitor", term] as const),
    ...relatedBrands.map((term) => ["relatedBrand", term] as const),
  ]);
  return {
    // 品牌名裁决（与正文/标题同一口径）：知识库身份事实 fullName →
    // shortNames 优先，workspace 名仅无身份事实时兜底。
    brandName: resolveBrandName(projected, context.brandName),
    shortNames: valuesFor(".shortNames"),
    // 标题红线名单含两层竞品（ADR-0007）：排行 roster 潜在层会补位进正文，
    // 标题里同样禁止出现它们的真实品牌名。
    competitors,
    industry,
    // 关联品牌（代理/经销、非竞品）：正文 roster 会排除它（不当中立盘点成
    // 员），ranking 标题品牌禁令覆盖它（用户裁决 2026-09-01）。
    relatedBrands,
    // 业务词锚集来源（用户裁决 2026-08-19 修正）：品牌已确认产品与衍生关键词。
    businessTerms,
    region,
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

/**
 * 结构化输出带反馈修正重试（用户裁决 2026-09-01 少报错）：解析失败先带
 * 错误现场补一轮再放弃——结构化输出的质量问题绝大多数一轮反馈即可纠正，
 * 裸抛会让整次调用在离故障最远的地方以难懂的编码失败。第二轮仍失败则
 * 维持原样抛出（聚类/类型推荐没有条目级降级空间，全批失败是真实语义）。
 */
async function structuredGeneration<T>(input: {
  stage: string;
  messages: Parameters<GeoTextCapability["complete"]>[0];
  parse: (raw: string) => T;
  retryContract: string;
}, complete: GeoTextCapability["complete"]): Promise<T> {
  const raw = await providerCall(() => complete(input.messages));
  try {
    return input.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[topic-plan] ${input.stage} 结构化解析失败（${message}），带反馈重试一次`,
    );
    const retryRaw = await providerCall(() =>
      complete([
        ...input.messages,
        {
          role: "user",
          content: `上一次输出无法解析（${message}）。${input.retryContract}不要 markdown 代码块或任何说明文字。`,
        },
      ]),
    );
    return input.parse(retryRaw);
  }
}

/** 标题候选拒因码 → 纠正重试提示词里的中文说明（与
 * validateTitleCandidates 的 rejected 计数键一一对应）。 */
const TITLE_REJECTION_REASON_LABELS: Readonly<Record<string, string>> = {
  "length-or-duplicate": "超长或彼此重复",
  placeholder: "残留示例占位符",
  "forbidden-term": "含极限词",
  competitor: "含竞品名",
  region: "缺目标地域",
  industry: "缺业务词",
  "showcase-brand": "showcase 缺品牌名",
  "ranking-brand": "ranking 不得带品牌名",
  "ranking-year": "ranking 缺年份",
};

/**
 * 事实集相等（单一语义）：按 predicate 集合排序后比较——事实顺序不是
 * 用户可编辑语义，信封瘦身项与库内顺序也无契约保证。校验层与变更判定
 * 层必须同用本比较器：若一处有序一处无序，重排事实会在校验层放行、
 * 却被变更判定算成 userEdited 并把 approval 重置回 draft。
 */
function samePredicateFacts(
  a: readonly TopicPlanWireFact[],
  b: readonly TopicPlanWireFact[],
): boolean {
  if (a.length !== b.length) return false;
  const sortedPredicates = (facts: readonly TopicPlanWireFact[]) =>
    facts.map((fact) => fact.predicate).sort();
  return sortedPredicates(a).join("\u0000") === sortedPredicates(b).join("\u0000");
}

function materialItemChanged(
  current: TopicPlanItem,
  incoming: TopicPlanWireItem,
): boolean {
  // 信封瘦身项不携带 factKey/normalizedValueJson，深比较整对象会把纯
  // 批准回传误判为内容变更（approval 重置为 draft）——事实只比 predicate
  // 集合（samePredicateFacts），其余可编辑字段逐项比较。
  return (
    current.topicId !== incoming.topicId ||
    current.sourceQuestionIds.length !== incoming.sourceQuestionIds.length ||
    current.sourceQuestionIds.some(
      (id, index) => id !== incoming.sourceQuestionIds[index],
    ) ||
    current.contentType !== incoming.contentType ||
    current.typeSelectionReason !== incoming.typeSelectionReason ||
    current.title !== incoming.title ||
    !samePredicateFacts(current.plannedFacts, incoming.plannedFacts)
  );
}

function validateEditableItems(
  plan: TopicPlanProjection,
  incoming: readonly TopicPlanWireItem[],
): void {
  if (incoming.length === 0 || incoming.length > TOPIC_PLAN_MAX_ITEMS) {
    throw new Error("topic_plan_items_invalid");
  }
  const topicById = new Map(plan.topics.map((topic) => [topic.id, topic]));
  const currentItemById = new Map(plan.items.map((item) => [item.id, item]));
  const planFactKeys = new Set(
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
      item.plannedFacts.length === 0
    ) {
      throw new Error("topic_plan_item_invalid");
    }
    const current = currentItemById.get(item.id);
    if (current) {
      // 既有项：信封瘦身项只带 predicate，与库内当前事实按 predicate
      // 集合一一对应即可（samePredicateFacts，与变更判定层同语义）；
      // 用户不可编辑事实，集合不同即非法。
      if (!samePredicateFacts(item.plannedFacts, current.plannedFacts)) {
        throw new Error("topic_plan_item_invalid");
      }
    } else {
      // 新增项必须携带合法完整 factKey（聊天修订路径构造）。
      if (item.plannedFacts.some((fact) => !("factKey" in fact) || !planFactKeys.has(fact.factKey))) {
        throw new Error("topic_plan_item_invalid");
      }
    }
    seen.add(item.id);
  }
}

export function applyTopicPlanUserEdits(
  plan: TopicPlanProjection,
  incoming: readonly TopicPlanWireItem[],
): TopicPlanItem[] {
  validateEditableItems(plan, incoming);
  const currentById = new Map(plan.items.map((item) => [item.id, item]));
  return incoming.map((item) => {
    const current = currentById.get(item.id);
    if (!current) {
      // 新增项必须完整构造（聊天修订路径自带 rationale 与全量事实）；
      // 信封瘦身项不允许凭空造新项。
      if (!item.titleRationale) {
        throw new Error("topic_plan_item_invalid");
      }
      const completeFacts: TopicPlanKnowledgeFact[] = [];
      for (const fact of item.plannedFacts) {
        if (!("normalizedValueJson" in fact) || typeof fact.normalizedValueJson !== "string") {
          throw new Error("topic_plan_item_invalid");
        }
        completeFacts.push(fact);
      }
      return {
        ...item,
        titleRationale: item.titleRationale,
        plannedFacts: completeFacts,
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
    // 服务端字段权威：既有项的审计字段（titleRationale/titleCandidates）
    // 与事实详情只信库内当前值——回传可能是信封瘦身项，铺开 `...item`
    // 会把库里字段冲成 undefined。用户可改字段（标题/类型/理由/归属
    // 主题/来源问题）在变更分支显式覆盖。
    const changed = materialItemChanged(current, item);
    if (!changed) {
      return { ...current, approvalStatus: item.approvalStatus };
    }
    return {
      ...current,
      topicId: item.topicId,
      sourceQuestionIds: item.sourceQuestionIds,
      contentType: item.contentType,
      typeSelectionReason: item.typeSelectionReason,
      title: item.title,
      titleCandidates: [item.title],
      deduplication: {
        method: "not-evaluated-user-override",
        comparedItemIds: [],
        maxSimilarity: null,
        threshold: item.deduplication.threshold,
      },
      userEdited: true,
      approvalStatus: "draft",
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

/** 单条目标题生成结果：正常/降级产出候选集，或两轮未过审被剔除。 */
type TitleSeedOutcome =
  | {
      dropped: false;
      itemId: string;
      candidates: string[];
      rationale: TopicPlanItem["titleRationale"];
    }
  | { dropped: true; itemId: string; reason: string };

/**
 * 全灭如实重抛（用户裁决 2026-09-01 少报错）：条目级降级的边界——全部
 * 条目都被剔除时本次没有任何可交付物，沉默的空成功比错误更误导，重抛
 * 末次拒因。generate（全计划）与 runRegeneration（局部重生成）共用。
 */
function assertNotAllDropped(
  dropped: ReadonlyArray<{ itemId: string; reason: string }>,
  total: number,
  fallback: string,
): void {
  if (total > 0 && dropped.length === total) {
    throw new Error(dropped.at(-1)?.reason ?? fallback);
  }
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
    /** 卡片「重新生成内容计划」按钮：跳过既有计划复用、强制重新规划
     *（真实 provider 花费）；缺省走复用。 */
    forceRegenerate?: boolean;
  }): Promise<TopicPlanProjection> {
    this.assertIdentity(input);
    const key = input.questionPoolId ?? "latest-confirmed";
    const existing = this.generationInFlight.get(key);
    if (existing) return existing;
    const work = this.generateInitial(input.questionPoolId, input.forceRegenerate).finally(() => {
      this.generationInFlight.delete(key);
    });
    this.generationInFlight.set(key, work);
    return work;
  }

  private async generateInitial(
    questionPoolId?: string,
    forceRegenerate?: boolean,
  ): Promise<TopicPlanProjection> {
    const preparation = await this.persistence.prepare(questionPoolId, forceRegenerate);
    if (preparation.existing) return preparation.existing;
    const { context } = preparation;
    // 计费（票 07）：主题规划初次 20 点/次。permitId 绑定源快照（问题池 +
    // 知识版本）：崩溃/网络重试后重跑同一快照重放同一 permit，不二次预扣；
    // 快照变化即新操作。existing 复用（缓存）已在上面提前返回，不扣点。
    // force_regenerate 是用户显式要求的重规划，同样计费。
    if (!this.permits) return this.runInitialGeneration(context, forceRegenerate);
    const permitId = `topic:${context.questionPoolId}:${context.questionPoolRevision}:${context.knowledgeVersion}`;
    await this.permits.apply({
      permitId,
      operation: "topic_planning",
      units: 1,
    });
    try {
      const plan = await this.runInitialGeneration(context, forceRegenerate);
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
    forceRegenerate?: boolean,
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
    const clusterMessages = [
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
    ] as const;
    const topics = await structuredGeneration(
      {
        stage: "topic-clustering",
        messages: clusterMessages,
        parse: (raw) => parseTopicClusters(raw, context.questions),
        retryContract:
          '只返回 JSON 数组：[{"questionIds":["q1"],"name":"简洁主题名","summary":"综合主题句","searchIntent":"informational","reason":"聚类和命名原因"}]，questionIds 必须恰好覆盖全部输入问题、不重不漏。',
      },
      (messages) => this.generation.complete(messages),
    );
    modelAttempts.push({
      stage: "topic-clustering",
      provider: "volcengine",
      capabilitySlot: "generation",
      model: XIAOJING_GEO_PROVIDER_DEFAULTS.generationModel,
      status: "success",
    });
    const typeMessages = [
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
    ] as const;
    const recommendations = await structuredGeneration(
      {
        stage: "type-recommendation",
        messages: typeMessages,
        parse: (raw) => parseAndEnforceTypeRecommendations(raw, topics),
        retryContract:
          '只返回 JSON 数组：[{"topicId":"topic-1","recommendations":[{"type":"guide","reason":"为什么适合该主题"}]}]，必须覆盖全部主题，type 只能取 guide/showcase/ranking/news/news_light。',
      },
      (messages) => this.generation.complete(messages),
    );
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
    // 丢弃条目直接从计划剔除（WARN 已留痕，用户在批准门看到的是少一条的
    // 计划而非整批失败）；全部条目被丢弃是模型完全不可用，如实重抛末次
    // 拒因——没有任何可交付物时沉默成功比错误更误导。
    const items: TopicPlanItem[] = cappedSeeds.flatMap((seed) => {
      const generated = titleGeneration.plans.get(seed.itemId);
      if (!generated) return [];
      return [
        {
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
        },
      ];
    });
    // 丢弃条目直接从计划剔除（WARN 已留痕，用户在批准门看到的是少一条的
    // 计划而非整批失败）；全部条目被丢弃是模型完全不可用，如实重抛末次
    // 拒因——没有任何可交付物时沉默成功比错误更误导。
    assertNotAllDropped(
      titleGeneration.dropped,
      cappedSeeds.length,
      "topic_plan_title_generation_failed",
    );
    return this.persistence.create({
      questionPoolId: context.questionPoolId,
      questionPoolRevision: context.questionPoolRevision,
      knowledgeVersion: context.knowledgeVersion,
      policyVersion: TOPIC_PLAN_POLICY_VERSION,
      forceRegenerate: forceRegenerate === true,
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
    /** 两轮（初试 + 带反馈修正）都未产出合格候选而被剔除的条目。 */
    dropped: ReadonlyArray<{ itemId: string; reason: string }>;
  }> {
    const generated: Array<{
      itemId: string;
      candidates: string[];
      rationale: TopicPlanItem["titleRationale"];
    }> = [];
    const modelAttempts: TopicPlanModelAttempt[] = [];
    const dropped: Array<{ itemId: string; reason: string }> = [];
    const priorTitles = protectedItems.map((item) => item.title);
    // 结构种子批内洗牌发牌（2026-08-18 裁定：每批标题句式不得同构）。
    const structureSeeds = dealTitleStructureSeeds(seeds.length);
    for (let offset = 0; offset < seeds.length; offset += TOPIC_PLAN_TITLE_BATCH_SIZE) {
      const batch = seeds.slice(offset, offset + TOPIC_PLAN_TITLE_BATCH_SIZE);
      const results = await Promise.all(
        batch.map(
          async (seed, indexInBatch): Promise<TitleSeedOutcome> => {
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
            `每条标题不超过 ${GEO_PORT_CONTRACT.promptStructures.titleGeneration.maximumCharacters[seed.contentType]} 个字符（年份、标点都计入）；`,
            "候选彼此不得重复或高度同义，也不得与已有标题重复；",
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
          const parseCorrective =
            "上一次响应不是合法的结构化结果。只返回 JSON："
            + `{"itemId":"${seed.itemId}","candidates":["标题1","标题2","标题3"],`
            + '"rationale":{"questionCoverage":"...","searchIntent":"...","differentiation":"...","brandFit":"...","chinaMarketExpression":"..."}'
            + "}，不要 markdown 代码块或任何说明文字。";
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
                        relatedBrands: profile.relatedBrands,
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
          const validate = (candidates: string[]) =>
            validateTitleCandidates({
              candidates,
              contentType: seed.contentType,
              targetRegion: profile.region,
              industry: profile.industry,
              businessTerms: profile.businessTerms,
              brandNames: [profile.brandName, ...profile.shortNames],
              relatedBrands: profile.relatedBrands,
              competitors: profile.competitors,
              currentYear: this.now().getFullYear(),
            });
          // 两轮统一策略（用户裁决 2026-09-01 少报错）：解析失败与校验失败
          // 共用一次带反馈修正重试；重试后仍有 ≥1 条合格候选即降级放行
          // （不足 3 条下限不再杀整批），一条都没有才丢弃该条目——单条目
          // 的模型质量波动不该作废其他条目的成果。
          type RoundOutcome =
            | {
                kind: "valid";
                candidates: string[];
                rationale: TopicPlanItem["titleRationale"];
              }
            | {
                kind: "candidates-error";
                error: TopicPlanTitleCandidatesError;
                parsedCandidates: readonly string[];
                rationale: TopicPlanItem["titleRationale"];
              }
            | { kind: "parse-error"; error: unknown };
          const runRound = async (extra?: string): Promise<RoundOutcome> => {
            let parsed: ParsedTitlePlan;
            try {
              parsed = parseTitlePlan(await complete(extra), seed.itemId);
            } catch (error) {
              return { kind: "parse-error", error };
            }
            try {
              return {
                kind: "valid",
                candidates: validate(parsed.candidates),
                rationale: parsed.rationale,
              };
            } catch (error) {
              // validate 只会抛 TopicPlanTitleCandidatesError（规则拒是计
              // 数不是异常）；其他异常原样上抛。
              if (!(error instanceof TopicPlanTitleCandidatesError)) throw error;
              return {
                kind: "candidates-error",
                error,
                parsedCandidates: parsed.candidates,
                rationale: parsed.rationale,
              };
            }
          };
          const first = await runRound();
          if (first.kind === "valid") {
            return {
              dropped: false,
              itemId: seed.itemId,
              candidates: first.candidates,
              rationale: first.rationale,
            };
          }
          // 把拒因与被拒候选回灌：corrective 只覆盖通用硬规则，模型看
          // 不到自己哪里挂了（如超长重复×2）时重试只是盲重试。拒因计数
          // 直接读结构化字段（TopicPlanTitleCandidatesError），不反解
          // message——message 只为统一日志保留编码形态。解析失败走
          // parseCorrective（结构要求 + 具体解析错误）。
          const rejectionSummary =
            first.kind === "candidates-error"
              ? [...first.error.rejectionCounts.entries()]
                  .map(([reason, count]) => {
                    const label = TITLE_REJECTION_REASON_LABELS[reason] ?? reason;
                    return count ? `${label}×${count}` : label;
                  })
                  .join("；")
              : "";
          const feedback =
            first.kind === "candidates-error"
              ? corrective
                + `上一轮被拒原因：${rejectionSummary || "未通过确定性校验"}。`
                + `上一轮候选：${first.parsedCandidates.join("／") || "无"}。`
                + "针对被拒原因重写，不要原样复述上一轮候选。"
              : parseCorrective
                + `上一次解析失败（${
                    first.error instanceof Error ? first.error.message : String(first.error)
                  }）。`;
          const second = await runRound(feedback);
          if (second.kind === "valid") {
            return {
              dropped: false,
              itemId: seed.itemId,
              candidates: second.candidates,
              rationale: second.rationale,
            };
          }
          // 两轮降级的幸存集裁决（用户裁决 2026-09-01「重试后仍有 ≥1 条
          // 合格候选即降级放行」的完整读法）：幸存 = 两轮中任一轮的
          // validCandidates 非空——第二轮优先（重试产出携最新拒因上下文），
          // 第二轮更差时退回首轮（重试劣化不该反杀已有合格候选）。两轮
          // 幸存集都空才剔除该条目。
          const rescue =
            second.kind === "candidates-error" &&
            second.error.validCandidates.length > 0
              ? {
                  candidates: second.error.validCandidates,
                  rationale: second.rationale,
                  origin: "重试后",
                }
              : first.kind === "candidates-error" &&
                  first.error.validCandidates.length > 0
                ? {
                    candidates: first.error.validCandidates,
                    rationale: first.rationale,
                    origin: "退回首轮",
                  }
                : null;
          if (rescue) {
            console.warn(
              `[topic-plan] 条目 ${seed.itemId} 标题校验两轮不足下限（${rescue.origin} ${rescue.candidates.length} 条合格），按降级候选集继续`,
            );
            return {
              dropped: false,
              itemId: seed.itemId,
              candidates: [...rescue.candidates],
              rationale: rescue.rationale,
            };
          }
          const dropReason =
            second.kind === "candidates-error"
              ? second.error.message
              : second.error instanceof Error
                ? second.error.message
                : String(second.error);
          console.warn(
            `[topic-plan] 条目 ${seed.itemId} 两轮标题生成未产出合格候选（${dropReason}），剔除该条目继续`,
          );
          return { dropped: true, itemId: seed.itemId, reason: dropReason };
        }),
      );
      // 条目级降级落点（用户裁决 2026-09-01 少报错）：丢弃的条目不进生成
      // 集、不记 modelAttempts（审计走 WARN 日志），其余条目照常进入去重。
      const okResults = results.flatMap((result) =>
        result.dropped === false
          ? [{ itemId: result.itemId, candidates: result.candidates, rationale: result.rationale }]
          : [],
      );
      generated.push(...okResults);
      modelAttempts.push(
        ...okResults.map((result) => ({
          stage: "title-generation" as const,
          provider: "volcengine" as const,
          capabilitySlot: "generation" as const,
          model: XIAOJING_GEO_PROVIDER_DEFAULTS.titlePlanningModel,
          status: "success" as const,
          itemId: result.itemId,
        })),
      );
      for (const result of results) {
        if (result.dropped) {
          dropped.push({ itemId: result.itemId, reason: result.reason });
        }
      }
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
    return { plans, modelAttempts, dropped };
  }

  async saveItems(input: {
    workspaceId: string;
    sessionId: string;
    planId: string;
    expectedRevision: number;
    items: readonly TopicPlanWireItem[];
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
    let replacedItemIds: ReadonlySet<string> | null = null;
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
      // 条目级降级（用户裁决 2026-09-01 少报错）：两轮未过审的条目保留原
      // 标题与原批准态（不替换、不重置）；全部条目被丢弃 = 这次重生成没有
      // 任何可交付物，如实重抛末次拒因——沉默的空成功比错误更误导。
      replacements = eligible.flatMap((item) => {
        const title = generated.plans.get(item.id);
        if (!title) return [];
        return [
          {
            ...item,
            title: title.title,
            titleCandidates: title.candidates,
            titleRationale: title.rationale,
            deduplication: title.evidence,
            userEdited: false,
            approvalStatus: "draft",
            origin: "model" as const,
          },
        ];
      });
      // 条目级降级（用户裁决 2026-09-01 少报错）：两轮未过审的条目保留原
      // 标题与原批准态（不替换、不重置）；全部条目被丢弃 = 这次重生成没有
      // 任何可交付物，如实重抛末次拒因——沉默的空成功比错误更误导。
      assertNotAllDropped(
        generated.dropped,
        eligible.length,
        "topic_plan_title_regeneration_failed",
      );
      replacedItemIds = new Set(replacements.map((item) => item.id));
    }
    const merged = mergeRegeneratedTopicPlanItems({
      currentItems: plan.items,
      replacements,
      // merge 只认「有替换件或受保护」的目标：被丢弃的目标从 merge 目标集
      // 剔除（条目保持原样通过），完整请求集仍随 mutation 的 targetItemIds
      // 留审计。
      targetItemIds: targetIds.filter(
        (id) =>
          replacedItemIds?.has(id) || preserved.some((item) => item.id === id),
      ),
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

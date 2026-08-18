import { createHash } from "node:crypto";

import {
  KEYWORD_MINING_SYSTEM_PROMPT,
  QUESTION_GENERATION_SYSTEM_PROMPT,
  QUESTION_POOL_POLICY_VERSION,
  buildKeywordMiningPrompt,
  buildQuestionGenerationPrompt,
  normalizeQuestionPoolParameters,
  parseMinedKeywords,
  parseQuestionCandidates,
  scoreQuestionPoolCandidate,
  type LibraryKeywordTerm,
  type MinedKeyword,
  type QuestionPoolDecision,
  type QuestionPoolGenerationParameters,
  type QuestionPoolProjection,
  type QuestionPoolQuestion,
  type QuestionPoolStage,
} from "../../shared/geo/questionPool";
import {
  deriveServiceScope,
  isValidCityName,
  projectBrandProfile,
  renderFullProfileBlock,
  renderMiningProfileBlock,
} from "../../shared/geo/profileInjection";
import { anySignal } from "../utils/cancellation";
import { managementApi } from "../utils/management-api-client";
import type {
  GeoEmbeddingCapability,
  GeoKeywordSearchCapability,
  GeoTextCapability,
} from "./provider-capabilities";

export interface QuestionPoolKnowledgeFact {
  factKey: string;
  subject: string;
  predicate: string;
  scopeJson: string;
  normalizedValueJson: string;
  unit?: string | null;
  sources: unknown[];
}

export interface QuestionPoolKnowledgeContext {
  knowledgeVersion: number;
  brandName: string;
  productLines: string[];
  facts: QuestionPoolKnowledgeFact[];
  recentSelectedQuestions: string[];
  /** 品牌词库（用户确认过的词，跨池复用；ADR-0006 修正三）。 */
  keywordLibrary: LibraryKeywordTerm[];
}

interface QuestionPoolAttempt {
  id: string;
  poolId: string;
  state: string;
  currentStage?: string | null;
  idempotencyKey: string;
}

interface QuestionPoolPreparation {
  kind: "reused" | "attempt";
  context: QuestionPoolKnowledgeContext;
  attempt?: QuestionPoolAttempt | null;
  pool: QuestionPoolProjection;
}

interface QuestionPoolStepClaim {
  action: "execute" | "cached" | "busy";
  claimToken?: string | null;
  output?: unknown;
  attemptNumber: number;
  billingKey: string;
}

export interface QuestionPoolPersistencePort {
  latest(
    productLine?: string,
    pendingOnly?: boolean,
  ): Promise<QuestionPoolProjection | null>;
  prepare(input: {
    workspaceId: string;
    sessionId: string;
    productLine: string;
    targetRegion: string;
    generationParameters: QuestionPoolGenerationParameters;
    idempotencyKey: string;
    reuseExisting: boolean;
    retry: boolean;
  }): Promise<QuestionPoolPreparation>;
  claim(input: {
    attemptId: string;
    stage: QuestionPoolStage;
    inputHash: string;
  }): Promise<QuestionPoolStepClaim>;
  finish(input: {
    attemptId: string;
    stage: QuestionPoolStage;
    claimToken: string;
    status: "completed" | "failed" | "cancelled";
    output?: unknown;
    errorCode?: string;
  }): Promise<void>;
  persist(input: {
    attemptId: string;
    keywords: MinedKeyword[];
    questions: QuestionPoolQuestion[];
    sourceEvidence: QuestionPoolProjection["sourceEvidence"];
  }): Promise<QuestionPoolProjection>;
  cancel(attemptId: string): Promise<QuestionPoolProjection>;
  decide(input: {
    workspaceId: string;
    sessionId: string;
    poolId: string;
    expectedRevision: number;
    questions: QuestionPoolQuestion[];
    selectedQuestionIds: string[];
    actorId: "desktop-user";
  }): Promise<QuestionPoolDecision>;
  revise(input: {
    workspaceId: string;
    sessionId: string;
    poolId: string;
    expectedRevision: number;
    action: QuestionPoolRevisionAction;
    targetKind: QuestionPoolRevisionTargetKind;
    targetId?: string;
    keywords: MinedKeyword[];
    questions: QuestionPoolQuestion[];
    actorId: "desktop-user";
    reason: string;
  }): Promise<QuestionPoolProjection>;
}

/** 聊天修订（ADR 0003，票 38）只作用于 awaiting-selection 的待决池。 */
export type QuestionPoolRevisionAction = "modify" | "delete" | "add";
export type QuestionPoolRevisionTargetKind = "question" | "keyword";

export interface QuestionPoolRevisionInput {
  workspaceId: string;
  sessionId: string;
  action: QuestionPoolRevisionAction;
  targetKind: QuestionPoolRevisionTargetKind;
  /** modify/delete：目标条目 id（question.id / keyword.id）。 */
  targetId?: string;
  /**
   * modify/add 的新值：question = 新文本或 {text, recommended}；keyword =
   * 新词或 {term, category, heat}。
   */
  value?: unknown;
  reason: string;
  actorId: "desktop-user";
}

export interface QuestionPoolRevisionOutcome {
  pool: QuestionPoolProjection;
}

function persistenceError(result: Record<string, unknown>): Error {
  return new Error(
    typeof result.error === "string"
      ? result.error
      : "question_pool_persistence_failed",
  );
}

export class RustQuestionPoolPort implements QuestionPoolPersistencePort {
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

  prepare(
    input: Parameters<QuestionPoolPersistencePort["prepare"]>[0],
  ): Promise<QuestionPoolPreparation> {
    return this.post("/api/brand-question-pools/prepare", input, "preparation");
  }

  latest(
    productLine?: string,
    pendingOnly?: boolean,
  ): Promise<QuestionPoolProjection | null> {
    return this.post(
      "/api/brand-question-pools/latest",
      { productLine, pendingOnly },
      "pool",
    );
  }

  claim(
    input: Parameters<QuestionPoolPersistencePort["claim"]>[0],
  ): Promise<QuestionPoolStepClaim> {
    return this.post("/api/brand-question-pools/step/claim", input, "claim");
  }

  async finish(
    input: Parameters<QuestionPoolPersistencePort["finish"]>[0],
  ): Promise<void> {
    await this.post(
      "/api/brand-question-pools/step/finish",
      input,
      "checkpoint",
    );
  }

  persist(
    input: Parameters<QuestionPoolPersistencePort["persist"]>[0],
  ): Promise<QuestionPoolProjection> {
    return this.post("/api/brand-question-pools/persist", input, "pool");
  }

  cancel(attemptId: string): Promise<QuestionPoolProjection> {
    return this.post("/api/brand-question-pools/cancel", { attemptId }, "pool");
  }

  decide(
    input: Parameters<QuestionPoolPersistencePort["decide"]>[0],
  ): Promise<QuestionPoolDecision> {
    return this.post("/api/brand-question-pools/decide", input, "result");
  }

  revise(
    input: Parameters<QuestionPoolPersistencePort["revise"]>[0],
  ): Promise<QuestionPoolProjection> {
    return this.post("/api/brand-question-pools/revise", input, "pool");
  }
}

export function createQuestionPoolPort(identity: {
  workspaceId: string;
  sessionId: string;
}): RustQuestionPoolPort {
  const sidecarId = process.env.XIAOJING_SIDECAR_ID?.trim();
  if (!sidecarId)
    throw new Error("Question pool requires an authenticated Sidecar identity");
  return new RustQuestionPoolPort({ ...identity, sidecarId });
}

const QUESTION_POOL_MAX_QUESTIONS = 50;
const QUESTION_POOL_MAX_KEYWORDS = 200;

function questionIdentity(text: string): string {
  return text
    .toLocaleLowerCase("zh-CN")
    .replace(/[？?。！!\s]+$/g, "");
}

function keywordIdentity(term: string): string {
  return term.trim().toLocaleLowerCase("zh-CN");
}

/** 用户补充的问题没有模型评分：中性占位分明确标注未评估，卡片按低优先级呈现。 */
function userAddedQuestionScore(): QuestionPoolQuestion["score"] {
  return {
    mode: "pred-1",
    relevance: 0,
    recentPoolSimilarity: 0,
    optimizationPotential: 0,
    priorityTotal: 0,
    priority: "low",
    formula: "user-added; not scored",
    policyVersion: QUESTION_POOL_POLICY_VERSION,
  };
}

function uniqueEntryId(prefix: string, taken: Set<string>): string {
  let sequence = taken.size + 1;
  let id = `${prefix}-${sequence}`;
  while (taken.has(id)) {
    sequence += 1;
    id = `${prefix}-${sequence}`;
  }
  return id;
}

function parseKeywordValue(
  value: unknown,
  defaults: { category: MinedKeyword["category"]; heat: MinedKeyword["heat"] },
): { term: string; category: MinedKeyword["category"]; heat: MinedKeyword["heat"] } {
  const holder =
    typeof value === "string"
      ? { term: value }
      : value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
  if (typeof holder.term !== "string" || !holder.term.trim()) {
    throw new Error("question_pool_keyword_term_required");
  }
  const term = holder.term.trim();
  if (term.length > 120) throw new Error("question_pool_keyword_term_invalid");
  const category =
    holder.category === "core" || holder.category === "scene" || holder.category === "longtail"
      ? holder.category
      : defaults.category;
  const heat =
    holder.heat === "high" || holder.heat === "medium" || holder.heat === "low"
      ? holder.heat
      : defaults.heat;
  return { term, category, heat };
}

/**
 * 聊天修订的纯策略（ADR 0003）：对 awaiting-selection 池的搜索词与候选问题
 * 执行改/删/增。抛错沿用 question_pool_* 域错误码，越权类别经
 * gateRevisionErrorCode 结构化。不触碰权威知识；新增问题/词标注 user-added
 * 证据，落库后随卡片轮询重渲染。
 */
export function applyQuestionPoolRevision(
  pool: QuestionPoolProjection,
  input: QuestionPoolRevisionInput,
): { keywords: MinedKeyword[]; questions: QuestionPoolQuestion[] } {
  if (input.targetKind === "keyword") {
    let keywords = pool.keywords.map((keyword) => ({ ...keyword }));
    if (input.action === "add") {
      const parsed = parseKeywordValue(input.value, {
        category: "longtail",
        heat: "medium",
      });
      if (
        keywords.some(
          (keyword) => keywordIdentity(keyword.term) === keywordIdentity(parsed.term),
        )
      ) {
        throw new Error("question_pool_keyword_duplicate");
      }
      if (keywords.length >= QUESTION_POOL_MAX_KEYWORDS) {
        throw new Error("question_pool_keywords_invalid");
      }
      keywords.push({
        id: uniqueEntryId(
          "kw-user",
          new Set(keywords.map((keyword) => keyword.id)),
        ),
        term: parsed.term,
        category: parsed.category,
        heat: parsed.heat,
        platform: "doubao",
      });
      return { keywords, questions: pool.questions };
    }
    const target = keywords.find((keyword) => keyword.id === input.targetId);
    if (!target) throw new Error("question_pool_revision_target_not_found");
    if (input.action === "delete") {
      keywords = keywords.filter((keyword) => keyword.id !== input.targetId);
    } else {
      const parsed = parseKeywordValue(input.value, {
        category: target.category,
        heat: target.heat,
      });
      if (
        keywords.some(
          (keyword) =>
            keyword.id !== input.targetId &&
            keywordIdentity(keyword.term) === keywordIdentity(parsed.term),
        )
      ) {
        throw new Error("question_pool_keyword_duplicate");
      }
      Object.assign(target, parsed);
    }
    return { keywords, questions: pool.questions };
  }

  let questions = pool.questions.map((question) => ({
    ...question,
    evidence: question.evidence.map((entry) => ({ ...entry })),
  }));
  if (input.action === "add") {
    const holder =
      input.value && typeof input.value === "object" && !Array.isArray(input.value)
        ? (input.value as Record<string, unknown>)
        : { text: input.value };
    if (typeof holder.text !== "string" || !holder.text.trim()) {
      throw new Error("question_pool_question_text_required");
    }
    const text = holder.text.trim();
    if (text.length > 500) throw new Error("question_pool_question_text_invalid");
    if (
      questions.some(
        (question) => questionIdentity(question.text) === questionIdentity(text),
      )
    ) {
      throw new Error("question_pool_question_duplicate");
    }
    if (questions.length >= QUESTION_POOL_MAX_QUESTIONS) {
      throw new Error("question_pool_questions_invalid");
    }
    questions.push({
      id: uniqueEntryId(
        "q-user",
        new Set(questions.map((question) => question.id)),
      ),
      text,
      selected: false,
      recommended: holder.recommended === true,
      score: userAddedQuestionScore(),
      evidence: [
        {
          kind: "user-added",
          reference: "chat-revision",
          excerpt: text,
        },
      ],
    });
    return { keywords: pool.keywords, questions };
  }
  const target = questions.find((question) => question.id === input.targetId);
  if (!target) throw new Error("question_pool_revision_target_not_found");
  if (input.action === "delete") {
    questions = questions.filter((question) => question.id !== input.targetId);
    if (questions.length === 0) throw new Error("question_pool_questions_invalid");
  } else {
    if (typeof input.value !== "string" || !input.value.trim()) {
      throw new Error("question_pool_question_text_required");
    }
    const text = input.value.trim();
    if (text.length > 500) throw new Error("question_pool_question_text_invalid");
    if (
      questions.some(
        (question) =>
          question.id !== input.targetId &&
          questionIdentity(question.text) === questionIdentity(text),
      )
    ) {
      throw new Error("question_pool_question_duplicate");
    }
    target.text = text;
  }
  return { keywords: pool.keywords, questions };
}

export interface QuestionPoolGenerateInput {
  workspaceId: string;
  sessionId: string;
  productLine: string;
  targetRegion: string;
  idempotencyKey: string;
  /** 领域内的具体业务焦点（如"汽车隔音"）；缺省=整个产品线领域。 */
  businessFocus?: string;
  generationParameters?: Partial<QuestionPoolGenerationParameters>;
  retry?: boolean;
}

interface ActiveAttempt {
  attemptId: string;
  controller: AbortController;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function deriveGenerationContext(
  context: QuestionPoolKnowledgeContext,
  productLine: string,
) {
  const productFacts = context.facts.filter(
    (fact) =>
      fact.scopeJson.includes(productLine) ||
      !fact.scopeJson.includes("product-line"),
  );
  const profile = projectBrandProfile(productFacts);
  const brandNames = [
    ...new Set([
      context.brandName,
      ...(profile.fullName ?? []),
      ...(profile.shortNames ?? []),
    ]),
  ].filter(Boolean);
  const industry = profile.industry?.[0];
  if (!industry) throw new Error("question_pool_industry_required");
  const profileAnchorText = Object.values(profile)
    .flat()
    .join("；")
    .slice(0, 4000);
  return { brandNames, industry, profile, profileAnchorText, productFacts };
}

function questionErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("question_pool_")) {
    return message
      .slice(message.indexOf("question_pool_"))
      .split(/[^a-z0-9_:-]/i)[0];
  }
  if (message.includes("AbortError") || message.includes("aborted"))
    return "question_pool_cancelled";
  return "question_pool_provider_failed";
}

function checkpointFromPool(
  pool: QuestionPoolProjection,
  stage: QuestionPoolStage,
  status: "completed" | "failed" | "cancelled",
  claim: QuestionPoolStepClaim,
  inputHash: string,
  errorCode?: string,
): void {
  const checkpoint = {
    stage,
    status,
    attemptNumber: claim.attemptNumber,
    billingKey: claim.billingKey,
    inputHash,
    errorCode,
  };
  pool.checkpoints = [
    ...pool.checkpoints.filter((item) => item.stage !== stage),
    checkpoint,
  ];
}

export class QuestionPoolService {
  private readonly activeByKey = new Map<string, ActiveAttempt>();
  private readonly inFlight = new Map<
    string,
    Promise<QuestionPoolProjection>
  >();

  constructor(
    private readonly identity: { workspaceId: string; sessionId: string },
    private readonly persistence: QuestionPoolPersistencePort,
    private readonly keywordSearch: GeoKeywordSearchCapability,
    private readonly generation: GeoTextCapability,
    private readonly embedding: GeoEmbeddingCapability,
  ) {}

  latest(input: {
    workspaceId: string;
    sessionId: string;
    productLine?: string;
    pendingOnly?: boolean;
  }): Promise<QuestionPoolProjection | null> {
    if (
      input.workspaceId !== this.identity.workspaceId ||
      input.sessionId !== this.identity.sessionId
    ) {
      throw new Error("question_pool_identity_mismatch");
    }
    return this.persistence.latest(input.productLine, input.pendingOnly);
  }

  generate(
    input: QuestionPoolGenerateInput,
    parentSignal?: AbortSignal,
  ): Promise<QuestionPoolProjection> {
    const existing = this.inFlight.get(input.idempotencyKey);
    if (existing) return existing;
    const work = this.run(input, parentSignal).finally(() => {
      this.inFlight.delete(input.idempotencyKey);
      this.activeByKey.delete(input.idempotencyKey);
    });
    this.inFlight.set(input.idempotencyKey, work);
    return work;
  }

  private async run(
    input: QuestionPoolGenerateInput,
    parentSignal?: AbortSignal,
  ): Promise<QuestionPoolProjection> {
    if (
      input.workspaceId !== this.identity.workspaceId ||
      input.sessionId !== this.identity.sessionId
    ) {
      throw new Error("question_pool_identity_mismatch");
    }
    const productLine = input.productLine.trim();
    const targetRegion = input.targetRegion.trim();
    if (!productLine) throw new Error("question_pool_product_line_required");
    if (!targetRegion) throw new Error("question_pool_target_region_required");
    const parameters = normalizeQuestionPoolParameters(
      input.generationParameters,
    );
    const preparation = await this.persistence.prepare({
      ...this.identity,
      productLine,
      targetRegion,
      generationParameters: parameters,
      idempotencyKey: input.idempotencyKey,
      reuseExisting: true,
      retry: input.retry === true,
    });
    if (preparation.kind === "reused") return preparation.pool;
    const attempt = preparation.attempt;
    if (!attempt) throw new Error("question_pool_attempt_not_found");
    const controller = new AbortController();
    this.activeByKey.set(input.idempotencyKey, {
      attemptId: attempt.id,
      controller,
    });
    const signal = anySignal([parentSignal, controller.signal]);
    const generationContext = deriveGenerationContext(
      preparation.context,
      productLine,
    );
    // 地域锚（ADR-0006 修正四）：用户声明的服务范围 = 锚 + 上限（粒度保留，
    // 「新都区」不升格为成都市），地址只在声明不可用时兜底；全国/线上类声明
    // → 无地缘模式，agent 传的纯地域名可兜底。
    const scope =
      deriveServiceScope(generationContext.profile) ??
      (isValidCityName(targetRegion)
        ? { primary: targetRegion.trim(), allowed: [targetRegion.trim()] }
        : undefined);
    const region = scope?.primary ?? "";
    const keywordPrompt = buildKeywordMiningPrompt({
      region,
      ...(scope ? { allowedRegions: scope.allowed } : {}),
      industry: generationContext.industry,
      productLine,
      brandNames: generationContext.brandNames,
      profileBlock: renderMiningProfileBlock(generationContext.profile),
      ...(preparation.context.keywordLibrary.length > 0
        ? { libraryKeywords: preparation.context.keywordLibrary }
        : {}),
      ...(input.businessFocus ? { businessFocus: input.businessFocus } : {}),
    });

    try {
      const keywordOutput = await this.runStep(
        attempt.id,
        "keyword-search",
        {
          prompt: keywordPrompt,
          knowledgeVersion: preparation.context.knowledgeVersion,
        },
        signal,
        async () => {
          const raw = await this.keywordSearch.search(keywordPrompt, {
            signal,
            maxTokens: 4096,
            system: KEYWORD_MINING_SYSTEM_PROMPT,
          });
          return {
            raw,
            keywords: parseMinedKeywords(raw, generationContext.brandNames, {
              existingTerms: preparation.context.keywordLibrary.map(
                (keyword) => keyword.term,
              ),
            }),
          };
        },
      );
      const keywords = (keywordOutput as { keywords: MinedKeyword[] }).keywords;
      if (!Array.isArray(keywords) || keywords.length === 0) {
        throw new Error("question_pool_empty_keywords");
      }
      const questionPrompt = buildQuestionGenerationPrompt({
        region,
        industry: generationContext.industry,
        keywords,
        existingQuestions: preparation.context.recentSelectedQuestions,
        candidateLimit: parameters.candidateLimit,
        profileBlock: renderFullProfileBlock(generationContext.profile),
      });
      const generationOutput = await this.runStep(
        attempt.id,
        "question-generation",
        { prompt: questionPrompt, keywordHash: hash(keywords) },
        signal,
        async () => {
          const raw = await this.generation.complete(
            [
              {
                role: "system",
                content: QUESTION_GENERATION_SYSTEM_PROMPT,
              },
              { role: "user", content: questionPrompt },
            ],
            { signal, maxTokens: 4096 },
          );
          const candidates = parseQuestionCandidates(
            raw,
            keywords,
            parameters.candidateLimit,
          );
          if (candidates.length === 0)
            throw new Error("question_pool_empty_questions");
          return { raw, candidates };
        },
      );
      const keywordTerms = new Set(keywords.map((keyword) => keyword.term));
      const candidates = (
        generationOutput as {
          candidates: ReturnType<typeof parseQuestionCandidates>;
        }
      ).candidates
        .map((candidate) => ({
          ...candidate,
          sourceKeywords: candidate.sourceKeywords.filter((term) =>
            keywordTerms.has(term),
          ),
        }))
        .filter((candidate) => candidate.sourceKeywords.length > 0);
      if (candidates.length === 0)
        throw new Error("question_pool_empty_questions");
      const knowledgeAnchor = [
        generationContext.industry,
        productLine,
        region,
        generationContext.profileAnchorText,
      ].join(" ");
      const embeddingTexts = [
        knowledgeAnchor,
        ...candidates.map((candidate) => candidate.text),
        ...preparation.context.recentSelectedQuestions.slice(
          0,
          parameters.recentSelectionLimit,
        ),
      ];
      const embeddingOutput = await this.runStep(
        attempt.id,
        "embedding",
        { texts: embeddingTexts, dimensions: this.embedding.dimensions },
        signal,
        async () => ({
          vectors: await this.embedding.embed(embeddingTexts, { signal }),
        }),
      );
      const vectors = (embeddingOutput as { vectors: number[][] }).vectors;
      if (!Array.isArray(vectors) || vectors.length !== embeddingTexts.length) {
        throw new Error("question_pool_embedding_invalid");
      }
      const recentOffset = 1 + candidates.length;
      const recentVectors = vectors.slice(recentOffset);
      const questions: QuestionPoolQuestion[] = candidates.map(
        (candidate, index) => {
          const score = scoreQuestionPoolCandidate({
            questionVector: vectors[index + 1],
            knowledgeVector: vectors[0],
            recentSelectedVectors: recentVectors,
          });
          return {
            id: `q-${attempt.id.slice(0, 8)}-${index + 1}`,
            text: candidate.text,
            selected: candidate.recommended || score.priority === "high",
            recommended: candidate.recommended,
            score,
            evidence: candidate.sourceKeywords.map((term) => ({
              kind: "keyword-search" as const,
              reference:
                keywords.find((keyword) => keyword.term === term)?.id ??
                "keyword-library",
              excerpt: term,
            })),
          };
        },
      );
      if (!questions.some((question) => question.selected))
        questions[0].selected = true;
      const sourceEvidence = [
        {
          kind: "keyword-search" as const,
          reference: hash(keywordPrompt),
          excerpt: `${keywords.length} 个豆包联网搜索词`,
        },
        ...generationContext.productFacts.map((fact) => ({
          kind: "knowledge-fact" as const,
          reference: `${preparation.context.knowledgeVersion}:${fact.factKey}`,
          excerpt: `${fact.predicate}=${fact.normalizedValueJson}`.slice(
            0,
            500,
          ),
        })),
      ];
      const persistInput = { keywords, questions, sourceEvidence };
      const persistHash = hash(persistInput);
      const claim = await this.persistence.claim({
        attemptId: attempt.id,
        stage: "persist",
        inputHash: persistHash,
      });
      if (claim.action === "busy")
        throw new Error("question_pool_step_busy:persist");
      if (claim.action === "cached") return preparation.pool;
      if (!claim.claimToken)
        throw new Error("question_pool_claim_token_missing");
      try {
        const pool = await this.persistence.persist({
          attemptId: attempt.id,
          ...persistInput,
        });
        await this.persistence.finish({
          attemptId: attempt.id,
          stage: "persist",
          claimToken: claim.claimToken,
          status: "completed",
          output: { poolId: pool.id, revision: pool.revision },
        });
        checkpointFromPool(pool, "persist", "completed", claim, persistHash);
        return pool;
      } catch (error) {
        await this.persistence
          .finish({
            attemptId: attempt.id,
            stage: "persist",
            claimToken: claim.claimToken,
            status: signal.aborted ? "cancelled" : "failed",
            errorCode: questionErrorCode(error),
          })
          .catch(() => {});
        throw error;
      }
    } catch (error) {
      if (signal.aborted) {
        await this.persistence.cancel(attempt.id).catch(() => {});
        throw new Error("question_pool_cancelled");
      }
      throw error;
    }
  }

  private async runStep<T>(
    attemptId: string,
    stage: Exclude<QuestionPoolStage, "persist">,
    input: unknown,
    signal: AbortSignal,
    execute: () => Promise<T>,
  ): Promise<T> {
    const inputHash = hash(input);
    const claim = await this.persistence.claim({ attemptId, stage, inputHash });
    if (claim.action === "cached") return claim.output as T;
    if (claim.action === "busy")
      throw new Error(`question_pool_step_busy:${stage}`);
    if (!claim.claimToken) throw new Error("question_pool_claim_token_missing");
    try {
      const output = await execute();
      await this.persistence.finish({
        attemptId,
        stage,
        claimToken: claim.claimToken,
        status: "completed",
        output,
      });
      return output;
    } catch (error) {
      await this.persistence
        .finish({
          attemptId,
          stage,
          claimToken: claim.claimToken,
          status: signal.aborted ? "cancelled" : "failed",
          errorCode: questionErrorCode(error),
        })
        .catch(() => {});
      throw error;
    }
  }

  async cancel(idempotencyKey: string): Promise<QuestionPoolProjection> {
    const active = this.activeByKey.get(idempotencyKey);
    if (!active) throw new Error("question_pool_attempt_not_active");
    active.controller.abort("desktop-user");
    return this.persistence.cancel(active.attemptId);
  }

  confirm(input: {
    workspaceId: string;
    sessionId: string;
    poolId: string;
    expectedRevision: number;
    questions: QuestionPoolQuestion[];
  }): Promise<QuestionPoolDecision> {
    if (
      input.workspaceId !== this.identity.workspaceId ||
      input.sessionId !== this.identity.sessionId
    ) {
      throw new Error("question_pool_identity_mismatch");
    }
    const selectedQuestionIds = input.questions
      .filter((question) => question.selected)
      .map((question) => question.id);
    if (selectedQuestionIds.length === 0)
      throw new Error("question_pool_selection_required");
    return this.persistence.decide({
      ...input,
      selectedQuestionIds,
      actorId: "desktop-user",
    });
  }

  /**
   * 聊天修订（ADR 0003，票 38）：只作用于本 Session 当前 awaiting-selection
   * 的待决池；逐条操作独立提交（与 decide-batch 的逐条独立语义一致），
   * 每条经 Rust 写 geo_question_pool_revisions 审计（含用户指令原文）。
   */
  async revise(
    input: QuestionPoolRevisionInput,
  ): Promise<QuestionPoolRevisionOutcome> {
    if (
      input.workspaceId !== this.identity.workspaceId ||
      input.sessionId !== this.identity.sessionId
    ) {
      throw new Error("question_pool_identity_mismatch");
    }
    const reason = input.reason.trim();
    if (!reason || reason.length > 20_000) {
      throw new Error(
        "question pool revision requires the user's explicit instruction (1-20000 characters)",
      );
    }
    // 只解析本 Session 的待决池：普通 latest 会把同版本 confirmed 池排在
    // 前面，遮蔽掉真正待修订的新池。
    const pool = await this.persistence.latest(undefined, true);
    if (!pool) throw new Error("question_pool_not_found");
    if (pool.status === "confirmed") {
      throw new Error("question_pool_confirmed_immutable");
    }
    if (pool.status !== "awaiting-selection") {
      throw new Error("question_pool_not_selectable");
    }
    const next = applyQuestionPoolRevision(pool, input);
    const revised = await this.persistence.revise({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      poolId: pool.id,
      expectedRevision: pool.revision,
      action: input.action,
      targetKind: input.targetKind,
      ...(input.targetId ? { targetId: input.targetId } : {}),
      keywords: next.keywords,
      questions: next.questions,
      actorId: "desktop-user",
      reason,
    });
    return { pool: revised };
  }
}

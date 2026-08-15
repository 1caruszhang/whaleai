import { createHash } from "node:crypto";

import {
  buildKeywordMiningPrompt,
  buildQuestionGenerationPrompt,
  normalizeQuestionPoolParameters,
  parseMinedKeywords,
  parseQuestionCandidates,
  scoreQuestionPoolCandidate,
  type MinedKeyword,
  type QuestionPoolDecision,
  type QuestionPoolGenerationParameters,
  type QuestionPoolProjection,
  type QuestionPoolQuestion,
  type QuestionPoolStage,
} from "../../shared/geo/questionPool";
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
  latest(productLine?: string): Promise<QuestionPoolProjection | null>;
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

  latest(productLine?: string): Promise<QuestionPoolProjection | null> {
    return this.post(
      "/api/brand-question-pools/latest",
      { productLine },
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
}

export function createQuestionPoolPort(identity: {
  workspaceId: string;
  sessionId: string;
}): RustQuestionPoolPort {
  const sidecarId = process.env.MYAGENTS_SIDECAR_ID?.trim();
  if (!sidecarId)
    throw new Error("Question pool requires an authenticated Sidecar identity");
  return new RustQuestionPoolPort({ ...identity, sidecarId });
}

export interface QuestionPoolGenerateInput {
  workspaceId: string;
  sessionId: string;
  productLine: string;
  targetRegion: string;
  idempotencyKey: string;
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

function parsedFactValue(fact: QuestionPoolKnowledgeFact): unknown {
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

function deriveGenerationContext(
  context: QuestionPoolKnowledgeContext,
  productLine: string,
) {
  const productFacts = context.facts.filter(
    (fact) =>
      fact.scopeJson.includes(productLine) ||
      !fact.scopeJson.includes("product-line"),
  );
  const valuesFor = (suffix: string) =>
    productFacts
      .filter((fact) => fact.predicate.endsWith(suffix))
      .flatMap((fact) => strings(parsedFactValue(fact)));
  const brandNames = [
    ...new Set([
      context.brandName,
      ...valuesFor(".fullName"),
      ...valuesFor(".shortNames"),
    ]),
  ];
  const industry = valuesFor(".industry")[0];
  if (!industry) throw new Error("question_pool_industry_required");
  const knowledgeSummary = productFacts
    .map((fact) => `${fact.predicate}=${JSON.stringify(parsedFactValue(fact))}`)
    .join("；")
    .slice(0, 12_000);
  return { brandNames, industry, knowledgeSummary, productFacts };
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
  }): Promise<QuestionPoolProjection | null> {
    if (
      input.workspaceId !== this.identity.workspaceId ||
      input.sessionId !== this.identity.sessionId
    ) {
      throw new Error("question_pool_identity_mismatch");
    }
    return this.persistence.latest(input.productLine);
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
    const keywordPrompt = buildKeywordMiningPrompt({
      region: targetRegion,
      industry: generationContext.industry,
      productLine,
      brandNames: generationContext.brandNames,
      knowledgeSummary: generationContext.knowledgeSummary,
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
          });
          return {
            raw,
            keywords: parseMinedKeywords(raw, generationContext.brandNames),
          };
        },
      );
      const keywords = (keywordOutput as { keywords: MinedKeyword[] }).keywords;
      if (!Array.isArray(keywords) || keywords.length === 0) {
        throw new Error("question_pool_empty_keywords");
      }
      const questionPrompt = buildQuestionGenerationPrompt({
        keywords,
        existingQuestions: preparation.context.recentSelectedQuestions,
        candidateLimit: parameters.candidateLimit,
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
                content: "只把真实搜索词转换为结构化自然问题；不要调用工具。",
              },
              { role: "user", content: questionPrompt },
            ],
            { signal },
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
        targetRegion,
        generationContext.knowledgeSummary,
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
}

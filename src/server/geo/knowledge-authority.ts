import { managementApi } from "../utils/management-api-client";
import type { GeoArtifactFreshnessProjection } from "../../shared/geo/operation";

export type KnowledgeCandidateOrigin = "user-stated" | "model-inferred";
export type KnowledgeRequestIntent = "knowledge-update" | "chat-observation";
export type KnowledgeDecision =
  | "keep-current"
  | "adopt-new"
  | "adopt-edited"
  | "split-scope"
  | "reject-candidate";

export interface FactKeyInput {
  subject: string;
  predicate: string;
  scope?: Record<string, string | number | boolean | null>;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}

export interface NormalizedFactKey {
  subject: string;
  predicate: string;
  scopeJson: string;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  identity: string;
}

export interface KnowledgeSourceInput {
  materialId?: string | null;
  excerpt: string;
  confidence: number;
  profileProvenance?: "extracted" | "asked" | "inferred" | null;
}

export interface KnowledgeFactSource {
  rawInputId: string;
  materialId?: string | null;
  excerpt: string;
  confidence: number;
  profileProvenance?: "extracted" | "asked" | "inferred" | null;
  origin: KnowledgeCandidateOrigin;
  createdAt: string;
}

export interface KnowledgeCurrentFact {
  key: NormalizedFactKey;
  normalizedValueJson: string;
  unit?: string | null;
  version: number;
  confirmedBy: string;
  confirmedAt: string;
  sources: KnowledgeFactSource[];
}

export interface KnowledgeCandidate {
  id: string;
  workspaceId: string;
  sessionId: string;
  key: NormalizedFactKey;
  valueJson: string;
  normalizedValueJson: string;
  unit?: string | null;
  source: KnowledgeSourceInput;
  origin: KnowledgeCandidateOrigin;
  intent: KnowledgeRequestIntent;
  status:
    | "awaiting-confirmation"
    | "conflict"
    | "adopted"
    | "kept-current"
    | "split-scope"
    | "rejected";
  baseVersion: number;
  proposedAt: string;
  /**
   * 裁决落库时刻（geo-plan-normalization 票 08）：Rust 决策事务内与终态
   * 同笔写入 resolved_at 的原样值；未裁决候选为 null。卡片完成时刻的
   * 唯一权威源，Node/渲染侧不另行打点。
   */
  resolvedAt?: string | null;
  current?: KnowledgeCurrentFact | null;
}

export interface KnowledgeDecisionResult {
  candidateId: string;
  factKey: string;
  decision: KnowledgeDecision;
  status: string;
  /** 裁决落库时刻（票 08）：与终态同笔写入的 resolved_at。 */
  resolvedAt?: string | null;
  current?: KnowledgeCurrentFact | null;
  knowledgeVersion?: number | null;
  affectedArtifacts: GeoArtifactFreshnessProjection[];
}

interface CandidateSubmission {
  workspaceId: string;
  sessionId: string;
  rawInput: string;
  origin: KnowledgeCandidateOrigin;
  intent: KnowledgeRequestIntent;
  key: NormalizedFactKey;
  valueJson: string;
  normalizedValueJson: string;
  unit?: string | null;
  source: KnowledgeSourceInput;
  expectedCurrentVersion: number;
  disposition: "awaiting-confirmation" | "conflict";
}

interface DecisionSubmission {
  workspaceId: string;
  sessionId: string;
  candidateId: string;
  decision: KnowledgeDecision;
  expectedCurrentVersion: number;
  actorId: string;
  reason?: string | null;
  splitKey?: NormalizedFactKey | null;
  splitExpectedVersion?: number | null;
  editedNormalizedValueJson?: string | null;
}

/** 聊天修订（ADR 0003）的 port 载荷；add 携带完整候选提交。 */
interface RevisionSubmission {
  workspaceId: string;
  sessionId: string;
  action: KnowledgeRevisionAction;
  candidateId?: string | null;
  actorId: string;
  reason: string;
  valueJson?: string | null;
  normalizedValueJson?: string | null;
  unit?: string | null;
  submission?: CandidateSubmission | null;
}

export interface KnowledgeAuthorityPort {
  current(factKey: string): Promise<KnowledgeCurrentFact | null>;
  submit(request: CandidateSubmission): Promise<KnowledgeCandidate>;
  candidate(candidateId: string): Promise<KnowledgeCandidate>;
  decide(request: DecisionSubmission): Promise<KnowledgeDecisionResult>;
  revise(request: RevisionSubmission): Promise<KnowledgeCandidate>;
}

export interface KnowledgeProposalInput {
  rawInput: string;
  origin: KnowledgeCandidateOrigin;
  intent: KnowledgeRequestIntent;
  key: FactKeyInput;
  value: unknown;
  unit?: string | null;
  source: KnowledgeSourceInput;
}

export interface KnowledgeDecisionInput {
  candidateId: string;
  decision: KnowledgeDecision;
  expectedCurrentVersion: number;
  actorId: string;
  reason?: string;
  splitKey?: FactKeyInput;
  /** adopt-edited 必填：用户在确认卡内编辑后的值；其他决策不得携带。 */
  editedValue?: unknown;
}

export type KnowledgeRevisionAction = "modify" | "delete" | "add";

export interface KnowledgeRevisionModifyInput {
  action: "modify";
  candidateId: string;
  value: unknown;
  unit?: string | null;
  reason: string;
  actorId: string;
}

export interface KnowledgeRevisionDeleteInput {
  action: "delete";
  candidateId: string;
  reason: string;
  actorId: string;
}

export interface KnowledgeRevisionAddInput {
  action: "add";
  key: FactKeyInput;
  value: unknown;
  unit?: string | null;
  /** 待决复核卡的材料 id；携带时新候选挂回该卡，轮询重渲染出新行。 */
  materialId?: string | null;
  reason: string;
  actorId: string;
}

export type KnowledgeRevisionInput =
  | KnowledgeRevisionModifyInput
  | KnowledgeRevisionDeleteInput
  | KnowledgeRevisionAddInput;

export interface KnowledgeRevisionOutcome {
  action: KnowledgeRevisionAction;
  candidateId: string;
  status: string;
  candidate: KnowledgeCandidate;
}

function normalizedToken(value: string, label: string): string {
  const normalized = value
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("zh-CN");
  if (!normalized || normalized.length > 200) {
    throw new Error(`${label} must be 1-200 characters`);
  }
  return normalized;
}

function normalizedEffectiveTime(
  value: string | null | undefined,
  label: string,
): string | null {
  if (!value?.trim()) return null;
  const trimmed = value.trim();
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp))
    throw new Error(`${label} must be an ISO date or timestamp`);
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? trimmed
    : new Date(timestamp).toISOString();
}

function canonicalize(value: unknown): unknown {
  if (typeof value === "string") return value.trim().replace(/\s+/g, " ");
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("fact value cannot contain a non-finite number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (value === null || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [
          normalizedToken(key, "value key"),
          canonicalize(child),
        ]),
    );
  }
  throw new Error("fact value must be JSON-compatible");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

const UNIT_ALIASES: Record<string, string> = {
  元: "cny",
  人民币: "cny",
  rmb: "cny",
  "￥": "cny",
  "¥": "cny",
  美元: "usd",
  $: "usd",
  百分比: "percent",
  "%": "percent",
};

export function normalizeUnit(unit: string | null | undefined): string | null {
  if (!unit?.trim()) return null;
  const token = unit.trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN");
  return UNIT_ALIASES[token] ?? token;
}

export function normalizeFactKey(input: FactKeyInput): NormalizedFactKey {
  const subject = normalizedToken(input.subject, "subject");
  const predicate = normalizedToken(input.predicate, "predicate");
  const scope = Object.fromEntries(
    Object.entries(input.scope ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [
        normalizedToken(key, "scope key"),
        canonicalize(value),
      ]),
  );
  const scopeJson = JSON.stringify(scope);
  const effectiveFrom = normalizedEffectiveTime(
    input.effectiveFrom,
    "effectiveFrom",
  );
  const effectiveTo = normalizedEffectiveTime(input.effectiveTo, "effectiveTo");
  if (
    effectiveFrom &&
    effectiveTo &&
    Date.parse(effectiveFrom) >= Date.parse(effectiveTo)
  ) {
    throw new Error("effectiveTo must be later than effectiveFrom");
  }
  const identity = JSON.stringify({
    subject,
    predicate,
    scope,
    effectiveFrom,
    effectiveTo,
  });
  return {
    subject,
    predicate,
    scopeJson,
    effectiveFrom,
    effectiveTo,
    identity,
  };
}

export function normalizeFactValue(
  value: unknown,
  unit?: string | null,
): {
  valueJson: string;
  normalizedValueJson: string;
  unit: string | null;
} {
  const valueJson = JSON.stringify(value);
  if (valueJson === undefined)
    throw new Error("fact value must be JSON-compatible");
  return {
    valueJson,
    normalizedValueJson: canonicalJson(value),
    unit: normalizeUnit(unit),
  };
}

/** 解析 JSON 数组；非数组或非法 JSON 返回 null。 */
function parseJsonArray(json: string): unknown[] | null {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function classifyKnowledgeCandidate(
  current: KnowledgeCurrentFact | null,
  normalizedValueJson: string,
  unit: string | null,
  _origin: KnowledgeCandidateOrigin,
  _intent: KnowledgeRequestIntent,
): CandidateSubmission["disposition"] {
  if (!current) return "awaiting-confirmation";
  const same =
    current.normalizedValueJson === normalizedValueJson &&
    normalizeUnit(current.unit) === unit;
  if (same) return "awaiting-confirmation";
  // 数组字段的差异是补充语义而非矛盾：propose 已把候选改写为去重并集，
  // 整卡确认即采纳合并结果。只有标量 vs 标量、或类型不一致（一边数组
  // 一边标量）才是需要二选一的冲突。
  if (
    parseJsonArray(current.normalizedValueJson) &&
    parseJsonArray(normalizedValueJson)
  ) {
    return "awaiting-confirmation";
  }
  return "conflict";
}

/**
 * 数组字段增量合并：current 与候选同为 JSON 数组时，把候选改写为
 * 「current 各项在前、候选新增项去重后追加」的并集（去重按 canonicalJson
 * 逐项规范化比较，与 normalizeFactValue 口径一致），确认卡展示的候选值
 * 即 adopt-new 后的最终形态。标量或类型不一致保持原值（走冲突二选一）。
 * 并集与 current 完全相同时沿用既有 same 逻辑：仍落 awaiting-confirmation
 * 候选，整卡确认后仅合并来源、不升事实版本（见 Rust adopt-new 同值分支）。
 */
function mergeArraySupplement(
  current: KnowledgeCurrentFact | null,
  value: { valueJson: string; normalizedValueJson: string; unit: string | null },
): { valueJson: string; normalizedValueJson: string; unit: string | null } {
  if (!current) return value;
  const currentItems = parseJsonArray(current.normalizedValueJson);
  const candidateItems = parseJsonArray(value.normalizedValueJson);
  if (!currentItems || !candidateItems) return value;
  const seen = new Set(currentItems.map((item) => canonicalJson(item)));
  const merged = [...currentItems];
  for (const item of candidateItems) {
    const token = canonicalJson(item);
    if (seen.has(token)) continue;
    seen.add(token);
    merged.push(item);
  }
  const normalizedValueJson = canonicalJson(merged);
  return { valueJson: normalizedValueJson, normalizedValueJson, unit: value.unit };
}

/**
 * 候选审计摘录的长度闸门（propose 与 MCP 工具 schema 同源）。ADR-0007 后
 * 竞品摘录是纯证据文本（无元数据头），仍在预算内自截。
 */
export const KNOWLEDGE_EXCERPT_MAX_LENGTH = 4_000;

export class KnowledgeAuthority {
  constructor(
    private readonly identity: { workspaceId: string; sessionId: string },
    private readonly port: KnowledgeAuthorityPort,
  ) {}

  async propose(input: KnowledgeProposalInput): Promise<KnowledgeCandidate> {
    const key = normalizeFactKey(input.key);
    const value = normalizeFactValue(input.value, input.unit);
    const excerpt = input.source.excerpt.trim();
    if (!excerpt || excerpt.length > KNOWLEDGE_EXCERPT_MAX_LENGTH)
      throw new Error("source excerpt must be 1-4000 characters");
    if (
      !Number.isFinite(input.source.confidence) ||
      input.source.confidence < 0 ||
      input.source.confidence > 1
    ) {
      throw new Error("source confidence must be between 0 and 1");
    }
    if (
      input.source.profileProvenance &&
      !["extracted", "asked", "inferred"].includes(
        input.source.profileProvenance,
      )
    ) {
      throw new Error("invalid profile provenance");
    }
    const rawInput = input.rawInput.trim();
    if (!rawInput || rawInput.length > 20_000)
      throw new Error("raw input must be 1-20000 characters");

    return this.submitCandidate(key.identity, (current) => {
      const merged = mergeArraySupplement(current, value);
      return {
        rawInput,
        origin: input.origin,
        intent: input.intent,
        key,
        ...merged,
        source: { ...input.source, excerpt },
        expectedCurrentVersion: current?.version ?? 0,
        disposition: classifyKnowledgeCandidate(
          current,
          merged.normalizedValueJson,
          merged.unit,
          input.origin,
          input.intent,
        ),
      };
    }, (submission) => this.port.submit(submission));
  }

  /**
   * 读当前权威后构造提交，另一 Session 抢先提交时重试一次；Rust 的
   * IMMEDIATE 事务仍是最终 CAS 栅栏（propose 与聊天修订 add 共用）。
   */
  private async submitCandidate(
    factKeyIdentity: string,
    build: (
      current: KnowledgeCurrentFact | null,
    ) => Omit<CandidateSubmission, "workspaceId" | "sessionId">,
    submit: (
      submission: CandidateSubmission,
    ) => Promise<KnowledgeCandidate>,
  ): Promise<KnowledgeCandidate> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = await this.port.current(factKeyIdentity);
      try {
        return await submit({
          ...this.identity,
          ...build(current),
        });
      } catch (error) {
        if (
          attempt === 0 &&
          String(error).includes("knowledge_version_conflict")
        )
          continue;
        throw error;
      }
    }
    throw new Error("knowledge candidate retry exhausted");
  }

  inspect(key: FactKeyInput): Promise<KnowledgeCurrentFact | null> {
    return this.port.current(normalizeFactKey(key).identity);
  }

  /** 卡片重载后的状态水合：只允许读取本 Session 提交的候选。 */
  async candidate(candidateId: string): Promise<KnowledgeCandidate> {
    const candidate = await this.port.candidate(candidateId);
    if (
      candidate.workspaceId !== this.identity.workspaceId
      || candidate.sessionId !== this.identity.sessionId
    ) {
      throw new Error(
        "knowledge candidate does not belong to the current brand Session",
      );
    }
    return candidate;
  }

  async decide(
    input: KnowledgeDecisionInput,
  ): Promise<KnowledgeDecisionResult> {
    const candidate = await this.port.candidate(input.candidateId);
    if (
      candidate.workspaceId !== this.identity.workspaceId ||
      candidate.sessionId !== this.identity.sessionId
    ) {
      throw new Error(
        "knowledge candidate does not belong to the current brand Session",
      );
    }
    let splitKey: NormalizedFactKey | null = null;
    let splitExpectedVersion: number | null = null;
    let editedNormalizedValueJson: string | null = null;
    if (input.decision === "split-scope") {
      if (!input.splitKey)
        throw new Error("split-scope requires a structured key");
      splitKey = normalizeFactKey(input.splitKey);
      if (splitKey.identity === candidate.key.identity) {
        throw new Error("split-scope must change scope or effective time");
      }
      splitExpectedVersion =
        (await this.port.current(splitKey.identity))?.version ?? 0;
    } else if (input.splitKey) {
      throw new Error("splitKey is only valid for split-scope");
    }
    if (input.decision === "adopt-edited") {
      if (input.editedValue === undefined) {
        throw new Error("adopt-edited requires an edited value");
      }
      editedNormalizedValueJson = normalizeFactValue(
        input.editedValue,
        candidate.unit ?? undefined,
      ).normalizedValueJson;
    } else if (input.editedValue !== undefined) {
      throw new Error("editedValue is only valid for adopt-edited");
    }
    return this.port.decide({
      ...this.identity,
      candidateId: input.candidateId,
      decision: input.decision,
      expectedCurrentVersion: input.expectedCurrentVersion,
      actorId: input.actorId,
      reason: input.reason,
      splitKey,
      splitExpectedVersion,
      editedNormalizedValueJson,
    });
  }

  /**
   * 聊天修订（ADR 0003）：仅作用于本 Session 的未决候选
   * （awaiting-confirmation/conflict）。modify 走既有归一化管道；delete 终结
   * 候选；add 走 propose 语义落为 user-stated/asked 待确认候选。Rust 端写
   * `knowledge_candidate_revisions` 审计并按候选 id 覆盖卡片本地暂存；不投送
   * 知识决策 reminder（reminder 只在裁决提交时投送）。
   */
  async revise(
    input: KnowledgeRevisionInput,
  ): Promise<KnowledgeRevisionOutcome> {
    const reason = input.reason.trim();
    if (!reason || reason.length > 20_000) {
      throw new Error(
        "knowledge revision requires the user's explicit instruction (1-20000 characters)",
      );
    }
    if (input.action === "add") {
      const key = normalizeFactKey(input.key);
      const value = normalizeFactValue(input.value, input.unit);
      const candidate = await this.submitCandidate(
        key.identity,
        (current) => {
          const merged = mergeArraySupplement(current, value);
          return {
            rawInput: reason,
            origin: "user-stated" as const,
            intent: "knowledge-update" as const,
            key,
            ...merged,
            source: {
              materialId: input.materialId ?? null,
              excerpt: reason.slice(0, KNOWLEDGE_EXCERPT_MAX_LENGTH),
              confidence: 1,
              profileProvenance: "asked" as const,
            },
            expectedCurrentVersion: current?.version ?? 0,
            disposition: classifyKnowledgeCandidate(
              current,
              merged.normalizedValueJson,
              merged.unit,
              "user-stated",
              "knowledge-update",
            ),
          };
        },
        (submission) =>
          this.port.revise({
            ...this.identity,
            action: "add",
            actorId: input.actorId,
            reason,
            submission,
          }),
      );
      return {
        action: "add",
        candidateId: candidate.id,
        status: candidate.status,
        candidate,
      };
    }
    const candidate = await this.candidate(input.candidateId);
    if (
      candidate.status !== "awaiting-confirmation" &&
      candidate.status !== "conflict"
    ) {
      throw new Error("knowledge candidate is no longer pending");
    }
    const revised =
      input.action === "modify"
        ? await this.port.revise({
            ...this.identity,
            action: "modify",
            candidateId: input.candidateId,
            actorId: input.actorId,
            reason,
            ...normalizeFactValue(
              input.value,
              input.unit ?? candidate.unit ?? undefined,
            ),
          })
        : await this.port.revise({
            ...this.identity,
            action: "delete",
            candidateId: input.candidateId,
            actorId: input.actorId,
            reason,
          });
    return {
      action: input.action,
      candidateId: revised.id,
      status: revised.status,
      candidate: revised,
    };
  }
}

function managementError(result: Record<string, unknown>): Error {
  return new Error(
    typeof result.error === "string"
      ? result.error
      : "Brand knowledge persistence failed",
  );
}

export class RustKnowledgeAuthorityPort implements KnowledgeAuthorityPort {
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

  async current(factKey: string): Promise<KnowledgeCurrentFact | null> {
    const result = await managementApi(
      "/api/brand-knowledge/current",
      "POST",
      this.envelope({ factKey }),
    );
    if (result.ok !== true) throw managementError(result);
    return (result.current as KnowledgeCurrentFact | null | undefined) ?? null;
  }

  async submit(request: CandidateSubmission): Promise<KnowledgeCandidate> {
    const result = await managementApi(
      "/api/brand-knowledge/candidate/submit",
      "POST",
      this.envelope(request as unknown as Record<string, unknown>),
    );
    if (result.ok !== true) throw managementError(result);
    return result.candidate as KnowledgeCandidate;
  }

  async candidate(candidateId: string): Promise<KnowledgeCandidate> {
    const result = await managementApi(
      "/api/brand-knowledge/candidate/get",
      "POST",
      this.envelope({ candidateId }),
    );
    if (result.ok !== true) throw managementError(result);
    return result.candidate as KnowledgeCandidate;
  }

  async decide(request: DecisionSubmission): Promise<KnowledgeDecisionResult> {
    const result = await managementApi(
      "/api/brand-knowledge/candidate/decide",
      "POST",
      this.envelope(request as unknown as Record<string, unknown>),
    );
    if (result.ok !== true) throw managementError(result);
    return result.result as KnowledgeDecisionResult;
  }

  async revise(request: RevisionSubmission): Promise<KnowledgeCandidate> {
    const result = await managementApi(
      "/api/brand-knowledge/candidate/revise",
      "POST",
      this.envelope(request as unknown as Record<string, unknown>),
    );
    if (result.ok !== true) throw managementError(result);
    return result.candidate as KnowledgeCandidate;
  }
}

export function createKnowledgeAuthority(identity: {
  workspaceId: string;
  sessionId: string;
}): KnowledgeAuthority {
  const sidecarId = process.env.XIAOJING_SIDECAR_ID?.trim();
  if (!sidecarId)
    throw new Error(
      "Brand knowledge requires an authenticated Sidecar identity",
    );
  return new KnowledgeAuthority(
    identity,
    new RustKnowledgeAuthorityPort({ ...identity, sidecarId }),
  );
}

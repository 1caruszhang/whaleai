import {
  GEO_BASELINE_POLICY_VERSION,
  analyzeGeoProbeAnswer,
  parseGeoProbeProviderResponse,
  type GeoBaselineEngineAvailability,
  type GeoBaselineEngineId,
  type GeoBaselineEvidenceUnit,
  type GeoBaselineProjection,
  type GeoBaselineProviderSnapshot,
  type GeoProbeAnalysis,
  type GeoProbeCitation,
} from "../../shared/geo/baseline";
import { managementApi } from "../utils/management-api-client";
import { GatewayBillingError, type GeoBillingPermitPort } from "./billing-permit";
import type { GeoKeywordSearchCapability } from "./provider-capabilities";

interface GeoBaselinePreparation {
  baseline: GeoBaselineProjection;
  brandNames: string[];
  competitorNames: string[];
}

interface GeoBaselineUnitClaim {
  action: "execute" | "cached" | "busy";
  claimToken?: string | null;
  attemptNumber: number;
}

export interface GeoBaselinePersistencePort {
  latest(): Promise<GeoBaselineProjection | null>;
  get(baselineId: string): Promise<GeoBaselineProjection | null>;
  prepare(input: {
    workspaceId: string;
    sessionId: string;
    questionPoolId: string;
    engineIds: GeoBaselineEngineId[];
    providerSnapshots: GeoBaselineProviderSnapshot[];
    idempotencyKey: string;
    policyVersion: typeof GEO_BASELINE_POLICY_VERSION;
  }): Promise<GeoBaselinePreparation>;
  claim(input: {
    baselineId: string;
    unitId: string;
  }): Promise<GeoBaselineUnitClaim>;
  finish(input: {
    baselineId: string;
    unitId: string;
    claimToken: string;
    status: "succeeded" | "failed";
    rawAnswer?: string;
    rawEvidence?: unknown;
    citations?: GeoProbeCitation[];
    analysis?: GeoProbeAnalysis;
    durationMs: number;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<void>;
}

function persistenceError(result: Record<string, unknown>): Error {
  return new Error(
    typeof result.error === "string"
      ? result.error
      : "geo_baseline_persistence_failed",
  );
}

export class RustGeoBaselinePort implements GeoBaselinePersistencePort {
  constructor(
    private readonly identity: {
      workspaceId: string;
      sessionId: string;
      sidecarId: string;
    },
  ) {}

  private async post<T>(
    path: string,
    payload: Record<string, unknown>,
    key: string,
  ): Promise<T> {
    const result = await managementApi(path, "POST", {
      ...this.identity,
      payload,
    });
    if (result.ok !== true) throw persistenceError(result);
    return result[key] as T;
  }

  latest(): Promise<GeoBaselineProjection | null> {
    return this.post("/api/brand-geo-baselines/latest", {}, "baseline");
  }

  get(baselineId: string): Promise<GeoBaselineProjection | null> {
    return this.post(
      "/api/brand-geo-baselines/get",
      { baselineId },
      "baseline",
    );
  }

  prepare(
    input: Parameters<GeoBaselinePersistencePort["prepare"]>[0],
  ): Promise<GeoBaselinePreparation> {
    return this.post("/api/brand-geo-baselines/prepare", input, "preparation");
  }

  claim(
    input: Parameters<GeoBaselinePersistencePort["claim"]>[0],
  ): Promise<GeoBaselineUnitClaim> {
    return this.post("/api/brand-geo-baselines/unit/claim", input, "claim");
  }

  async finish(
    input: Parameters<GeoBaselinePersistencePort["finish"]>[0],
  ): Promise<void> {
    await this.post("/api/brand-geo-baselines/unit/finish", input, "unit");
  }
}

export function createGeoBaselinePort(identity: {
  workspaceId: string;
  sessionId: string;
}): RustGeoBaselinePort {
  const sidecarId = process.env.XIAOJING_SIDECAR_ID?.trim();
  if (!sidecarId)
    throw new Error("GEO baseline requires an authenticated Sidecar identity");
  return new RustGeoBaselinePort({ ...identity, sidecarId });
}

function safeFailure(error: unknown): { code: string; message: string } {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .slice(0, 500);
  // 计费拒绝（票 07）：余额不足等语义码保留服务端文案（含「需 X 点、
  // 当前 Y 点」），错误码单列，不再落入泛化 provider_failed。
  if (
    error instanceof GatewayBillingError ||
    message.includes("点数不足")
  ) {
    const code =
      error instanceof GatewayBillingError ? error.code : "billing_failed";
    return { code: `geo_baseline_${code}`, message };
  }
  if (message.includes("geo_baseline_empty_response")) {
    return { code: "geo_baseline_empty_response", message: "Provider 未返回可用回答" };
  }
  if (message.includes("限流") || message.includes("429")) {
    return { code: "geo_baseline_rate_limited", message };
  }
  if (message.includes("凭据") || message.includes("无权")) {
    return { code: "geo_baseline_provider_unavailable", message };
  }
  if (message.includes("AbortError") || message.includes("aborted")) {
    return { code: "geo_baseline_cancelled", message: "检测已取消" };
  }
  if (message.includes("snapshot_changed")) {
    return { code: "geo_baseline_provider_snapshot_changed", message };
  }
  return { code: "geo_baseline_provider_failed", message };
}

/**
 * Rust serde_json persists provider snapshots with alphabetically ordered
 * keys, while Node constructs them in source order. Snapshot equality must be
 * key-order insensitive or every round-tripped unit would falsely report
 * `geo_baseline_provider_snapshot_changed`.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sameSnapshot(
  left: GeoBaselineProviderSnapshot,
  right: GeoBaselineProviderSnapshot,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export class GeoBaselineService {
  private readonly running = new Map<string, Promise<GeoBaselineProjection>>();

  constructor(
    private readonly identity: { workspaceId: string; sessionId: string },
    private readonly persistence: GeoBaselinePersistencePort,
    private readonly provider: GeoKeywordSearchCapability,
    private readonly now: () => number = Date.now,
    /** 网关计费（票 07）：基线探测 5 点/问；缺省时跳过全部 permit 路径。 */
    private readonly permits?: GeoBillingPermitPort,
  ) {}

  engines(): readonly GeoBaselineEngineAvailability[] {
    return this.provider.baselineEngines();
  }

  latest(input: {
    workspaceId: string;
    sessionId: string;
  }): Promise<GeoBaselineProjection | null> {
    this.requireIdentity(input);
    return this.persistence.latest();
  }

  start(input: {
    workspaceId: string;
    sessionId: string;
    questionPoolId: string;
    engineIds: GeoBaselineEngineId[];
    idempotencyKey: string;
  }): Promise<GeoBaselineProjection> {
    this.requireIdentity(input);
    const existing = this.running.get(input.idempotencyKey);
    if (existing) return existing;
    const work = this.startRun(input).finally(() => {
      this.running.delete(input.idempotencyKey);
    });
    this.running.set(input.idempotencyKey, work);
    return work;
  }

  private async startRun(input: {
    workspaceId: string;
    sessionId: string;
    questionPoolId: string;
    engineIds: GeoBaselineEngineId[];
    idempotencyKey: string;
  }): Promise<GeoBaselineProjection> {
    const availability = new Map(
      this.provider.baselineEngines().map((engine) => [engine.id, engine]),
    );
    const engineIds = [...new Set(input.engineIds)];
    if (engineIds.length === 0) throw new Error("geo_baseline_engine_required");
    const selected = engineIds.map((engineId) => availability.get(engineId));
    if (selected.some((engine) => !engine?.available)) {
      throw new Error("geo_baseline_provider_unavailable");
    }
    const preparation = await this.persistence.prepare({
      ...this.identity,
      questionPoolId: input.questionPoolId,
      engineIds,
      providerSnapshots: selected.map((engine) => engine!.snapshot),
      idempotencyKey: input.idempotencyKey,
      policyVersion: GEO_BASELINE_POLICY_VERSION,
    });
    const units = preparation.baseline.units.filter(
      (unit) => unit.status === "pending" || unit.status === "failed",
    );
    await this.runUnits(
      preparation.baseline.id,
      units,
      preparation.brandNames,
      preparation.competitorNames,
    );
    const completed = await this.persistence.get(preparation.baseline.id);
    if (!completed) throw new Error("geo_baseline_not_found");
    return completed;
  }

  async retry(input: {
    workspaceId: string;
    sessionId: string;
    baselineId: string;
    unitIds: string[];
  }): Promise<GeoBaselineProjection> {
    this.requireIdentity(input);
    const current = await this.persistence.get(input.baselineId);
    if (!current) throw new Error("geo_baseline_not_found");
    const requested = new Set(input.unitIds);
    const units = current.units.filter(
      (unit) => requested.has(unit.id) && unit.status === "failed",
    );
    if (units.length === 0) throw new Error("geo_baseline_failed_unit_required");
    await this.runUnits(
      current.id,
      units,
      current.brandNames,
      current.competitorNames,
    );
    const completed = await this.persistence.get(current.id);
    if (!completed) throw new Error("geo_baseline_not_found");
    return completed;
  }

  private async runUnits(
    baselineId: string,
    units: GeoBaselineEvidenceUnit[],
    brandNames: string[],
    competitorNames: string[],
  ): Promise<void> {
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const unit = units[cursor++];
        if (!unit) return;
        await this.runUnit(baselineId, unit, brandNames, competitorNames);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(2, units.length) }, () => worker()),
    );
  }

  private async runUnit(
    baselineId: string,
    unit: GeoBaselineEvidenceUnit,
    brandNames: string[],
    competitorNames: string[],
  ): Promise<void> {
    const claim = await this.persistence.claim({ baselineId, unitId: unit.id });
    if (claim.action !== "execute" || !claim.claimToken) return;
    // 计费（票 07）：基线探测 5 点/问，最小成败单位 = 单问探测。permitId
    // 绑定 (baseline, unit, attemptNumber)：网络重试/恢复重跑同一 attempt 重放
    // 同一 permit；用户显式重试失败问是新的 claim attempt → 新 permit（上轮
    // 失败已回补）。claim 命中缓存（已完成问）在上面直接返回，不扣点。
    // permit 申请失败（余额不足/并发准入）按单问失败落库并继续其余问，
    // 未取得的 permit 不回报。
    const permitId = `gbl:${baselineId}:${unit.id}:${claim.attemptNumber}`;
    let permitAcquired = false;
    const settlePermit = async (outcome: "success" | "failure") => {
      if (!this.permits || !permitAcquired) return;
      await this.permits.reportUnit(permitId, 0, outcome).catch(() => undefined);
    };
    const startedAt = this.now();
    try {
      if (this.permits) {
        await this.permits.apply({
          permitId,
          operation: "baseline_probe",
          units: 1,
        });
        permitAcquired = true;
      }
      const currentEngine = this.provider
        .baselineEngines()
        .find((engine) => engine.id === unit.engineId);
      if (!currentEngine?.available) {
        throw new Error("geo_baseline_provider_unavailable");
      }
      if (!sameSnapshot(currentEngine.snapshot, unit.providerSnapshot)) {
        throw new Error("geo_baseline_provider_snapshot_changed");
      }
      const response = await this.provider.probeQuestion(
        unit.engineId,
        unit.question,
      );
      if (!sameSnapshot(response.snapshot, unit.providerSnapshot)) {
        throw new Error("geo_baseline_provider_snapshot_changed");
      }
      const parsed = parseGeoProbeProviderResponse(response.rawEvidence);
      const analysis = analyzeGeoProbeAnswer(
        parsed.answer,
        brandNames,
        parsed.citations,
        competitorNames,
      );
      await this.persistence.finish({
        baselineId,
        unitId: unit.id,
        claimToken: claim.claimToken,
        status: "succeeded",
        rawAnswer: parsed.answer,
        rawEvidence: response.rawEvidence,
        citations: parsed.citations,
        analysis,
        durationMs: Math.max(0, this.now() - startedAt),
      });
      await settlePermit("success");
    } catch (error) {
      const failure = safeFailure(error);
      await this.persistence.finish({
        baselineId,
        unitId: unit.id,
        claimToken: claim.claimToken,
        status: "failed",
        durationMs: Math.max(0, this.now() - startedAt),
        errorCode: failure.code,
        errorMessage: failure.message,
      });
      await settlePermit("failure");
    }
  }

  private requireIdentity(input: {
    workspaceId: string;
    sessionId: string;
  }): void {
    if (
      input.workspaceId !== this.identity.workspaceId ||
      input.sessionId !== this.identity.sessionId
    ) {
      throw new Error("geo_baseline_identity_mismatch");
    }
  }
}

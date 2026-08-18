import { describe, expect, it, vi } from "vitest";

import {
  GEO_BASELINE_POLICY_VERSION,
  aggregateGeoBaselineUnits,
  type GeoBaselineEvidenceUnit,
  type GeoBaselineProjection,
  type GeoBaselineProviderSnapshot,
} from "../../shared/geo/baseline";
import { GatewayBillingError } from "./billing-permit";
import {
  GeoBaselineService,
  type GeoBaselinePersistencePort,
} from "./baseline";
import type { GeoKeywordSearchCapability } from "./provider-capabilities";

const snapshot: GeoBaselineProviderSnapshot = {
  engineId: "doubao" as const,
  provider: "volcengine" as const,
  capabilitySlot: "keyword-search" as const,
  model: "doubao-seed-2-0-lite-260428",
  endpointFamily: "ark-responses" as const,
  searchMode: "doubao-app-ai-search" as const,
  configurationFingerprint: "test-config-fingerprint",
  policyVersion: GEO_BASELINE_POLICY_VERSION,
};

function unit(id: string, question: string): GeoBaselineEvidenceUnit {
  return {
    id,
    questionId: `q-${id}`,
    question,
    engineId: "doubao",
    providerSnapshot: snapshot,
    status: "pending",
    attemptNumber: 0,
    citations: [],
    attempts: [],
  };
}

function baseline(units = [unit("unit-1", "成都汽车音响改装哪家好？")]): GeoBaselineProjection {
  return {
    id: "baseline-09",
    operationId: "operation-09",
    workspaceId: "brand-09",
    createdBySessionId: "session-09",
    questionPoolId: "pool-08",
    questionPoolRevision: 1,
    knowledgeVersion: 7,
    brandNames: ["鲸跃", "鲸跃汽车"],
    providerSnapshots: [snapshot],
    policyVersion: GEO_BASELINE_POLICY_VERSION,
    status: "running",
    metrics: aggregateGeoBaselineUnits(units),
    units,
    createdAt: "2026-08-15T00:00:00Z",
    updatedAt: "2026-08-15T00:00:00Z",
  };
}

class FakePersistence implements GeoBaselinePersistencePort {
  projection = baseline();
  latestProjection: GeoBaselineProjection | null = null;
  readonly claims: string[] = [];
  readonly finishes: Array<Parameters<GeoBaselinePersistencePort["finish"]>[0]> = [];

  async latest() {
    this.refresh();
    return this.latestProjection ?? this.projection;
  }

  async get(baselineId: string) {
    this.refresh();
    return this.projection.id === baselineId ? this.projection : null;
  }

  async prepare() {
    return { baseline: this.projection, brandNames: this.projection.brandNames };
  }

  async claim(input: Parameters<GeoBaselinePersistencePort["claim"]>[0]) {
    this.claims.push(input.unitId);
    const target = this.projection.units.find((item) => item.id === input.unitId)!;
    target.status = "running";
    target.attemptNumber += 1;
    return {
      action: "execute" as const,
      claimToken: `claim-${input.unitId}-${target.attemptNumber}`,
      attemptNumber: target.attemptNumber,
    };
  }

  async finish(input: Parameters<GeoBaselinePersistencePort["finish"]>[0]) {
    this.finishes.push(input);
    const target = this.projection.units.find((item) => item.id === input.unitId)!;
    Object.assign(target, input);
    target.attempts.push({
      attemptNumber: target.attemptNumber,
      status: input.status,
      startedAt: "2026-08-15T00:00:00Z",
      finishedAt: "2026-08-15T00:00:01Z",
      durationMs: input.durationMs,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
    });
    this.refresh();
  }

  private refresh() {
    this.projection.metrics = aggregateGeoBaselineUnits(this.projection.units);
    this.projection.status =
      this.projection.metrics.pending > 0
        ? "running"
        : this.projection.metrics.failed === 0
          ? "succeeded"
          : this.projection.metrics.succeeded > 0
            ? "partial"
            : "failed";
  }
}

function provider(run: (question: string) => Promise<unknown>) {
  return {
    slot: "keyword-search" as const,
    search: vi.fn(async () => ""),
    baselineEngines: vi.fn<GeoKeywordSearchCapability["baselineEngines"]>(() => [
      {
        id: "doubao" as const,
        label: "豆包 AI 搜索",
        available: true,
        snapshot,
      },
    ]),
    probeQuestion: vi.fn<GeoKeywordSearchCapability["probeQuestion"]>(async (_engineId, question) => ({
      rawEvidence: await run(question),
      snapshot,
    })),
  } satisfies GeoKeywordSearchCapability;
}

const identity = { workspaceId: "brand-09", sessionId: "session-09" };

describe("GeoBaselineService", () => {
  it("probes each pinned question, persists raw evidence and computes independent metrics", async () => {
    const persistence = new FakePersistence();
    persistence.projection = baseline([
      unit("unit-1", "问题一"),
      unit("unit-2", "问题二"),
    ]);
    const capability = provider(async (question) => ({
      output_text:
        question === "问题一" ? "推荐鲸跃汽车，值得考虑。" : "行业选择很多。",
      output: question === "问题一"
        ? [{ result: { title: "报道", url: "https://example.cn/a" } }]
        : [],
    }));
    let now = 100;
    const service = new GeoBaselineService(
      identity,
      persistence,
      capability,
      () => (now += 10),
    );

    const result = await service.start({
      ...identity,
      questionPoolId: "pool-08",
      engineIds: ["doubao"],
      idempotencyKey: "baseline-request-09",
    });

    expect(capability.probeQuestion).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      knowledgeVersion: 7,
      questionPoolId: "pool-08",
      providerSnapshots: [snapshot],
      status: "succeeded",
      metrics: {
        succeeded: 2,
        brandMentioned: 1,
        brandRecommended: 1,
        withCitationEvidence: 1,
      },
    });
    expect(result.units[0]).toMatchObject({
      rawAnswer: "推荐鲸跃汽车，值得考虑。",
      citations: [{ url: "https://example.cn/a" }],
      analysis: {
        brandMentioned: true,
        brandRecommended: true,
        hasCitationEvidence: true,
      },
    });
  });

  it("keeps one provider failure diagnostic and retries only that evidence unit", async () => {
    const persistence = new FakePersistence();
    persistence.projection = baseline([
      unit("unit-good", "成功问题"),
      unit("unit-fail", "失败问题"),
    ]);
    let fail = true;
    const capability = provider(async (question) => {
      if (question === "失败问题" && fail) throw new Error("服务限流（HTTP 429）");
      return { output_text: "鲸跃汽车被提及。", output: [] };
    });
    const service = new GeoBaselineService(identity, persistence, capability);
    const first = await service.start({
      ...identity,
      questionPoolId: "pool-08",
      engineIds: ["doubao"],
      idempotencyKey: "baseline-request-09",
    });
    expect(first.status).toBe("partial");
    expect(first.units.find((item) => item.id === "unit-fail")).toMatchObject({
      status: "failed",
      errorCode: "geo_baseline_rate_limited",
      attemptNumber: 1,
    });

    fail = false;
    const retried = await service.retry({
      ...identity,
      baselineId: first.id,
      unitIds: ["unit-fail"],
    });
    expect(retried.status).toBe("succeeded");
    expect(capability.probeQuestion.mock.calls.map((call) => call[1])).toEqual([
      "成功问题",
      "失败问题",
      "失败问题",
    ]);
    expect(retried.units.find((item) => item.id === "unit-fail")?.attempts).toHaveLength(2);
  });

  it("returns and retries the exact baseline when another Session creates the latest baseline", async () => {
    const persistence = new FakePersistence();
    persistence.projection = baseline([unit("unit-old", "旧基线问题")]);
    const concurrent = baseline([unit("unit-new", "并发新基线问题")]);
    concurrent.id = "baseline-from-session-b";
    concurrent.operationId = "operation-from-session-b";
    concurrent.createdBySessionId = "session-b";
    persistence.latestProjection = concurrent;
    let fail = true;
    const capability = provider(async () => {
      if (fail) throw new Error("服务限流（HTTP 429）");
      return { output_text: "鲸跃汽车被提及。", output: [] };
    });
    const service = new GeoBaselineService(identity, persistence, capability);

    const started = await service.start({
      ...identity,
      questionPoolId: "pool-08",
      engineIds: ["doubao"],
      idempotencyKey: "baseline-request-exact",
    });
    expect(started.id).toBe("baseline-09");
    expect(started.status).toBe("failed");

    fail = false;
    const retried = await service.retry({
      ...identity,
      baselineId: started.id,
      unitIds: ["unit-old"],
    });
    expect(retried.id).toBe("baseline-09");
    expect(retried.status).toBe("succeeded");
    expect(capability.probeQuestion).toHaveBeenCalledTimes(2);
  });

  it("fails before persistence when no selected real provider is available", async () => {
    const persistence = new FakePersistence();
    const capability = provider(async () => ({}));
    capability.baselineEngines.mockReturnValue([
      {
        id: "doubao",
        label: "豆包 AI 搜索",
        available: false,
        unavailableReason: "未配置",
        snapshot,
      },
    ]);
    const service = new GeoBaselineService(identity, persistence, capability);
    await expect(
      service.start({
        ...identity,
        questionPoolId: "pool-08",
        engineIds: ["doubao"],
        idempotencyKey: "baseline-request-09",
      }),
    ).rejects.toThrow("geo_baseline_provider_unavailable");
    expect(persistence.claims).toEqual([]);
  });

  it("does not call the provider after the pinned configuration snapshot changes", async () => {
    const persistence = new FakePersistence();
    persistence.projection.units[0].status = "failed";
    const capability = provider(async () => ({ output_text: "不应执行" }));
    capability.baselineEngines.mockReturnValue([
      {
        id: "doubao",
        label: "豆包 AI 搜索",
        available: true,
        snapshot: {
          ...snapshot,
          configurationFingerprint: "different-config-fingerprint",
        },
      },
    ]);
    const service = new GeoBaselineService(identity, persistence, capability);

    const result = await service.retry({
      ...identity,
      baselineId: persistence.projection.id,
      unitIds: ["unit-1"],
    });

    expect(capability.probeQuestion).not.toHaveBeenCalled();
    expect(result.units[0]).toMatchObject({
      status: "failed",
      errorCode: "geo_baseline_provider_snapshot_changed",
    });
  });

  it("accepts a snapshot whose keys were reordered by the Rust JSON round trip", async () => {
    const persistence = new FakePersistence();
    persistence.projection.units[0].status = "failed";
    const capability = provider(async () => ({ output_text: "鲸跃汽车被提及。", output: [] }));
    // serde_json persists maps with alphabetically sorted keys; the snapshot
    // content is identical, only the key order differs.
    const reordered = JSON.parse(
      JSON.stringify(snapshot, Object.keys(snapshot).sort()),
    ) as GeoBaselineProviderSnapshot;
    capability.baselineEngines.mockReturnValue([
      {
        id: "doubao",
        label: "豆包 AI 搜索",
        available: true,
        snapshot: reordered,
      },
    ]);
    capability.probeQuestion.mockResolvedValue({
      rawEvidence: { output_text: "鲸跃汽车被提及。", output: [] },
      snapshot: reordered,
    });
    const service = new GeoBaselineService(identity, persistence, capability);

    const result = await service.retry({
      ...identity,
      baselineId: persistence.projection.id,
      unitIds: ["unit-1"],
    });

    expect(capability.probeQuestion).toHaveBeenCalledTimes(1);
    expect(result.units[0]).toMatchObject({ status: "succeeded" });
  });
});

describe("GeoBaselineService billing permits (ticket 07)", () => {
  function permitPort(options: { failApplyWith?: Error } = {}) {
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
          if (options.failApplyWith) throw options.failApplyWith;
          return {
            permitId: input.permitId,
            operation: input.operation,
            units: input.units,
            totalPoints: 5,
            status: "open" as const,
            frozenPoints: 5,
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

  function billed(persistence: FakePersistence, permits: ReturnType<typeof permitPort>["port"]) {
    return new GeoBaselineService(identity, persistence, provider(async () => ({
      output_text: "鲸跃汽车。",
      output: [],
    })), undefined as unknown as () => number, permits);
  }

  it("bills each executed unit as its own baseline_probe permit keyed by attempt", async () => {
    const persistence = new FakePersistence();
    persistence.projection = baseline([
      unit("unit-1", "问题一"),
      unit("unit-2", "问题二"),
    ]);
    const permits = permitPort();
    const service = billed(persistence, permits.port);

    const result = await service.start({
      ...identity,
      questionPoolId: "pool-08",
      engineIds: ["doubao"],
      idempotencyKey: "run-1",
    });

    expect(result.metrics.succeeded).toBe(2);
    expect(permits.calls).toEqual([
      { kind: "apply", permitId: "gbl:baseline-09:unit-1:1", operation: "baseline_probe", units: 1 },
      { kind: "apply", permitId: "gbl:baseline-09:unit-2:1", operation: "baseline_probe", units: 1 },
      { kind: "report", permitId: "gbl:baseline-09:unit-1:1", unit: 0, outcome: "success" },
      { kind: "report", permitId: "gbl:baseline-09:unit-2:1", unit: 0, outcome: "success" },
    ]);
  });

  it("reports a failed unit as failure (per-question refund) and keeps other units isolated", async () => {
    const persistence = new FakePersistence();
    persistence.projection = baseline([
      unit("unit-1", "问题一"),
      unit("unit-2", "问题二"),
    ]);
    const permits = permitPort();
    const capability = provider(async (question) => {
      if (question === "问题一") throw new Error("keyword-search 上游请求失败（HTTP 500）");
      return { output_text: "鲸跃汽车。", output: [] };
    });
    const service = new GeoBaselineService(
      identity,
      persistence,
      capability,
      undefined as unknown as () => number,
      permits.port,
    );

    const result = await service.start({
      ...identity,
      questionPoolId: "pool-08",
      engineIds: ["doubao"],
      idempotencyKey: "run-2",
    });

    expect(result.metrics).toMatchObject({ succeeded: 1, failed: 1 });
    expect(permits.calls).toContainEqual({
      kind: "report",
      permitId: "gbl:baseline-09:unit-1:1",
      unit: 0,
      outcome: "failure",
    });
    expect(permits.calls).toContainEqual({
      kind: "report",
      permitId: "gbl:baseline-09:unit-2:1",
      unit: 0,
      outcome: "success",
    });
  });

  it("marks the unit failed without any report when the permit is rejected (insufficient balance)", async () => {
    const persistence = new FakePersistence();
    const permits = permitPort({
      failApplyWith: new GatewayBillingError(
        "insufficient_balance",
        "点数不足：本次需 5 点，当前可用 4 点，请充值后再试。",
        402,
        { required: 5, available: 4 },
      ),
    });
    const service = billed(persistence, permits.port);

    const result = await service.start({
      ...identity,
      questionPoolId: "pool-08",
      engineIds: ["doubao"],
      idempotencyKey: "run-3",
    });

    expect(result.metrics).toMatchObject({ failed: 1, succeeded: 0 });
    expect(result.units[0].attempts[0]).toMatchObject({
      errorCode: "geo_baseline_insufficient_balance",
    });
    // 未取得 permit：只有申请记录，零回报。
    expect(permits.calls).toEqual([
      { kind: "apply", permitId: "gbl:baseline-09:unit-1:1", operation: "baseline_probe", units: 1 },
    ]);
  });

  it("re-uses a fresh permit per retry attempt while cached claims stay free", async () => {
    const persistence = new FakePersistence();
    // 第一轮：unit-1 失败落库。
    const failing = provider(() =>
      Promise.reject(new Error("keyword-search 上游请求失败（HTTP 500）")),
    );
    const firstRound = new GeoBaselineService(
      identity,
      persistence,
      failing,
      undefined as unknown as () => number,
    );
    await firstRound.start({
      ...identity,
      questionPoolId: "pool-08",
      engineIds: ["doubao"],
      idempotencyKey: "run-4",
    });

    // 第二轮（用户重试失败问）：新 claim attempt → 新 permit；缓存命中
    // （已完成问）不发 permit。
    const permits = permitPort();
    const service = new GeoBaselineService(
      identity,
      persistence,
      provider(async () => ({ output_text: "鲸跃汽车。", output: [] })),
      undefined as unknown as () => number,
      permits.port,
    );
    await service.start({
      ...identity,
      questionPoolId: "pool-08",
      engineIds: ["doubao"],
      idempotencyKey: "run-4",
    });

    // 失败问仍属 pending/failed → 只对失败问重新计费探测，attempt 2。
    expect(permits.calls).toEqual([
      { kind: "apply", permitId: "gbl:baseline-09:unit-1:2", operation: "baseline_probe", units: 1 },
      { kind: "report", permitId: "gbl:baseline-09:unit-1:2", unit: 0, outcome: "success" },
    ]);
  });
});

import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";

import { managementApi } from "../utils/management-api-client";
import type {
  GeoDistributionCapability,
  GeoEmbeddingCapability,
  GeoKeywordSearchCapability,
  GeoObjectStorageCapability,
  GeoProviderCapabilities,
  GeoTextCapability,
} from "./provider-capabilities";

export interface GeoProviderQueueProjection {
  state: "acquired" | "queued";
  requestId: string;
  permitToken: string | null;
  queueReason: string | null;
  queuePosition: number | null;
  concurrencyLimit: number;
  activeCount: number;
}

interface GeoProviderAdmissionIdentity {
  workspaceId: string;
  sessionId: string;
  sidecarId: string;
}

type ManagementPost = (
  path: string,
  method: "POST",
  body: Record<string, unknown>,
  options?: { timeoutMs?: number; parentSignal?: AbortSignal },
) => Promise<Record<string, unknown>>;

export interface GeoProviderAdmissionDependencies {
  post?: ManagementPost;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  requestId?: () => string;
  onQueue?: (projection: GeoProviderQueueProjection) => void;
}

const POLL_INTERVAL_MS = 250;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveSleep, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolveSleep, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

function requireProjection(
  result: Record<string, unknown>,
): GeoProviderQueueProjection {
  if (
    result.ok !== true ||
    !result.permit ||
    typeof result.permit !== "object"
  ) {
    const code =
      typeof result.code === "string"
        ? result.code
        : "geo_provider_permit_failed";
    const message = typeof result.error === "string" ? result.error : code;
    throw new Error(`${code}:${message}`);
  }
  const permit = result.permit as Partial<GeoProviderQueueProjection>;
  if (
    (permit.state !== "acquired" && permit.state !== "queued") ||
    typeof permit.requestId !== "string" ||
    typeof permit.concurrencyLimit !== "number" ||
    typeof permit.activeCount !== "number"
  ) {
    throw new Error("geo_provider_permit_projection_invalid");
  }
  return {
    state: permit.state,
    requestId: permit.requestId,
    permitToken:
      typeof permit.permitToken === "string" ? permit.permitToken : null,
    queueReason:
      typeof permit.queueReason === "string" ? permit.queueReason : null,
    queuePosition:
      typeof permit.queuePosition === "number" ? permit.queuePosition : null,
    concurrencyLimit: permit.concurrencyLimit,
    activeCount: permit.activeCount,
  };
}

export class GeoProviderAdmission {
  private readonly post: ManagementPost;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly nextRequestId: () => string;
  private readonly onQueue?: (projection: GeoProviderQueueProjection) => void;

  constructor(
    private readonly identity: GeoProviderAdmissionIdentity,
    dependencies: GeoProviderAdmissionDependencies = {},
  ) {
    this.post = dependencies.post ?? managementApi;
    this.sleep = dependencies.sleep ?? defaultSleep;
    this.nextRequestId = dependencies.requestId ?? randomUUID;
    this.onQueue = dependencies.onQueue;
  }

  async run<T>(input: {
    slot: string;
    unitKind: string;
    unitId?: string;
    signal?: AbortSignal;
    work: () => Promise<T>;
  }): Promise<T> {
    const requestId = this.nextRequestId();
    const envelope = (payload: Record<string, unknown>) => ({
      ...this.identity,
      payload,
    });
    let projection: GeoProviderQueueProjection | undefined;
    let acquired = false;
    try {
      projection = requireProjection(
        await this.post(
          "/api/geo-provider-permits/acquire",
          "POST",
          envelope({
            requestId,
            slot: input.slot,
            unitKind: input.unitKind,
            unitId: input.unitId ?? requestId,
          }),
          { parentSignal: input.signal },
        ),
      );
      while (projection.state === "queued") {
        this.onQueue?.(projection);
        await this.sleep(POLL_INTERVAL_MS, input.signal);
        projection = requireProjection(
          await this.post(
            "/api/geo-provider-permits/status",
            "POST",
            envelope({ requestId }),
            { parentSignal: input.signal },
          ),
        );
      }
      if (!projection.permitToken) {
        throw new Error("geo_provider_permit_token_missing");
      }
      acquired = true;
      return await input.work();
    } catch (error) {
      if (!acquired) {
        await this.post(
          "/api/geo-provider-permits/cancel",
          "POST",
          envelope({ requestId }),
        ).catch(() => undefined);
      }
      throw error;
    } finally {
      if (acquired && projection?.permitToken) {
        await this.post(
          "/api/geo-provider-permits/release",
          "POST",
          envelope({ permitToken: projection.permitToken }),
        ).catch(() => undefined);
      }
    }
  }
}

let admissionIdentity: GeoProviderAdmissionIdentity | undefined;

export function configureGeoProviderAdmission(input: {
  workspacePath?: string;
  sessionId: string;
}): void {
  const sidecarId = process.env.XIAOJING_SIDECAR_ID?.trim();
  admissionIdentity =
    input.workspacePath && sidecarId
      ? {
          workspaceId: basename(resolve(input.workspacePath)),
          sessionId: input.sessionId,
          sidecarId,
        }
      : undefined;
}

function currentAdmission(): GeoProviderAdmission {
  if (!admissionIdentity) {
    throw new Error("geo_provider_admission_identity_unavailable");
  }
  return new GeoProviderAdmission(admissionIdentity);
}

function textCapability(capability: GeoTextCapability): GeoTextCapability {
  return {
    slot: capability.slot,
    complete(messages, options) {
      return currentAdmission().run({
        slot: capability.slot,
        unitKind: "provider-request",
        signal: options?.signal,
        work: () => capability.complete(messages, options),
      });
    },
  };
}

function keywordCapability(
  capability: GeoKeywordSearchCapability,
): GeoKeywordSearchCapability {
  const wrapped: GeoKeywordSearchCapability = {
    slot: capability.slot,
    baselineEngines: () => capability.baselineEngines(),
    search(prompt, options) {
      return currentAdmission().run({
        slot: capability.slot,
        unitKind: "search",
        signal: options?.signal,
        work: () => capability.search(prompt, options),
      });
    },
    probeQuestion(engineId, question, options) {
      return currentAdmission().run({
        slot: capability.slot,
        unitKind: "probe",
        signal: options?.signal,
        work: () => capability.probeQuestion(engineId, question, options),
      });
    },
  };
  // 结构化召回与挖词同槽计量：旧能力注入未实现 searchSources 时保持缺省，
  // 调用方（材料导入竞品腿）继续走回落路径。
  const searchSources = capability.searchSources;
  if (typeof searchSources === "function") {
    wrapped.searchSources = (query, options) =>
      currentAdmission().run({
        slot: capability.slot,
        unitKind: "search-sources",
        signal: options?.signal,
        work: () => searchSources.call(capability, query, options),
      });
  }
  return wrapped;
}

function embeddingCapability(
  capability: GeoEmbeddingCapability,
): GeoEmbeddingCapability {
  return {
    slot: capability.slot,
    dimensions: capability.dimensions,
    concurrency: capability.concurrency,
    async embed(texts, options) {
      const results: number[][] = new Array(texts.length);
      let nextIndex = 0;
      const worker = async () => {
        for (;;) {
          const index = nextIndex++;
          if (index >= texts.length) return;
          const vectors = await currentAdmission().run({
            slot: capability.slot,
            unitKind: "embedding-item",
            signal: options?.signal,
            work: () => capability.embed([texts[index]], options),
          });
          const vector = vectors[0];
          if (!vector) throw new Error("geo_embedding_result_missing");
          results[index] = vector;
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(capability.concurrency, texts.length) },
          () => worker(),
        ),
      );
      return results;
    },
  };
}

function objectStorageCapability(
  capability: GeoObjectStorageCapability,
): GeoObjectStorageCapability {
  return {
    slot: capability.slot,
    putHtml(objectKey, html) {
      return currentAdmission().run({
        slot: capability.slot,
        unitKind: "publish-item",
        work: () => capability.putHtml(objectKey, html),
      });
    },
    putImage(input) {
      // 配图对象与 HTML 同属发布出口计费面（票 #15）：每张图片一个
      // publish-item 计量单元。
      return currentAdmission().run({
        slot: capability.slot,
        unitKind: "publish-item",
        work: () => capability.putImage(input),
      });
    },
  };
}

function distributionCapability(
  capability: GeoDistributionCapability,
): GeoDistributionCapability {
  return {
    slot: capability.slot,
    listResources(kind, page, size) {
      return currentAdmission().run({
        slot: capability.slot,
        unitKind: "distribution-page",
        work: () => capability.listResources(kind, page, size),
      });
    },
    // 订单面（票 08）：计费权威在网关（下单预扣冻结、状态机结转/退点），
    // 不走 Sidecar 的按单位 admission 计量，直通代理端点。
    placeOrder(kind, order) {
      return capability.placeOrder(kind, order);
    },
    queryOrders(kind, sns) {
      return capability.queryOrders(kind, sns);
    },
    urgeOrder(kind, sn) {
      return capability.urgeOrder(kind, sn);
    },
    cancelOrder(kind, sn, reason) {
      return capability.cancelOrder(kind, sn, reason);
    },
    applyRefund(kind, sn, reason) {
      return capability.applyRefund(kind, sn, reason);
    },
    applyRepublish(kind, sn) {
      return capability.applyRepublish(kind, sn);
    },
  };
}

export function wrapGeoProviderCapabilities(
  capabilities: GeoProviderCapabilities,
): GeoProviderCapabilities {
  return {
    extraction: textCapability(capabilities.extraction),
    keywordSearch: keywordCapability(capabilities.keywordSearch),
    generation: textCapability(capabilities.generation),
    reflection: textCapability(capabilities.reflection),
    embedding: embeddingCapability(capabilities.embedding),
    objectStorage: objectStorageCapability(capabilities.objectStorage),
    distribution: distributionCapability(capabilities.distribution),
  };
}

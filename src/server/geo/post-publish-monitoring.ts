import {
  analyzeGeoProbeAnswer,
  parseGeoProbeProviderResponse,
  type GeoBaselineEngineId,
  type GeoBaselineProviderSnapshot,
} from "../../shared/geo/baseline";
import {
  parseExplicitTopThreeRank,
  type PostPublishBaselineEvidence,
} from "../../shared/geo/postPublishMonitoring";
import { randomUUID } from "node:crypto";
import type { GeoBillingPermitChannel } from "./billing-permit";
import type { GeoKeywordSearchCapability } from "./provider-capabilities";
import { fetch as undiciFetch, type Dispatcher } from "undici";
import {
  buildSsrfGuardedDispatcher,
  isUrlSchemeSafe,
} from "../utils/ssrf";
import { withAbortSignal } from "../utils/cancellation";

/**
 * 监测巡检单问价（点）：余额预检阈值。与服务端价目表
 * `backend/src/domain/pricing.ts` 的 monitoring_patrol.perUnit 对齐，由
 * 集成测试做对照断言（网关侧 permit 申请不带价目，服务端定价权威不变）。
 */
export const MONITORING_PATROL_UNIT_POINTS = 5;

export interface PublishedPageAccessDependencies {
  fetch?: (
    url: string,
    init: RequestInit & { dispatcher?: Dispatcher },
  ) => Promise<Response>;
  dispatcherFor?: (url: URL) => Promise<Dispatcher | undefined>;
}

export interface PublishedPageAccessResult {
  url: string;
  httpStatus: number;
  accessible: true;
}

export async function checkPublishedPageAccess(
  rawUrl: string,
  deps: PublishedPageAccessDependencies = {},
): Promise<PublishedPageAccessResult> {
  const fetchImpl =
    deps.fetch ??
    (undiciFetch as unknown as PublishedPageAccessDependencies["fetch"]);
  const dispatcherFor = deps.dispatcherFor ?? buildSsrfGuardedDispatcher;
  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    throw new Error("published_page_url_rejected");
  }
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const safety = isUrlSchemeSafe(current);
    if (!safety.ok || current.username || current.password) {
      throw new Error(
        redirects === 0
          ? "published_page_url_rejected"
          : "published_page_redirect_rejected",
      );
    }
    const dispatcher = await dispatcherFor(current).catch(() => {
      throw new Error(
        redirects === 0
          ? "published_page_url_rejected"
          : "published_page_redirect_rejected",
      );
    });
    try {
      const response = await withAbortSignal(
        undefined,
        (signal) =>
          fetchImpl!(current.toString(), {
            method: "GET",
            redirect: "manual",
            signal,
            headers: { Accept: "text/html,application/xhtml+xml,text/plain", Range: "bytes=0-0" },
            ...(dispatcher ? { dispatcher } : {}),
          }),
        { timeoutMs: 20_000 },
      );
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        if (redirects === 3) throw new Error("published_page_redirect_rejected");
        const location = response.headers.get("location");
        if (!location) throw new Error("published_page_redirect_rejected");
        try {
          current = new URL(location, current);
        } catch {
          throw new Error("published_page_redirect_rejected");
        }
        continue;
      }
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) throw new Error(`published_page_http_${response.status}`);
      return { url: current.toString(), httpStatus: response.status, accessible: true };
    } finally {
      if (dispatcher) await dispatcher.close().catch(() => undefined);
    }
  }
  throw new Error("published_page_redirect_rejected");
}

export interface PostPublishBaselineProbeInput {
  engineId: GeoBaselineEngineId;
  questionId: string;
  question: string;
  sourceProviderSnapshot: GeoBaselineProviderSnapshot;
  brandNames: string[];
  /** 冻结基线的已确认竞品名单（v1 基线缺省为无竞品判定）。 */
  competitorNames?: string[];
  publishedArticles: Array<{ articleId: string; url: string }>;
}

export interface PostPublishBaselineProbeResult {
  evidence: PostPublishBaselineEvidence;
  providerSnapshot: GeoBaselineProviderSnapshot;
}

function normalizedUrl(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/**
 * 监测巡检的单问探测错误：余额低于单次巡检所需时的类型化终止（票 07）。
 * Rust wake executor 侧按非重试失败处理本轮，不发起 Provider 调用、不扣点；
 * 充值后下一轮巡检自然恢复。
 */
export class PostPublishInsufficientBalanceError extends Error {
  constructor(
    readonly required: number,
    readonly available: number,
  ) {
    super(
      `insufficient_balance:点数不足：监测巡检需 ${required} 点，当前可用 ${available} 点，请充值后自动恢复。`,
    );
    this.name = "PostPublishInsufficientBalanceError";
  }
}

export class PostPublishBaselineProbeService {
  constructor(
    private readonly provider: GeoKeywordSearchCapability,
    /**
     * 网关计费（票 07）：监测巡检 5 点/问/次。缺省（开发直连模式）时跳过
     * 余额预检与 permit，保持纯探测语义。
     */
    private readonly billing?: Pick<
      GeoBillingPermitChannel,
      "apply" | "reportUnit" | "balance"
    >,
    private readonly nextPermitId: () => string = randomUUID,
  ) {}

  async probe(
    input: PostPublishBaselineProbeInput,
  ): Promise<PostPublishBaselineProbeResult> {
    const engine = this.provider
      .baselineEngines()
      .find((candidate) => candidate.id === input.engineId);
    if (!engine?.available) {
      throw new Error("post_publish_monitor_provider_unavailable");
    }
    // 余额预检（票 07 监测欠费暂停）：可用余额低于单问巡检价时以类型化错误
    // 终止本轮该问——不申请 permit、不发起探测，Rust 侧按非重试失败收尾，
    // 下一轮 wake 重新预检，充值后自动恢复。
    const permit = await this.beginPermit();
    try {
      const response = await this.provider.probeQuestion(
        input.engineId,
        input.question,
      );
      const result = this.buildResult(input, response);
      await this.settlePermit(permit, "success");
      return result;
    } catch (error) {
      await this.settlePermit(permit, "failure");
      throw error;
    }
  }

  /** 申请单问巡检 permit；余额不足抛 PostPublishInsufficientBalanceError。 */
  private async beginPermit(): Promise<string | null> {
    if (!this.billing) return null;
    const balance = await this.billing.balance();
    const required = MONITORING_PATROL_UNIT_POINTS;
    if (balance.available < required) {
      throw new PostPublishInsufficientBalanceError(required, balance.available);
    }
    const permitId = `monitor:${this.nextPermitId()}`;
    await this.billing.apply({
      permitId,
      operation: "monitoring_patrol",
      units: 1,
    });
    return permitId;
  }

  private async settlePermit(
    permitId: string | null,
    outcome: "success" | "failure",
  ): Promise<void> {
    if (!this.billing || !permitId) return;
    await this.billing.reportUnit(permitId, 0, outcome).catch(() => undefined);
  }

  private buildResult(
    input: PostPublishBaselineProbeInput,
    response: Awaited<ReturnType<GeoKeywordSearchCapability["probeQuestion"]>>,
  ): PostPublishBaselineProbeResult {
    const parsed = parseGeoProbeProviderResponse(response.rawEvidence);
    const analysis = analyzeGeoProbeAnswer(
      parsed.answer,
      input.brandNames,
      parsed.citations,
      input.competitorNames,
    );
    const articleByUrl = new Map(
      input.publishedArticles
        .map((article) => [normalizedUrl(article.url), article.articleId] as const)
        .filter((entry): entry is [string, string] => entry[0] !== null),
    );
    const citedUrls = [
      ...new Set(
        parsed.citations
          .map((citation) => normalizedUrl(citation.url))
          .filter((url): url is string => url !== null),
      ),
    ].sort();
    const citedArticleIds = [
      ...new Set(
        citedUrls
          .map((url) => articleByUrl.get(url))
          .filter((id): id is string => id !== undefined),
      ),
    ].sort();
    return {
      providerSnapshot: response.snapshot,
      evidence: {
        questionId: input.questionId,
        engineId: input.engineId,
        rawAnswer: parsed.answer,
        rawEvidence: response.rawEvidence,
        sourceProviderSnapshot: input.sourceProviderSnapshot,
        providerSnapshot: response.snapshot,
        citations: parsed.citations,
        analysis,
        rankPosition: parseExplicitTopThreeRank(parsed.answer, input.brandNames),
        citedArticleIds,
        citedUrls,
      },
    };
  }
}

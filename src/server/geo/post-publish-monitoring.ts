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
import type { GeoKeywordSearchCapability } from "./provider-capabilities";
import { fetch as undiciFetch, type Dispatcher } from "undici";
import {
  buildSsrfGuardedDispatcher,
  isUrlSchemeSafe,
} from "../utils/ssrf";
import { withAbortSignal } from "../utils/cancellation";

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

export class PostPublishBaselineProbeService {
  constructor(private readonly provider: GeoKeywordSearchCapability) {}

  async probe(
    input: PostPublishBaselineProbeInput,
  ): Promise<PostPublishBaselineProbeResult> {
    const engine = this.provider
      .baselineEngines()
      .find((candidate) => candidate.id === input.engineId);
    if (!engine?.available) {
      throw new Error("post_publish_monitor_provider_unavailable");
    }
    const response = await this.provider.probeQuestion(
      input.engineId,
      input.question,
    );
    const parsed = parseGeoProbeProviderResponse(response.rawEvidence);
    const analysis = analyzeGeoProbeAnswer(
      parsed.answer,
      input.brandNames,
      parsed.citations,
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

import { createHmac } from "node:crypto";

import {
  XIAOJING_GEO_PROVIDER_DEFAULTS,
  type GeoProviderCapabilitySlot,
} from "../../shared/geo/providerCapabilities";
import {
  GEO_BASELINE_POLICY_VERSION,
  type GeoBaselineEngineAvailability,
  type GeoBaselineEngineId,
  type GeoBaselineProviderSnapshot,
} from "../../shared/geo/baseline";

export interface GeoProviderRuntimeSecrets {
  deepseekApiKey?: string;
  arkApiKey?: string;
  doubaoSearchApiKey?: string;
  arkConfigurationFingerprint?: string;
  embeddingApiKey?: string;
  embeddingEndpointId?: string;
  ossAccessKeyId?: string;
  ossAccessKeySecret?: string;
  ossBucket?: string;
  ossRegion?: string;
  ossPublicBaseUrl?: string;
  distributionAppId?: string;
  distributionSecret?: string;
  distributionBaseUrl?: string;
  /**
   * 非密钥端点覆盖（运营网关切流预留）：缺省回落共享层固定默认值。
   * ark/doubao 由 captureGeoProviderRuntimeSecrets 捕获；deepseek 属
   * XIAOJING_DEEPSEEK_* 命名空间，由 provider-runtime 合并自
   * xiaojing-native-secret 的捕获。
   */
  deepseekOpenAiBaseUrl?: string;
  arkPaygoBaseUrl?: string;
  doubaoSearchBaseUrl?: string;
}

export interface GeoTextMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GeoTextCapability {
  readonly slot: "extraction" | "generation" | "reflection";
  complete(
    messages: readonly GeoTextMessage[],
    options?: {
      signal?: AbortSignal;
      /** Title planning keeps the js_ai dev pinned mini route without adding a ninth slot. */
      purpose?: "title-planning";
      maxTokens?: number;
      temperature?: number;
      topP?: number;
    },
  ): Promise<string>;
}

/** 豆包搜索结构化召回的单条结果（js_ai doubaoSearchProbe 契约的子集）。 */
export interface GeoKeywordSearchSource {
  title: string;
  url: string;
  summary?: string;
}

export interface GeoKeywordSearchCapability {
  readonly slot: "keyword-search";
  search(
    prompt: string,
    options?: {
      signal?: AbortSignal;
      /** 挖词 system persona（ADR-0006 调用形态统一；缺省保持单 user 消息）。 */
      system?: string;
      maxTokens?: number;
    },
  ): Promise<string>;
  /**
   * 结构化检索（豆包搜索 API）：纯搜索引擎的逐条 Title/Summary/Url 召回，
   * 不经 LLM 改写。供需要「搜索引擎真实召回语料」的消费方（竞品富化）；
   * 未实现（旧能力注入）时调用方回落 search() 的 enable_search 生成语料。
   */
  searchSources?(
    query: string,
    options?: { signal?: AbortSignal; count?: number },
  ): Promise<GeoKeywordSearchSource[]>;
  baselineEngines(): readonly GeoBaselineEngineAvailability[];
  probeQuestion(
    engineId: GeoBaselineEngineId,
    question: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ rawEvidence: unknown; snapshot: GeoBaselineProviderSnapshot }>;
}

export interface GeoEmbeddingCapability {
  readonly slot: "embedding";
  readonly dimensions: number;
  readonly concurrency: number;
  embed(
    texts: readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<number[][]>;
}

export interface GeoObjectStorageCapability {
  readonly slot: "object-storage";
  putHtml(objectKey: string, html: string): Promise<{ url: string }>;
}

export interface GeoDistributionResource {
  id: number;
  name: string;
  status?: number;
  price?: string | number | null;
  published_rate?: number | null;
  entrance_link?: string | null;
  remark?: string | null;
  channel_type?: number | null;
  industry_category?: number | null;
  area?: number | null;
  can_weekend?: boolean | null;
  publish_speed?: number | null;
  published_avg?: number | null;
  platform?: number | null;
  [key: string]: unknown;
}

export interface GeoDistributionCapability {
  readonly slot: "distribution";
  /** Read-only resource discovery. Paid order submission belongs to PublishScheduler. */
  listResources(
    kind: "media" | "we-media",
    page?: number,
    size?: number,
  ): Promise<{ total: number; items: GeoDistributionResource[] }>;
}

export interface GeoProviderCapabilities {
  extraction: GeoTextCapability;
  keywordSearch: GeoKeywordSearchCapability;
  generation: GeoTextCapability;
  reflection: GeoTextCapability;
  embedding: GeoEmbeddingCapability;
  objectStorage: GeoObjectStorageCapability;
  distribution: GeoDistributionCapability;
}

export interface GeoProviderCapabilityDependencies {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

const secretTransportEnvNames = [
  "XIAOJING_ARK_API_KEY",
  "XIAOJING_DOUBAO_SEARCH_API_KEY",
  "XIAOJING_ARK_EMBEDDING_API_KEY",
  "XIAOJING_OSS_ACCESS_KEY_ID",
  "XIAOJING_OSS_ACCESS_KEY_SECRET",
  "XIAOJING_DISTRIBUTION_APP_ID",
  "XIAOJING_DISTRIBUTION_SECRET",
] as const;

/**
 * Capture the one-shot Rust→Sidecar secret transport, then erase it before any
 * generic subprocess, environment diagnostic, or Agent tool can inherit it.
 */
export function captureGeoProviderRuntimeSecrets(
  env: NodeJS.ProcessEnv = process.env,
): GeoProviderRuntimeSecrets {
  const read = (name: string) => env[name]?.trim() || undefined;
  const secrets: GeoProviderRuntimeSecrets = {
    arkApiKey: read("XIAOJING_ARK_API_KEY"),
    doubaoSearchApiKey: read("XIAOJING_DOUBAO_SEARCH_API_KEY"),
    arkConfigurationFingerprint: read("XIAOJING_ARK_CONFIGURATION_FINGERPRINT"),
    embeddingApiKey: read("XIAOJING_ARK_EMBEDDING_API_KEY"),
    embeddingEndpointId: read("XIAOJING_ARK_EMBEDDING_ENDPOINT_ID"),
    ossAccessKeyId: read("XIAOJING_OSS_ACCESS_KEY_ID"),
    ossAccessKeySecret: read("XIAOJING_OSS_ACCESS_KEY_SECRET"),
    ossBucket: read("XIAOJING_OSS_BUCKET"),
    ossRegion: read("XIAOJING_OSS_REGION"),
    ossPublicBaseUrl: read("XIAOJING_OSS_PUBLIC_BASE_URL"),
    distributionAppId: read("XIAOJING_DISTRIBUTION_APP_ID"),
    distributionSecret: read("XIAOJING_DISTRIBUTION_SECRET"),
    distributionBaseUrl: read("XIAOJING_DISTRIBUTION_BASE_URL"),
    arkPaygoBaseUrl: read("XIAOJING_ARK_PAYGO_BASE_URL"),
    doubaoSearchBaseUrl: read("XIAOJING_DOUBAO_SEARCH_BASE_URL"),
  };
  for (const name of [
    ...secretTransportEnvNames,
    "XIAOJING_ARK_EMBEDDING_ENDPOINT_ID",
    "XIAOJING_ARK_CONFIGURATION_FINGERPRINT",
    "XIAOJING_OSS_BUCKET",
    "XIAOJING_OSS_REGION",
    "XIAOJING_OSS_PUBLIC_BASE_URL",
    "XIAOJING_DISTRIBUTION_BASE_URL",
    "XIAOJING_ARK_PAYGO_BASE_URL",
    "XIAOJING_DOUBAO_SEARCH_BASE_URL",
  ]) {
    delete env[name];
  }
  return secrets;
}

export function sanitizeGeoProviderError(
  error: unknown,
  secrets: GeoProviderRuntimeSecrets,
): Error {
  let message = error instanceof Error ? error.message : String(error);
  for (const value of Object.values(secrets)) {
    if (typeof value === "string" && value.length > 0)
      message = message.split(value).join("[REDACTED]");
  }
  message = message
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(
      /(api[_-]?key|access[_-]?key|secret|signature)(\s*[=:]\s*)[^\s,;&]+/gi,
      "$1$2[REDACTED]",
    );
  return new Error(message.slice(0, 500));
}

function required(
  value: string | undefined,
  slot: GeoProviderCapabilitySlot,
): string {
  if (!value) throw new Error(`${slot} 能力尚未配置`);
  return value;
}

function safeUpstreamFailure(
  slot: GeoProviderCapabilitySlot,
  status: number,
): Error {
  if (status === 429) return new Error(`${slot} 服务限流（HTTP 429）`);
  if (status === 401 || status === 403)
    return new Error(`${slot} 凭据无效或无权访问`);
  return new Error(`${slot} 上游请求失败（HTTP ${status}）`);
}

async function openAiChat(
  fetchImpl: typeof fetch,
  slot: "extraction" | "generation" | "reflection",
  endpoint: string,
  apiKey: string,
  model: string,
  messages: readonly GeoTextMessage[],
  options?: {
    signal?: AbortSignal;
    maxTokens?: number;
    temperature?: number;
    topP?: number;
  },
): Promise<string> {
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      ...(options?.maxTokens !== undefined
        ? { max_tokens: options.maxTokens }
        : {}),
      ...(options?.temperature !== undefined
        ? { temperature: options.temperature }
        : {}),
      ...(options?.topP !== undefined ? { top_p: options.topP } : {}),
    }),
    signal: options?.signal,
  });
  if (!response.ok) throw safeUpstreamFailure(slot, response.status);
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new Error(`${slot} 返回了无效响应`);
  }
  return content;
}

function encodeObjectKey(objectKey: string): string {
  const cleaned = objectKey.replace(/^\/+/, "");
  if (!cleaned || cleaned.split("/").some((segment) => segment === "..")) {
    throw new Error("object-storage objectKey 无效");
  }
  return cleaned.split("/").map(encodeURIComponent).join("/");
}

function flattenDistributionParams(
  params: Record<string, string | number>,
): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("");
}

export function createGeoProviderCapabilities(
  secrets: GeoProviderRuntimeSecrets,
  deps: GeoProviderCapabilityDependencies = {},
): GeoProviderCapabilities {
  const fetchImpl = deps.fetch ?? fetch;
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => new Date());
  // 端点覆盖（Rust admission 一次性注入）：缺省逐字节回落固定默认值，
  // 注入时只替换 host 根，路径与 wire shape 不变，业务层零感知。
  const endpointRoot = (override: string | undefined, fallback: string) =>
    (override || fallback).replace(/\/+$/, "");
  const deepseekOpenAiBaseUrl = endpointRoot(
    secrets.deepseekOpenAiBaseUrl,
    XIAOJING_GEO_PROVIDER_DEFAULTS.deepseekOpenAiBaseUrl,
  );
  const arkPaygoBaseUrl = endpointRoot(
    secrets.arkPaygoBaseUrl,
    XIAOJING_GEO_PROVIDER_DEFAULTS.arkPaygoBaseUrl,
  );
  const doubaoSearchBaseUrl = endpointRoot(
    secrets.doubaoSearchBaseUrl,
    XIAOJING_GEO_PROVIDER_DEFAULTS.doubaoSearchBaseUrl,
  );
  const deepseekEndpoint = `${deepseekOpenAiBaseUrl}/chat/completions`;
  const arkEndpoint = `${arkPaygoBaseUrl}/chat/completions`;
  const arkResponsesEndpoint = `${arkPaygoBaseUrl}/responses`;
  const arkEmbeddingEndpoint = `${arkPaygoBaseUrl}/embeddings/multimodal`;
  const doubaoBaselineSnapshot: GeoBaselineProviderSnapshot = {
    engineId: "doubao",
    provider: "volcengine",
    capabilitySlot: "keyword-search",
    model: XIAOJING_GEO_PROVIDER_DEFAULTS.keywordSearchModel,
    endpointFamily: "ark-responses",
    searchMode: "doubao-app-ai-search",
    configurationFingerprint:
      secrets.arkConfigurationFingerprint ?? "development-config-unversioned",
    policyVersion: GEO_BASELINE_POLICY_VERSION,
  };

  const textCapability = (
    slot: "extraction" | "generation" | "reflection",
    endpoint: string,
    apiKey: () => string,
    model: string,
  ): GeoTextCapability => ({
    slot,
    async complete(messages, options) {
      try {
        return await openAiChat(
          fetchImpl,
          slot,
          endpoint,
          apiKey(),
          slot === "generation" && options?.purpose === "title-planning"
            ? XIAOJING_GEO_PROVIDER_DEFAULTS.titlePlanningModel
            : model,
          messages,
          options,
        );
      } catch (error) {
        throw sanitizeGeoProviderError(error, secrets);
      }
    },
  });

  return {
    extraction: textCapability(
      "extraction",
      deepseekEndpoint,
      () => required(secrets.deepseekApiKey, "extraction"),
      XIAOJING_GEO_PROVIDER_DEFAULTS.extractionModel,
    ),
    keywordSearch: {
      slot: "keyword-search",
      baselineEngines() {
        const available = Boolean(secrets.arkApiKey);
        return [
          {
            id: "doubao",
            label: "豆包 AI 搜索",
            available,
            ...(!available
              ? { unavailableReason: "豆包 / ARK Provider 尚未配置" }
              : {}),
            snapshot: doubaoBaselineSnapshot,
          },
        ];
      },
      async search(prompt, options) {
        try {
          const response = await fetchImpl(arkEndpoint, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${required(secrets.arkApiKey, "keyword-search")}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: XIAOJING_GEO_PROVIDER_DEFAULTS.keywordSearchModel,
              messages: options?.system
                ? [
                    { role: "system", content: options.system },
                    { role: "user", content: prompt },
                  ]
                : [{ role: "user", content: prompt }],
              stream: false,
              enable_search: true,
              ...(options?.maxTokens !== undefined
                ? { max_tokens: options.maxTokens }
                : {}),
            }),
            signal: options?.signal,
          });
          if (!response.ok)
            throw safeUpstreamFailure("keyword-search", response.status);
          const payload = (await response.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          const content = payload.choices?.[0]?.message?.content;
          if (typeof content !== "string")
            throw new Error("keyword-search 返回了无效响应");
          return content;
        } catch (error) {
          throw sanitizeGeoProviderError(error, secrets);
        }
      },
      async searchSources(query, options) {
        // 豆包搜索 HTTP API（js_ai doubaoSearchProbe 契约）：纯搜索引擎的
        // 结构化 Title/Summary/Url 召回，不经 LLM 改写。Bearer 解析链：专用
        // 豆包搜索 key（联网搜索控制台签发，月度免费额度）→ 复用 ARK key
        // （volcengine 主 key / Agent Plan key 兼容豆包搜索计费面）；key 不被
        // 接受时由调用方回落 search() 的 enable_search 生成语料。
        try {
          const response = await fetchImpl(
            `${doubaoSearchBaseUrl}/search_api/web_search`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${required(
                  secrets.doubaoSearchApiKey ?? secrets.arkApiKey,
                  "keyword-search",
                )}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                Query: query,
                Count: options?.count ?? 20,
                SearchType: "web",
                NeedSummary: true,
              }),
              signal: options?.signal,
            },
          );
          if (!response.ok)
            throw safeUpstreamFailure("keyword-search", response.status);
          const payload = (await response.json()) as {
            Result?: {
              WebResults?: Array<{
                Title?: string;
                SiteName?: string;
                Url?: string;
                Summary?: string;
                Snippet?: string;
              }>;
            };
            error?: { message?: string };
          };
          if (payload.error) throw new Error("keyword-search 返回了无效响应");
          const seen = new Set<string>();
          const sources: GeoKeywordSearchSource[] = [];
          for (const result of payload.Result?.WebResults ?? []) {
            const url = (result.Url ?? "").trim();
            if (!url || seen.has(url)) continue;
            seen.add(url);
            const summary = (result.Summary ?? "").trim()
              || (result.Snippet ?? "").trim();
            sources.push({
              title: (result.Title ?? "").trim()
                || (result.SiteName ?? "").trim()
                || url,
              url,
              ...(summary ? { summary } : {}),
            });
          }
          return sources;
        } catch (error) {
          throw sanitizeGeoProviderError(error, secrets);
        }
      },
      async probeQuestion(engineId, question, options) {
        if (engineId !== "doubao") {
          throw new Error(`geo_baseline_engine_unsupported:${engineId}`);
        }
        if (!question.trim()) throw new Error("geo_baseline_question_required");
        try {
          const response = await fetchImpl(arkResponsesEndpoint, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${required(secrets.arkApiKey, "keyword-search")}`,
              "Content-Type": "application/json",
              "ark-beta-doubao-app": "true",
            },
            body: JSON.stringify({
              model: doubaoBaselineSnapshot.model,
              input: [{ role: "user", content: question.trim() }],
              stream: false,
              tools: [
                {
                  type: "doubao_app",
                  feature: { ai_search: { type: "enabled" } },
                },
              ],
            }),
            signal: options?.signal,
          });
          if (!response.ok)
            throw safeUpstreamFailure("keyword-search", response.status);
          return {
            rawEvidence: (await response.json()) as unknown,
            snapshot: doubaoBaselineSnapshot,
          };
        } catch (error) {
          throw sanitizeGeoProviderError(error, secrets);
        }
      },
    },
    generation: textCapability(
      "generation",
      arkEndpoint,
      () => required(secrets.arkApiKey, "generation"),
      XIAOJING_GEO_PROVIDER_DEFAULTS.generationModel,
    ),
    reflection: textCapability(
      "reflection",
      deepseekEndpoint,
      () => required(secrets.deepseekApiKey, "reflection"),
      XIAOJING_GEO_PROVIDER_DEFAULTS.reflectionModel,
    ),
    embedding: {
      slot: "embedding",
      dimensions: XIAOJING_GEO_PROVIDER_DEFAULTS.embeddingDimensions,
      concurrency: XIAOJING_GEO_PROVIDER_DEFAULTS.embeddingConcurrency,
      async embed(texts, options) {
        const results: number[][] = new Array(texts.length);
        let nextIndex = 0;
        const apiKey = required(
          secrets.embeddingApiKey ?? secrets.arkApiKey,
          "embedding",
        );
        const model = required(secrets.embeddingEndpointId, "embedding");
        const worker = async () => {
          for (;;) {
            const index = nextIndex++;
            if (index >= texts.length) return;
            let lastError: unknown;
            for (
              let attempt = 0;
              attempt <= XIAOJING_GEO_PROVIDER_DEFAULTS.embeddingMaxRetries;
              attempt++
            ) {
              try {
                const response = await fetchImpl(arkEmbeddingEndpoint, {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    model,
                    input: [{ type: "text", text: texts[index] }],
                  }),
                  signal: options?.signal,
                });
                if (!response.ok)
                  throw safeUpstreamFailure("embedding", response.status);
                const payload = (await response.json()) as {
                  data?: { embedding?: number[] };
                };
                const vector = payload.data?.embedding;
                if (
                  !Array.isArray(vector) ||
                  vector.length !==
                    XIAOJING_GEO_PROVIDER_DEFAULTS.embeddingDimensions
                ) {
                  throw new Error("embedding 返回向量维度无效");
                }
                results[index] = vector;
                lastError = undefined;
                break;
              } catch (error) {
                lastError = error;
                if (options?.signal?.aborted) throw error;
                if (
                  attempt < XIAOJING_GEO_PROVIDER_DEFAULTS.embeddingMaxRetries
                ) {
                  await sleep(500 * 2 ** attempt);
                }
              }
            }
            if (lastError) throw sanitizeGeoProviderError(lastError, secrets);
          }
        };
        await Promise.all(
          Array.from(
            {
              length: Math.min(
                XIAOJING_GEO_PROVIDER_DEFAULTS.embeddingConcurrency,
                texts.length,
              ),
            },
            worker,
          ),
        );
        return results;
      },
    },
    objectStorage: {
      slot: "object-storage",
      async putHtml(objectKey, html) {
        try {
          const accessKeyId = required(
            secrets.ossAccessKeyId,
            "object-storage",
          );
          const accessKeySecret = required(
            secrets.ossAccessKeySecret,
            "object-storage",
          );
          const bucket = required(secrets.ossBucket, "object-storage");
          const region =
            secrets.ossRegion ||
            XIAOJING_GEO_PROVIDER_DEFAULTS.ossDefaultRegion;
          const encodedKey = encodeObjectKey(objectKey);
          const date = now().toUTCString();
          const contentType = "text/html; charset=utf-8";
          const stringToSign = [
            "PUT",
            "",
            contentType,
            date,
            `/${bucket}/${objectKey.replace(/^\/+/, "")}`,
          ].join("\n");
          const signature = createHmac("sha1", accessKeySecret)
            .update(stringToSign)
            .digest("base64");
          const upstreamUrl = `https://${bucket}.${region}.aliyuncs.com/${encodedKey}`;
          const response = await fetchImpl(upstreamUrl, {
            method: "PUT",
            headers: {
              Authorization: `OSS ${accessKeyId}:${signature}`,
              "Content-Type": contentType,
              Date: date,
            },
            body: html,
          });
          if (!response.ok)
            throw safeUpstreamFailure("object-storage", response.status);
          const publicBase = secrets.ossPublicBaseUrl?.replace(/\/+$/, "");
          return {
            url: publicBase ? `${publicBase}/${encodedKey}` : upstreamUrl,
          };
        } catch (error) {
          throw sanitizeGeoProviderError(error, secrets);
        }
      },
    },
    distribution: {
      slot: "distribution",
      async listResources(kind, page = 1, size = 20) {
        try {
          const appid = required(secrets.distributionAppId, "distribution");
          const secret = required(secrets.distributionSecret, "distribution");
          const baseUrl = (
            secrets.distributionBaseUrl ||
            XIAOJING_GEO_PROVIDER_DEFAULTS.distributionBaseUrl
          ).replace(/\/+$/, "");
          const params: Record<string, string | number> = {
            appid,
            timestamp: Math.floor(now().getTime() / 1000),
            algorithm: "sha256",
            page,
            size,
          };
          const signature = createHmac("sha256", secret)
            .update(flattenDistributionParams(params))
            .digest("hex");
          const query = new URLSearchParams({
            ...Object.fromEntries(
              Object.entries(params).map(([key, value]) => [
                key,
                String(value),
              ]),
            ),
            signature,
          });
          const path =
            kind === "media" ? "/media/resource" : "/we-media/resource";
          const response = await fetchImpl(`${baseUrl}${path}?${query}`, {
            headers: { Accept: "application/json" },
          });
          if (!response.ok)
            throw safeUpstreamFailure("distribution", response.status);
          const envelope = (await response.json()) as {
            code?: number;
            message?: string;
            data?: { total?: number; items?: GeoDistributionResource[] };
          };
          if (
            envelope.code !== 200 ||
            !envelope.data ||
            !Array.isArray(envelope.data.items)
          ) {
            throw new Error(
              `distribution 返回业务错误（code ${envelope.code ?? "unknown"}）`,
            );
          }
          return {
            total: envelope.data.total ?? envelope.data.items.length,
            items: envelope.data.items,
          };
        } catch (error) {
          throw sanitizeGeoProviderError(error, secrets);
        }
      },
    },
  };
}

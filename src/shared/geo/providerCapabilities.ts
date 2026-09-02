/**
 * Fixed provider capability surface for Xiaojing GEO.
 *
 * This is a product policy, not a model marketplace. GEO code consumes the
 * slot interfaces exported by the server module; UI code may only project the
 * non-secret catalog/status fields below.
 */

import { XIAOJING_MAIN_AGENT } from "../xiaojing-main-agent-policy";

export const GEO_PROVIDER_CAPABILITY_SLOTS = [
  "main-agent",
  "extraction",
  "keyword-search",
  "generation",
  "reflection",
  "embedding",
  "object-storage",
  "distribution",
] as const;

export type GeoProviderCapabilitySlot =
  (typeof GEO_PROVIDER_CAPABILITY_SLOTS)[number];

export type GeoProviderCapabilityState =
  | "unconfigured"
  | "verifying"
  | "available"
  | "rate_limited"
  | "failed";

export type GeoProviderServiceId =
  | "deepseek"
  | "ark"
  | "embedding"
  | "object-storage"
  | "distribution";

export interface GeoProviderCapabilityStatus {
  slot: GeoProviderCapabilitySlot;
  state: GeoProviderCapabilityState;
  source: "windows-credential-manager" | "development-env" | "missing";
  /** Safe, user-facing diagnostic. It must never include request bodies or credentials. */
  detail?: string;
}

export interface GeoProviderCapabilitySpec {
  slot: GeoProviderCapabilitySlot;
  label: string;
  serviceId: GeoProviderServiceId;
  provider: "DeepSeek" | "豆包 / ARK" | "阿里云 OSS" | "超级媒介";
  model?: string;
  endpoint: string;
  semantics: Readonly<Record<string, string | number | boolean>>;
}

export const XIAOJING_GEO_PROVIDER_DEFAULTS = {
  deepseekAnthropicBaseUrl: "https://api.deepseek.com/anthropic",
  deepseekOpenAiBaseUrl: "https://api.deepseek.com",
  arkPaygoBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  mainAgentModel: "deepseek-v4-pro",
  extractionModel: "deepseek-chat",
  keywordSearchModel: "doubao-seed-2-0-lite-260428",
  // Title planning rides the same lite tier as keyword search; the mini
  // variant (doubao-seed-2-0-mini-260428) is not provisioned on paygo
  // accounts and answers HTTP 404 on /chat/completions.
  titlePlanningModel: "doubao-seed-2-0-lite-260428",
  generationModel: "doubao-seed-2-0-pro-260215",
  reflectionModel: "deepseek-v4-pro",
  embeddingDimensions: 2048,
  embeddingConcurrency: 2,
  embeddingMaxRetries: 2,
  doubaoSearchBaseUrl: "https://open.feedcoopapi.com",
  distributionBaseUrl: "https://vip.chaojimeijie.com/api",
  distributionCacheTtlMs: 30 * 60 * 1000,
  ossDefaultRegion: "oss-cn-beijing",
} as const;

export const GEO_PROVIDER_CAPABILITY_CATALOG: readonly GeoProviderCapabilitySpec[] =
  [
    {
      slot: "main-agent",
      label: "主 Agent",
      serviceId: "deepseek",
      provider: "DeepSeek",
      model: XIAOJING_GEO_PROVIDER_DEFAULTS.mainAgentModel,
      endpoint: `${XIAOJING_GEO_PROVIDER_DEFAULTS.deepseekAnthropicBaseUrl}/v1/messages`,
      // 展示值直接引用策略表：主 Agent 的推理强度只允许一个来源（生效值
      // 同表），目录不得再写第二个字面量（曾漂移为 high vs medium）。
      semantics: {
        protocol: "anthropic",
        reasoningEffort: XIAOJING_MAIN_AGENT.reasoningEffort,
      },
    },
    {
      slot: "extraction",
      label: "品牌信息抽取",
      serviceId: "deepseek",
      provider: "DeepSeek",
      model: XIAOJING_GEO_PROVIDER_DEFAULTS.extractionModel,
      endpoint: `${XIAOJING_GEO_PROVIDER_DEFAULTS.deepseekOpenAiBaseUrl}/chat/completions`,
      semantics: { protocol: "openai-chat", reasoning: false },
    },
    {
      slot: "keyword-search",
      label: "关键词联网搜索",
      serviceId: "ark",
      provider: "豆包 / ARK",
      model: XIAOJING_GEO_PROVIDER_DEFAULTS.keywordSearchModel,
      endpoint: `${XIAOJING_GEO_PROVIDER_DEFAULTS.arkPaygoBaseUrl}/chat/completions`,
      semantics: {
        protocol: "openai-chat",
        enable_search: true,
        billingSurface: "paygo",
        // 竞品富化 searchSources 的第二条 wire route；与主端点一样可被
        // admission 注入的端点覆盖替换（运营网关计量面），目录只钉默认值。
        searchSourcesEndpoint: `${XIAOJING_GEO_PROVIDER_DEFAULTS.doubaoSearchBaseUrl}/search_api/web_search`,
      },
    },
    {
      slot: "generation",
      label: "内容生成",
      serviceId: "ark",
      provider: "豆包 / ARK",
      model: XIAOJING_GEO_PROVIDER_DEFAULTS.generationModel,
      endpoint: `${XIAOJING_GEO_PROVIDER_DEFAULTS.arkPaygoBaseUrl}/chat/completions`,
      semantics: {
        protocol: "openai-chat",
        billingSurface: "paygo",
        titlePlanningModel: XIAOJING_GEO_PROVIDER_DEFAULTS.titlePlanningModel,
      },
    },
    {
      slot: "reflection",
      label: "反思与审校",
      serviceId: "deepseek",
      provider: "DeepSeek",
      model: XIAOJING_GEO_PROVIDER_DEFAULTS.reflectionModel,
      endpoint: `${XIAOJING_GEO_PROVIDER_DEFAULTS.deepseekOpenAiBaseUrl}/chat/completions`,
      semantics: { protocol: "openai-chat", reasoningEffort: "high" },
    },
    {
      slot: "embedding",
      label: "知识向量化",
      serviceId: "embedding",
      provider: "豆包 / ARK",
      endpoint: `${XIAOJING_GEO_PROVIDER_DEFAULTS.arkPaygoBaseUrl}/embeddings/multimodal`,
      semantics: {
        model: "doubao-embedding-vision endpoint id",
        dimensions: XIAOJING_GEO_PROVIDER_DEFAULTS.embeddingDimensions,
        concurrency: XIAOJING_GEO_PROVIDER_DEFAULTS.embeddingConcurrency,
        maxRetries: XIAOJING_GEO_PROVIDER_DEFAULTS.embeddingMaxRetries,
        singleTextPerRequest: true,
      },
    },
    {
      slot: "object-storage",
      label: "文章对象存储",
      serviceId: "object-storage",
      provider: "阿里云 OSS",
      endpoint: "https://{bucket}.{region}.aliyuncs.com/{objectKey}",
      semantics: {
        method: "PUT",
        signature: "OSS-v1-HMAC-SHA1",
        contentType: "text/html; charset=utf-8",
      },
    },
    {
      slot: "distribution",
      label: "渠道与分发",
      serviceId: "distribution",
      provider: "超级媒介",
      endpoint: XIAOJING_GEO_PROVIDER_DEFAULTS.distributionBaseUrl,
      semantics: {
        signature: "HMAC-SHA256",
        postEncoding: "application/x-www-form-urlencoded",
        resourceCacheTtlMs:
          XIAOJING_GEO_PROVIDER_DEFAULTS.distributionCacheTtlMs,
      },
    },
  ] as const;

export function geoProviderCapabilitySpec(
  slot: GeoProviderCapabilitySlot,
): GeoProviderCapabilitySpec {
  const spec = GEO_PROVIDER_CAPABILITY_CATALOG.find(
    (candidate) => candidate.slot === slot,
  );
  if (!spec) throw new Error(`Unknown Xiaojing GEO capability slot: ${slot}`);
  return spec;
}

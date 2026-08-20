/**
 * embedding 瞬时失败时的确定性降级向量——如实移植自 js_ai
 * `core/geo/knowledge/chunkSearch.ts` 的 buildFallbackVector（GEOFlow 蓝本）：
 * CJK 2/3/4-gram + 拉丁 token 词频，经 32-bit FNV-1a 散列到定维向量并
 * L2 归一化。纯函数：同输入恒同输出，可单测。
 *
 * 降级语义（用户裁决的折中）：仅瞬时失败（网络错误/超时、408、429、5xx，
 * 见 provider-capabilities.isTransientGeoUpstreamFailure）允许回落此向量让
 * 流程继续，且必须 WARN 日志 + 结果降级标记保证可观测；配置类失败
 * （其余 4xx、能力未配置）不得走此路径，必须显式失败。
 */

import {
  isTransientGeoUpstreamFailure,
  type GeoEmbeddingCapability,
} from "./provider-capabilities";

/** CJK 段切重叠 2/3/4-gram；短段（≤8 字）同时保留整段。返回去重 token。 */
function cjkTokens(text: string): string[] {
  const length = [...text].length; // codepoint-aware
  if (length <= 1) return [];

  const tokens = new Set<string>();
  if (length <= 8) {
    tokens.add(text);
  }
  for (const size of [2, 3, 4]) {
    if (length < size) continue;
    for (let offset = 0; offset <= length - size; offset++) {
      tokens.add([...text].slice(offset, offset + size).join(""));
    }
  }
  return [...tokens];
}

/**
 * 词频统计：CJK（Han）块经 cjkTokens 展开为 n-gram；拉丁 token
 * （`[a-z0-9_]+`，长度 > 1）原样保留。
 */
function termFrequencies(text: string): Record<string, number> {
  const lowered = text.toLowerCase().trim();
  if (!lowered) return {};

  const freqs: Record<string, number> = {};
  const re = /[a-z0-9_]+|[\p{Script=Han}]+/gu;
  for (const match of lowered.matchAll(re)) {
    const token = match[0];
    if (!token) continue;

    if (/^[\p{Script=Han}]+$/u.test(token)) {
      for (const cjk of cjkTokens(token)) {
        freqs[cjk] = (freqs[cjk] ?? 0) + 1;
      }
    } else if ([...token].length > 1) {
      freqs[token] = (freqs[token] ?? 0) + 1;
    }
  }
  return freqs;
}

/** 32-bit FNV-1a，降级向量的确定性散列种子。 */
function hashToken(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0; // unsigned 32-bit
}

export const EMBEDDING_FALLBACK_DIMENSIONS = 2048;

/**
 * 由文本经词频散列构建确定性降级向量，返回指定维度的单位（L2 归一化）
 * 向量；空文本返回全零向量。
 */
export function buildFallbackVector(
  text: string,
  dimensions: number = EMBEDDING_FALLBACK_DIMENSIONS,
): number[] {
  const dim = Math.max(1, dimensions);
  const vector = new Array<number>(dim).fill(0.0);
  const freqs = termFrequencies(text);

  for (const [token, count] of Object.entries(freqs)) {
    const indexSeed = hashToken(`i:${token}`);
    const signSeed = hashToken(`s:${token}`);
    const idx = indexSeed % dim;
    const sign = signSeed % 2 === 0 ? 1.0 : -1.0;
    const tokenLen = Math.max(1, [...token].length);
    const weight =
      (1.0 + Math.log(1 + count)) * Math.min(2.0, 0.8 + tokenLen / 4);
    vector[idx] += sign * weight;
  }

  // L2-normalize.
  let norm = 0.0;
  for (const v of vector) norm += v * v;
  if (norm > 0.0) {
    const inv = 1.0 / Math.sqrt(norm);
    for (let i = 0; i < dim; i++) vector[i] *= inv;
  }
  return vector;
}

/**
 * embedding 调用的降级包装：成功原样返回；瞬时失败回落确定性降级向量并
 * WARN 日志（可观测），`degraded=true` 交给消费方打结果标记；配置类失败
 * 与 abort 原样抛出（显式失败）。
 */
export async function embedWithDegradation(
  embedding: GeoEmbeddingCapability,
  texts: readonly string[],
  options?: { signal?: AbortSignal; logTag?: string },
): Promise<{ vectors: number[][]; degraded: boolean }> {
  try {
    return {
      vectors: await embedding.embed(texts, { signal: options?.signal }),
      degraded: false,
    };
  } catch (error) {
    if (options?.signal?.aborted) throw error;
    if (!isTransientGeoUpstreamFailure(error)) throw error;
    console.warn(
      `${options?.logTag ?? "[geo]"} embedding 瞬时失败，回落确定性降级向量：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {
      vectors: texts.map((text) =>
        buildFallbackVector(text, embedding.dimensions),
      ),
      degraded: true,
    };
  }
}

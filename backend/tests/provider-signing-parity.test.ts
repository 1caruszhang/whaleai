import { describe, expect, it } from 'vitest';
import {
  encodeOssObjectKey,
  flattenSupermediaParams,
  ossPutStringToSign,
  signOssPutAuthorization,
  signSupermediaQuery,
  supermediaHmacSha256,
} from '../src/gateway/provider-signing';

/**
 * 签名移植对照测试（票 05 验收第 2、3 条）。
 *
 * 黄金向量不是手推的：生成时真实运行了 Sidecar 现有 Node 实现
 * `src/server/geo/provider-capabilities.ts`（只读参照基准），用 mock fetch +
 * 固定时钟捕获其对同样输入产出的完整 wire 产物（OSS 的 Authorization/Date/
 * URL 与超级媒介的完整 query），再逐字面量固化到这里。
 *
 * 取舍说明：backend 与桌面应用是相互隔离的包（独立 package.json / tsconfig /
 * 测试，README「互不进入对方的构建产物」），测试期跨包 import sidecar 会让
 * backend 的 typecheck 依赖根仓库文件，破坏构建边界——票面允许的替代方案即
 * 「固定测试向量对照」。向量生成脚本（一次性，已删除）的核心片段：
 *
 *   const caps = createGeoProviderCapabilities({
 *     arkApiKey: 'test-ark-key-vector',
 *     ossAccessKeyId: 'test-oss-ak-vector',
 *     ossAccessKeySecret: 'test-oss-sk-vector',
 *     ossBucket: 'test-bucket-vector',
 *     ossRegion: 'oss-cn-chengdu',
 *     distributionAppId: 'test-appid-vector',
 *     distributionSecret: 'test-distribution-secret-vector',
 *   }, { fetch: mockFetch, now: () => new Date(FIXED_UTC_STRING) });
 *   await caps.objectStorage.putHtml('articles/2026/标题 demo+plus.html', '<html><body>hello</body></html>');
 *   await caps.distribution.listResources('media', 2, 15);
 *
 * Sidecar 签名实现后续若改动，需重新跑 sidecar 实现刷新本文件向量。
 */

const FIXED_UTC_STRING = 'Wed, 19 Aug 2026 05:29:00 GMT';
const FIXED_TIMESTAMP_SECONDS = 1_787_117_340; // 10 位 unix 秒

const OSS_AK = 'test-oss-ak-vector';
const OSS_SK = 'test-oss-sk-vector';
const OSS_BUCKET = 'test-bucket-vector';
const OBJECT_KEY_RAW = 'articles/2026/标题 demo+plus.html';
const OBJECT_KEY_ENCODED = 'articles/2026/%E6%A0%87%E9%A2%98%20demo%2Bplus.html';

const DISTRIBUTION_APPID = 'test-appid-vector';
const DISTRIBUTION_SECRET = 'test-distribution-secret-vector';

// ── Sidecar 捕获产物（黄金向量，勿手改）───────────────────────────────
const SIDECAR_OSS_AUTHORIZATION = 'OSS test-oss-ak-vector:8pWPElZjBVmXTLcCevjHg+n4cO0=';
const SIDECAR_DISTRIBUTION_QUERY =
  'appid=test-appid-vector&timestamp=1787117340&algorithm=sha256&page=2&size=15' +
  '&signature=14d7f4907e5cb8b469f97bc7857919b1610237dd3aa78c8d5a39e317789bc775';
const SIDECAR_DISTRIBUTION_SIGNATURE = '14d7f4907e5cb8b469f97bc7857919b1610237dd3aa78c8d5a39e317789bc775';

describe('OSS V1 HMAC-SHA1 signing parity with the sidecar implementation', () => {
  it('builds the exact sidecar string-to-sign and Authorization for the same input', () => {
    // string-to-sign：VERB / Content-MD5(空) / Content-Type / Date / /bucket/key（raw key，Host 不参与）。
    const stringToSign = ossPutStringToSign({
      bucket: OSS_BUCKET,
      objectKey: OBJECT_KEY_RAW,
      contentType: 'text/html; charset=utf-8',
      date: FIXED_UTC_STRING,
    });
    expect(stringToSign).toBe(
      `PUT\n\ntext/html; charset=utf-8\n${FIXED_UTC_STRING}\n/${OSS_BUCKET}/${OBJECT_KEY_RAW}`,
    );
    // 与 sidecar 真跑捕获的 Authorization 逐字节一致。
    expect(signOssPutAuthorization(OSS_AK, OSS_SK, stringToSign)).toBe(SIDECAR_OSS_AUTHORIZATION);
  });

  it('keeps the signature stable when only the host changes to the internal endpoint', () => {
    // V1 签名串不含 Host：同一 AK/SK/bucket/key/date 换内网 endpoint 重签结果不变，
    // 这是网关可用内网 endpoint 替客户端重签的算法前提。
    const stringToSign = ossPutStringToSign({
      bucket: OSS_BUCKET,
      objectKey: OBJECT_KEY_RAW,
      contentType: 'text/html; charset=utf-8',
      date: FIXED_UTC_STRING,
    });
    expect(signOssPutAuthorization(OSS_AK, OSS_SK, stringToSign)).toBe(SIDECAR_OSS_AUTHORIZATION);
  });

  it('encodes the object key exactly like the sidecar (per-segment, + and space escaped)', () => {
    // 锁定向量里的 URL path 形态，防止编码口径漂移。
    expect(encodeOssObjectKey(OBJECT_KEY_RAW)).toBe(OBJECT_KEY_ENCODED);
    expect(encodeOssObjectKey(`/${OBJECT_KEY_RAW}`)).toBe(OBJECT_KEY_ENCODED);
  });
});

describe('supermedia flattened HMAC-SHA256 signing parity with the sidecar implementation', () => {
  it('flattens params by ascending key into a bare key=value concatenation', () => {
    // params 字面量刻意用 sidecar 的插入序（appid,timestamp,algorithm,page,size）：
    // 展平必须按 key 排序，与插入序无关。
    expect(
      flattenSupermediaParams({
        appid: DISTRIBUTION_APPID,
        timestamp: FIXED_TIMESTAMP_SECONDS,
        algorithm: 'sha256',
        page: 2,
        size: 15,
      }),
    ).toBe(
      `algorithm=sha256appid=${DISTRIBUTION_APPID}page=2size=15timestamp=${FIXED_TIMESTAMP_SECONDS}`,
    );
  });

  it('produces the exact sidecar signature hex for the same flattened input', () => {
    const flattened = flattenSupermediaParams({
      appid: DISTRIBUTION_APPID,
      timestamp: FIXED_TIMESTAMP_SECONDS,
      algorithm: 'sha256',
      page: 2,
      size: 15,
    });
    expect(supermediaHmacSha256(DISTRIBUTION_SECRET, flattened)).toBe(SIDECAR_DISTRIBUTION_SIGNATURE);
  });

  it('builds the byte-identical query string the sidecar sends (signature excluded from flattening)', () => {
    const query = signSupermediaQuery(DISTRIBUTION_APPID, DISTRIBUTION_SECRET, FIXED_TIMESTAMP_SECONDS, {
      page: 2,
      size: 15,
    });
    expect(query.toString()).toBe(SIDECAR_DISTRIBUTION_QUERY);
  });
});

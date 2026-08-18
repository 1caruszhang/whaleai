import { createHmac } from 'node:crypto';
import { AppError } from '../errors';

/**
 * 网关侧 Provider 签名重签（票 05）。逐字节移植自 Sidecar 现有 Node 实现
 * `src/server/geo/provider-capabilities.ts`（只读参照基准，本票不改 sidecar），
 * 一致性由 `tests/provider-signing-parity.test.ts` 的 sidecar 黄金向量对照
 * 测试锁定：
 *
 * - OSS V1 header 签名：StringToSign = `PUT\n\n{contentType}\n{date}\n/{bucket}/{key}`，
 *   HMAC-SHA1 → base64 → `Authorization: OSS {ak}:{signature}`。Host 不参与
 *   签名，因此网关把请求改投同地域内网 endpoint 时签名不变——这正是
 *   「私钥仅在服务器」重签的算法前提。
 * - 超级媒介展平签名：参数按 key 升序拼 `key=value` 裸串（signature 自身
 *   不参与），HMAC-SHA256 hex。公共参数 `timestamp` 为 10 位 unix 秒且由
 *   网关时钟现取（上游校验 5 分钟时效，网关侧永远新鲜，不接收客户端传入）。
 *
 * 上游密钥（OSS AK/SK、超级媒介 secret）只经环境变量进入本模块调用方，
 * 本模块纯函数、不触网络、不落日志。
 */

/** OSS putHtml 的固定 Content-Type（与 sidecar 一致）。 */
export const OSS_HTML_CONTENT_TYPE = 'text/html; charset=utf-8';

/**
 * objectKey 规范化编码（与 sidecar encodeObjectKey 同步）：去前导斜杠、
 * 逐段 encodeURIComponent、拒绝空键与 `..` 段（路径逃逸）。返回 null 表示
 * 键非法（路由层回 400），不在这里抛错以保持纯函数可测。
 */
export function encodeOssObjectKey(objectKey: string): string | null {
  const cleaned = objectKey.replace(/^\/+/, '');
  if (!cleaned || cleaned.split('/').some(segment => segment === '..')) return null;
  return cleaned.split('/').map(encodeURIComponent).join('/');
}

/** OSS V1 PUT 的 StringToSign（raw objectKey 参与，非 URL 编码形态）。 */
export function ossPutStringToSign(input: {
  bucket: string;
  objectKey: string;
  contentType: string;
  date: string;
}): string {
  return [
    'PUT',
    '',
    input.contentType,
    input.date,
    `/${input.bucket}/${input.objectKey.replace(/^\/+/, '')}`,
  ].join('\n');
}

/** StringToSign → `OSS {accessKeyId}:{base64(HMAC-SHA1)}`。 */
export function signOssPutAuthorization(
  accessKeyId: string,
  accessKeySecret: string,
  stringToSign: string,
): string {
  const signature = createHmac('sha1', accessKeySecret).update(stringToSign).digest('base64');
  return `OSS ${accessKeyId}:${signature}`;
}

/** OSS 上游 URL：`https://{bucket}.{host}/{encodedKey}`（host 为完整内网域名）。 */
export function ossUpstreamUrl(bucket: string, host: string, encodedObjectKey: string): string {
  return `https://${bucket}.${host}/${encodedObjectKey}`;
}

/** 超级媒介参数展平：key 升序的 `key=value` 裸连接（无分隔符），与 sidecar 同。 */
export function flattenSupermediaParams(params: Record<string, string | number>): string {
  return Object.keys(params)
    .sort()
    .map(key => `${key}=${params[key]}`)
    .join('');
}

/** 展平串 → HMAC-SHA256 hex。 */
export function supermediaHmacSha256(secret: string, flattened: string): string {
  return createHmac('sha256', secret).update(flattened).digest('hex');
}

/**
 * 组装超级媒介签名 query：公共参数（appid/timestamp/algorithm）+ 业务参数 +
 * signature。query 的插入序与 sidecar 完全一致（appid,timestamp,algorithm,
 * 业务参数,signature），保证 wire 字节一致；signature 只对排序后的展平串计算。
 */
export function signSupermediaQuery(
  appid: string,
  secret: string,
  timestampSeconds: number,
  businessParams: Record<string, string | number>,
): URLSearchParams {
  const params: Record<string, string | number> = {
    appid,
    timestamp: timestampSeconds,
    algorithm: 'sha256',
    ...businessParams,
  };
  const signature = supermediaHmacSha256(secret, flattenSupermediaParams(params));
  return new URLSearchParams({
    ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])),
    signature,
  });
}

/** 路由层用：objectKey 非法（空/`..` 逃逸）的统一错误。 */
export function invalidObjectKeyError(): AppError {
  return new AppError('invalid_object_key', 'objectKey 无效。', 400);
}

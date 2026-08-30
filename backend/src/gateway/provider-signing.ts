import { createHmac, timingSafeEqual } from 'node:crypto';
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
 * 图片对象公共读 ACL（票 #15，ADR-0008 D4）：文章页需匿名加载，图片
 * 对象一律 public-read；ACL 头必须计入 CanonicalizedOSSHeaders 参与签名。
 */
export const OSS_PUBLIC_READ_ACL = 'public-read';
export const OSS_OBJECT_ACL_HEADER = 'x-oss-object-acl';

/** 图片对象放行的 Content-Type 白名单（与 sidecar putImage 同口径）。 */
export const OSS_IMAGE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

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

/**
 * OSS V1 PUT 的 StringToSign（raw objectKey 参与，非 URL 编码形态）。
 * `canonicalizedHeaders`（票 #15）：CanonicalizedOSSHeaders 段——小写
 * `name:value`、按头名排序、整体以 \n 结尾插在 Date 与资源之间（如
 * `x-oss-object-acl:public-read`）。缺省时空段，输出与票 05 的 HTML
 * 黄金向量逐字节一致（parity 测试锁定）。
 */
export function ossPutStringToSign(input: {
  bucket: string;
  objectKey: string;
  contentType: string;
  date: string;
  canonicalizedHeaders?: ReadonlyArray<string>;
}): string {
  const canonicalized = (input.canonicalizedHeaders ?? [])
    .map(header => header.trim().toLowerCase())
    .sort()
    .join('\n');
  return [
    'PUT',
    '',
    input.contentType,
    input.date,
    ...(canonicalized ? [canonicalized] : []),
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

/**
 * 超级媒介参数展平（票 08 深层形态，逐语义移植自官方 PHP flatten）：
 * - 字典：键名升序，`key=展平(值)` 逐段裸连接（signature 键跳过）；
 * - 列表：元素升序排序后逐元素展平裸连接（无 key= 前缀）；
 * - 标量：字符串原样 / 数字十进制。
 * 嵌套字典（如事件回调的 payload）逐层递归展平——请求签名与回调验签共用
 * 同一展平语义。约束：标量只允许 string | number（PHP 布尔/空值的字符串化
 * 语义不在本网关的任何参数面出现）。
 */
export type SupermediaSignValue =
  | string
  | number
  | SupermediaSignValue[]
  | { [key: string]: SupermediaSignValue };

export function flattenSupermediaParamsDeep(value: SupermediaSignValue): string {
  if (Array.isArray(value)) {
    return value
      .map(item => flattenSupermediaParamsDeep(item))
      .sort()
      .join('');
  }
  if (typeof value === 'object' && value !== null) {
    return Object.keys(value)
      .filter(key => key !== 'signature')
      .sort()
      .map(key => `${key}=${flattenSupermediaParamsDeep((value as Record<string, SupermediaSignValue>)[key])}`)
      .join('');
  }
  return String(value);
}

/** 超级媒介参数展平：key 升序的 `key=value` 裸连接（无分隔符），与 sidecar 同。 */
export function flattenSupermediaParams(params: Record<string, string | number>): string {
  return flattenSupermediaParamsDeep(params);
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

/**
 * 列表参数版签名 query（票 08）：订单/资源查询的 `sn` / `id` 为列表参数，
 * wire 形态用 PHP 惯例 `key[]=v1&key[]=v2`（上游为 PHP 服务，$_GET 解析
 * 列表的标准形态）；签名按展平语义对「元素升序后裸连接」计算（列表无
 * key= 前缀）。标量参数与 signSupermediaQuery 完全同构。
 */
export function signSupermediaQueryWithLists(
  appid: string,
  secret: string,
  timestampSeconds: number,
  businessParams: Record<string, string | number | readonly string[]>,
): URLSearchParams {
  const signParams: Record<string, SupermediaSignValue> = {
    appid,
    timestamp: timestampSeconds,
    algorithm: 'sha256',
    ...businessParams,
  };
  const signature = supermediaHmacSha256(secret, flattenSupermediaParamsDeep(signParams));
  const query = new URLSearchParams();
  query.set('appid', appid);
  query.set('timestamp', String(timestampSeconds));
  query.set('algorithm', 'sha256');
  for (const [key, value] of Object.entries(businessParams)) {
    if (Array.isArray(value)) {
      for (const item of value) query.append(`${key}[]`, String(item));
    } else {
      query.set(key, String(value));
    }
  }
  query.set('signature', signature);
  return query;
}

/** 回调/请求验签失败原因（票 08 事件回调）：路由层据此映射 4xx。 */
export type SupermediaVerifyFailure =
  | 'bad_appid'
  | 'bad_algorithm'
  | 'stale_timestamp'
  | 'bad_signature';

/**
 * 验证超级媒介回调参数（票 08）：appid 匹配本代理商、algorithm 仅支持
 * sha256（本网关只按它计算）、timestamp 在 tolerance（上游声明 5 分钟）
 * 内、HMAC-SHA256 签名逐字节相等（timingSafeEqual）。参数对象即回调
 * 正文（含 event/payload 业务字段与公共参数），signature 键不参与展平。
 */
export function verifySupermediaSignature(input: {
  secret: string;
  expectedAppId: string;
  nowSeconds: number;
  toleranceSeconds: number;
  params: Record<string, unknown>;
}): SupermediaVerifyFailure | null {
  const { params } = input;
  const appid = typeof params.appid === 'string' ? params.appid : '';
  if (appid !== input.expectedAppId) return 'bad_appid';
  if (params.algorithm !== undefined && params.algorithm !== 'sha256') return 'bad_algorithm';
  const timestamp = typeof params.timestamp === 'number' ? params.timestamp : Number.parseInt(String(params.timestamp), 10);
  if (!Number.isInteger(timestamp) || Math.abs(input.nowSeconds - timestamp) > input.toleranceSeconds) {
    return 'stale_timestamp';
  }
  const signature = typeof params.signature === 'string' ? params.signature : '';
  if (!/^[0-9a-f]{64}$/i.test(signature)) return 'bad_signature';
  const expected = supermediaHmacSha256(input.secret, flattenSupermediaParamsDeep(params as Record<string, SupermediaSignValue>));
  const expectedBytes = Buffer.from(expected, 'utf8');
  const actualBytes = Buffer.from(signature.toLowerCase(), 'utf8');
  if (expectedBytes.length !== actualBytes.length || !timingSafeEqual(expectedBytes, actualBytes)) {
    return 'bad_signature';
  }
  return null;
}

/** 路由层用：objectKey 非法（空/`..` 逃逸）的统一错误。 */
export function invalidObjectKeyError(): AppError {
  return new AppError('invalid_object_key', 'objectKey 无效。', 400);
}

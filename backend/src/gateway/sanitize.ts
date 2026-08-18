/**
 * 上游错误响应清洗（票 04 红线：账号 token 与上游密钥不进任何日志或错误
 * 响应）。上游可能把请求头里的密钥回显进错误体（鉴权失败提示、代理诊断页），
 * 状态码照常透传，正文先抹掉全部敏感串，再尽量保形回传；洗不干净（非 JSON）
 * 就换成通用错误体——宁可丢细节，不泄密钥。
 */

/** 错误体读取上限：错误页不该有海量字节，防御异常上游。 */
const MAX_ERROR_BODY_CHARS = 64 * 1024;

export function redactSecrets(text: string, secrets: readonly string[]): string {
  let redacted = text.length > MAX_ERROR_BODY_CHARS ? text.slice(0, MAX_ERROR_BODY_CHARS) : text;
  for (const secret of secrets) {
    if (secret.length > 0) redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted;
}

/**
 * 清洗后的上游错误体 → 可回传 JSON 字符串。原本就是 JSON 的保形回传
 * （仅敏感串替换为 [REDACTED]）；非 JSON 的整体换成 Anthropic 风格通用错误。
 */
export function sanitizedUpstreamErrorBody(raw: string, secrets: readonly string[]): string {
  const redacted = redactSecrets(raw, secrets);
  try {
    const parsed: unknown = JSON.parse(redacted);
    if (typeof parsed === 'object' && parsed !== null) return JSON.stringify(parsed);
  } catch {
    // 非 JSON，走通用兜底。
  }
  return JSON.stringify({
    type: 'error',
    error: { type: 'upstream_error', message: '上游服务返回错误，详情已省略。' },
  });
}

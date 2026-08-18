/**
 * 领域层抛给 HTTP 层的唯一错误形态：code 进响应体供客户端分支，
 * status 是 HTTP 状态码。可选 details 平铺进响应体（如余额不足时携带
 * required/available），不出现在 message 文案里重复。未知异常一律 500
 * internal_error。
 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Record<string, number | string>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

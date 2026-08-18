/**
 * 领域层抛给 HTTP 层的唯一错误形态：code 进响应体供客户端分支，
 * status 是 HTTP 状态码。未知异常一律 500 internal_error。
 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

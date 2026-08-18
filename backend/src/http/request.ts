import type { z } from 'zod';
import { AppError } from '../errors';

/** JSON body + zod 校验的统一入口：坏 JSON 与未过 schema 都映射为 400。 */
export async function parseJsonBody<T>(
  c: { req: { json(): Promise<unknown> } },
  schema: z.ZodType<T>,
): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AppError('invalid_json', '请求体必须是合法 JSON。', 400);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new AppError('validation_error', detail, 400);
  }
  return parsed.data;
}

/** 从 Authorization 头取 Bearer token；缺失/异形返回空串由调用方报 401。 */
export function readBearerToken(header: string | undefined): string {
  if (!header?.startsWith('Bearer ')) return '';
  return header.slice('Bearer '.length).trim();
}

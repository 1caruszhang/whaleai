import { cancellableFetch } from './cancellation';
import { readLoopbackJson } from './loopback-response';

export const ADMIN_LOOPBACK_TIMEOUT_MS = 10_000;

const MGMT_PORT = process.env.XIAOJING_MANAGEMENT_PORT;
const SIDECAR_GENERATION = process.env.XIAOJING_SIDECAR_GENERATION;

export async function managementApi(
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: Record<string, unknown>,
  requestOptions?: { timeoutMs?: number; parentSignal?: AbortSignal },
): Promise<Record<string, unknown>> {
  if (!MGMT_PORT) {
    return {
      ok: false,
      code: 'management_unavailable',
      error: 'Management API not available (app may still be starting)',
      recoveryHint: {
        recoveryCommand: 'xiaojing status',
        message: 'Check whether the app backend is fully up; if not, retry in a few seconds.',
      },
    };
  }
  const url = `http://127.0.0.1:${MGMT_PORT}${path}`;
  const options: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(SIDECAR_GENERATION
        ? { 'X-Xiaojing-Sidecar-Generation': SIDECAR_GENERATION }
        : {}),
    },
  };
  if (body && method === 'POST') {
    options.body = JSON.stringify(body);
  }
  try {
    const resp = await cancellableFetch(url, options, {
      timeoutMs: requestOptions?.timeoutMs ?? ADMIN_LOOPBACK_TIMEOUT_MS,
      parentSignal: requestOptions?.parentSignal,
    });
    return await readLoopbackJson(resp, 'Management API');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: method === 'POST' ? 'transport_outcome_unknown' : 'management_unavailable',
      error: `Management API unreachable: ${msg}`,
      recoveryHint: {
        recoveryCommand: 'xiaojing status',
        message: 'Check backend health; restart the app if the problem persists.',
      },
    };
  }
}

/**
 * Bounded internal data-plane read from the Rust Management API. The request
 * remains a small authenticated JSON envelope; Rust owns the filesystem read
 * and returns app-owned bytes without exposing a local path to Node.
 */
export async function managementApiBytes(
  path: string,
  body: Record<string, unknown>,
  options?: { timeoutMs?: number; maxBytes?: number; parentSignal?: AbortSignal },
): Promise<{ bytes: Uint8Array; contentType: string }> {
  if (!MGMT_PORT) throw new Error('material_management_unavailable');
  const response = await cancellableFetch(
    `http://127.0.0.1:${MGMT_PORT}${path}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(SIDECAR_GENERATION
          ? { 'X-Xiaojing-Sidecar-Generation': SIDECAR_GENERATION }
          : {}),
      },
      body: JSON.stringify(body),
    },
    {
      timeoutMs: options?.timeoutMs ?? ADMIN_LOOPBACK_TIMEOUT_MS,
      parentSignal: options?.parentSignal,
    },
  );
  if (!response.ok) throw new Error('material_content_unavailable');
  const maxBytes = options?.maxBytes ?? 20 * 1024 * 1024;
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error('material_too_large');
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error('material_too_large');
    return {
      bytes,
      contentType: response.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream',
    };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('material_too_large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    bytes,
    contentType: response.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream',
  };
}

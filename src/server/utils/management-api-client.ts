import { cancellableFetch } from './cancellation';
import { readLoopbackJson } from './loopback-response';

export const ADMIN_LOOPBACK_TIMEOUT_MS = 10_000;

const MGMT_PORT = process.env.MYAGENTS_MANAGEMENT_PORT;
const SIDECAR_GENERATION = process.env.MYAGENTS_SIDECAR_GENERATION;

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
        recoveryCommand: 'myagents status',
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
        ? { 'X-MyAgents-Sidecar-Generation': SIDECAR_GENERATION }
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
        recoveryCommand: 'myagents status',
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
          ? { 'X-MyAgents-Sidecar-Generation': SIDECAR_GENERATION }
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

export type ManagedOAuthResolveIntent =
  | { reason: 'request' }
  | { reason: 'auth_recovery'; rejectedCredentialVersion: number }
  | { reason: 'reject'; rejectedCredentialVersion: number }
  | { reason: 'report'; rejectedCredentialVersion: number; httpStatus: number };

export type ManagedOAuthCredential = {
  accessToken: string;
  credentialVersion: number;
};

export type ManagedOAuthPurpose =
  | { purpose: 'execution' }
  | { purpose: 'verification'; expectedLineage: string };

const MANAGED_OAUTH_TIMEOUT_MS = 90_000;

function managementErrorMessage(result: Record<string, unknown>): string {
  const error = result.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string') return message;
  }
  return 'Managed OAuth credential is unavailable';
}

export async function resolveManagedOAuthCredential(
  providerId: string,
  intent: ManagedOAuthResolveIntent,
  parentSignal?: AbortSignal,
  purpose: ManagedOAuthPurpose = { purpose: 'execution' },
): Promise<ManagedOAuthCredential | undefined> {
  if (providerId !== 'xai-sub') {
    throw new Error(`Unsupported managed OAuth provider: ${providerId}`);
  }
  const sidecarId = process.env.MYAGENTS_SIDECAR_ID?.trim();
  if (!sidecarId) {
    throw new Error('Managed OAuth requires a Sidecar process identity');
  }
  const result = await managementApi(
    '/api/grok/bearer',
    'POST',
    {
      sidecarId,
      reason: intent.reason,
      ...purpose,
      ...('rejectedCredentialVersion' in intent
        ? { rejectedCredentialVersion: intent.rejectedCredentialVersion }
        : {}),
      ...('httpStatus' in intent ? { httpStatus: intent.httpStatus } : {}),
    },
    { timeoutMs: MANAGED_OAUTH_TIMEOUT_MS, parentSignal },
  );
  if (result.ok !== true) {
    throw new Error(managementErrorMessage(result));
  }
  if (intent.reason === 'reject' || intent.reason === 'report') return undefined;
  if (typeof result.accessToken !== 'string' || !result.accessToken) {
    throw new Error('Managed OAuth response did not include an access token');
  }
  if (typeof result.credentialVersion !== 'number' || result.credentialVersion <= 0) {
    throw new Error('Managed OAuth response did not include a credential version');
  }
  return {
    accessToken: result.accessToken,
    credentialVersion: result.credentialVersion,
  };
}

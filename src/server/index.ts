import { existsSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { serve as honoServe } from '@hono/node-server';

import {
  isSessionFileReference,
  SESSION_FILE_MAX_MESSAGE_FILES,
} from '../shared/sessionFileReference';
import {
  getAgentState,
  getSessionId,
  handleAskUserQuestionResponse,
  initializeAgent,
  interruptCurrentResponse,
  setSidecarPort,
} from './agent-session';
import {
  buildGateResponseBody,
  buildReadyResponseBody,
  runDeferredInit,
  setDeferredInitPhase,
} from './readiness-state';
import { handleChatStreamRoute } from './routes/chat-stream';
import { handleProxyRefRoute } from './routes/proxy-refs';
import { handleSessionReadRoute } from './routes/session-read';
import { handleXiaojingRoute } from './routes/xiaojing';
import { requestAccountAccessToken } from './routes/xiaojing-shared';
import type { ImagePayload } from './types/image';
import {
  composeSidecarRequestHandler,
  resolveSidecarComposition,
  type SidecarComposition,
} from './sidecar-composition';
import { createSseClient } from './sse';
import { getAttachmentPath } from './SessionStore';
import { initLogger, setStdioBrokenProbe } from './logger';
import { getAppDataDir } from './utils/app-data-dir';
import { fileResponse, sniffMime } from './utils/file-response';
import { serveStatic } from './utils/static-assets';
import { ensureDirSync } from './utils/fs-utils';
import { jsonResponse } from './utils/http';
import { sendXiaojingMessage } from './xiaojing-reminder-send';

function parseArgs(argv: string[]): {
  workspacePath: string;
  initialPrompt?: string;
  port: number;
  sessionId?: string;
  sidecarComposition: SidecarComposition;
} {
  const args = argv.slice(2);
  const value = (flag: string): string | null => {
    const index = args.indexOf(flag);
    return index < 0 ? null : (args[index + 1] ?? null);
  };
  const workspacePath = value('--workspace-dir') ?? '';
  if (!workspacePath) throw new Error('Missing required argument: --workspace-dir <path>');
  const parsedPort = Number(value('--port') ?? 3000);
  return {
    workspacePath,
    initialPrompt: value('--prompt') ?? undefined,
    port: Number.isFinite(parsedPort) ? parsedPort : 3000,
    sessionId: value('--session-id') ?? undefined,
    sidecarComposition: resolveSidecarComposition(),
  };
}

async function ensureWorkspaceDir(path: string): Promise<string> {
  const absolute = resolve(path);
  if (!existsSync(absolute)) await mkdir(absolute, { recursive: true });
  if (!(await stat(absolute)).isDirectory()) {
    throw new Error(`Workspace is not a directory: ${absolute}`);
  }
  return absolute;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const workspacePath = await ensureWorkspaceDir(args.workspacePath);
  setSidecarPort(args.port);
  setStdioBrokenProbe(() => false, () => {});
  initLogger();

  async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-xiaojing-account-token',
        },
      });
    }

    if ((pathname === '/health' || pathname === '/health/live') && request.method === 'GET') {
      return jsonResponse({ status: 'ok', timestamp: Date.now() });
    }
    if ((pathname === '/health/ready' || pathname === '/health/functional') && request.method === 'GET') {
      const ready = buildReadyResponseBody();
      return jsonResponse(ready.body, ready.status);
    }

    const gate = buildGateResponseBody();
    if (gate) return jsonResponse(gate.body, gate.status);

    if (pathname.startsWith('/api/attachment/') && request.method === 'GET') {
      let relativePath: string;
      try {
        relativePath = decodeURIComponent(pathname.slice('/api/attachment/'.length));
      } catch {
        return new Response('Bad Request', { status: 400 });
      }
      if (!relativePath || relativePath.includes('..') || relativePath.startsWith('/')) {
        return new Response('Forbidden', { status: 403 });
      }
      const target = getAttachmentPath(relativePath);
      return await fileResponse(target, {
        contentType: sniffMime(target),
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      }) ?? new Response('Not Found', { status: 404 });
    }

    // Rust 代理 spill 的 ref 数据面（issue #22）：renderer 收到 ref_url 后
    // 跨源原生 fetch 取回 >1MB 响应体；CORS 头是跨源可读的前提。
    const proxyRef = await handleProxyRefRoute(pathname, request);
    if (proxyRef) return proxyRef;

    const sessionRead = await handleSessionReadRoute(pathname, request, url);
    if (sessionRead) return sessionRead;

    const stream = await handleChatStreamRoute(pathname, request, {
      createSseClient,
    });
    if (stream) return stream;

    if (pathname === '/chat/send' && request.method === 'POST') {
      const payload = await request.json().catch(() => null) as {
        text?: string;
        images?: ImagePayload[];
        files?: unknown;
        sessionId?: string;
      } | null;
      const text = payload?.text?.trim() ?? '';
      const images = payload?.images ?? [];
      const sessionFiles = Array.isArray(payload?.files)
        ? payload.files.filter((entry): entry is string => typeof entry === 'string')
        : [];
      if (sessionFiles.length > SESSION_FILE_MAX_MESSAGE_FILES) {
        return jsonResponse({
          success: false,
          error: `A message can attach at most ${SESSION_FILE_MAX_MESSAGE_FILES} files.`,
        }, 400);
      }
      const invalidSessionFile = sessionFiles.find((path) => !isSessionFileReference(path, getSessionId()));
      if (invalidSessionFile) {
        return jsonResponse({ success: false, error: 'invalid_session_file_reference' }, 400);
      }
      if (!text && images.length === 0 && sessionFiles.length === 0) {
        return jsonResponse({ success: false, error: 'Message must have text or attachments.' }, 400);
      }
      if (payload?.sessionId && payload.sessionId !== getSessionId()) {
        return jsonResponse({ success: false, error: 'session_identity_mismatch' }, 409);
      }
      const result = await sendXiaojingMessage({
        text,
        images,
        sessionFiles,
        requestAccountToken: requestAccountAccessToken(request),
      });
      return jsonResponse(result, result.success ? 200 : (result.status ?? 500));
    }

    if (pathname === '/chat/stop' && request.method === 'POST') {
      const stopped = await interruptCurrentResponse();
      return jsonResponse({ success: true, alreadyStopped: !stopped });
    }

    const xiaojingResponse = await handleXiaojingRoute(pathname, request, { workspacePath });
    if (xiaojingResponse) return xiaojingResponse;

    if (pathname === '/api/ask-user-question/respond' && request.method === 'POST') {
      const payload = await request.json().catch(() => null) as {
        requestId?: string;
        answers?: Record<string, string> | null;
      } | null;
      if (!payload?.requestId || !('answers' in payload)) {
        return jsonResponse({ success: false, error: 'invalid_answer_payload' }, 400);
      }
      const success = await handleAskUserQuestionResponse(payload.requestId, payload.answers ?? null);
      return jsonResponse({ success });
    }

    const staticResponse = request.method === 'GET' ? await serveStatic(pathname) : null;
    return staticResponse ?? new Response('Not Found', { status: 404 });
  }

  const dispatch = composeSidecarRequestHandler(args.sidecarComposition, handleRequest);
  honoServe({
    port: args.port,
    hostname: '127.0.0.1',
    fetch: dispatch,
  } as Parameters<typeof honoServe>[0]);

  console.log(`[startup] focused Sidecar listening on 127.0.0.1:${args.port}`);

  let phase = 'startup';
  void runDeferredInit(async () => {
    phase = 'sdk-init';
    setDeferredInitPhase(phase);
    await initializeAgent(workspacePath, args.initialPrompt, args.sessionId);
    console.log(
      `[boot] workspace=${workspacePath} session=${getSessionId()} state=${getAgentState().sessionState}`,
    );
  }, () => phase, (error) => {
    console.error('[startup] focused Sidecar initialization failed:', error);
  });
}

ensureDirSync(getAppDataDir());
void main().catch((error) => {
  console.error('[startup] fatal:', error);
  process.exitCode = 1;
});

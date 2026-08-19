import { randomUUID } from 'node:crypto';

import {
  query,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

import { createLiveUserMessageReplay } from '../shared/chatMessageReplay';
import {
  isSessionFileTextReadable,
  sessionFileReferenceName,
} from '../shared/sessionFileReference';
import { buildSessionFilesReminder } from '../shared/systemReminder';
import {
  XIAOJING_MAIN_AGENT,
  isXiaojingMainAgentTool,
} from '../shared/xiaojing-main-agent-policy';
import {
  appendSessionMessages,
  getSessionMetadata,
  loadSessionTranscript,
  updateSessionMetadata,
  updateSessionTitleFromMessage,
  type TranscriptWriteCursor,
} from './SessionStore';
import { buildAgentQueryOptions } from './agent-query-options';
import { broadcast } from './sse';
import { buildSystemPrompt } from './system-prompt';
import { configureXiaojingGeo, createXiaojingGeoServer, isSessionFileImported } from './tools/xiaojing-geo-tool';
import type { ImagePayload } from './types/image';
import type { SessionMessage } from './types/session';
import {
  messageAttachmentsFromImagePayloads,
  resolveImagePayloads,
} from './utils/image-payload';
import { resolveXiaojingMainAgentAuth } from './xiaojing-native-secret';

type SessionCompletionTerminal = Readonly<{
  sessionId: string;
  workspacePath: string;
  turnId: string;
  status: 'complete' | 'stopped' | 'error';
}>;

type SessionState = 'idle' | 'starting' | 'running' | 'stopping' | 'error';

import { createAssistantTurnProjection, type WireBlock } from './agent-turn-projection';

type LiveMessage = Omit<SessionMessage, 'content'> & {
  content: string | WireBlock[];
  streamingTextActive?: boolean;
};

type AskResolver = {
  input: Record<string, unknown>;
  resolve(result: PermissionResult): void;
};

type ClaudeImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

function toClaudeImageMediaType(value: string): ClaudeImageMediaType {
  if (value === 'image/jpeg' || value === 'image/png' || value === 'image/gif' || value === 'image/webp') {
    return value;
  }
  throw new Error(`Unsupported chat image type: ${value}`);
}

let workspacePath = '';
let currentSessionId = '';
let sessionState: SessionState = 'idle';
let hasInitialPrompt = false;
let messages: LiveMessage[] = [];
let transcriptCursor: TranscriptWriteCursor | null = null;
let activeQuery: Query | null = null;
let activeAbortController: AbortController | null = null;
let streamingMessage: LiveMessage | null = null;

/**
 * 一个 runTurn 的 assistant 段落投影（见 agent-turn-projection.ts）：
 * 段落按 sdkUuid 累积不替换，卡片与工具历史跨段落存活。
 */
const turnProjection = createAssistantTurnProjection();

/** 把段落展平进流式消息 content。 */
function syncStreamingContent(): void {
  if (!streamingMessage) return;
  streamingMessage.content = turnProjection.flatten();
}
let completionTerminal: SessionCompletionTerminal | null = null;
let canResumeSdkSession = false;
let turnSequence = 0;
const pendingQuestions = new Map<string, AskResolver>();

function messageId(prefix: 'user' | 'assistant'): string {
  turnSequence += 1;
  return `${prefix}-${Date.now()}-${turnSequence}`;
}

function cloneMessage(message: LiveMessage): LiveMessage {
  return structuredClone(message);
}

function asPersistedMessage(message: LiveMessage): SessionMessage {
  return {
    ...message,
    content: typeof message.content === 'string'
      ? message.content
      : JSON.stringify(message.content),
  };
}

async function persist(message: LiveMessage): Promise<void> {
  if (!transcriptCursor) throw new Error('Session transcript cursor is not initialized');
  const result = await appendSessionMessages(
    currentSessionId,
    transcriptCursor,
    [asPersistedMessage(message)],
  );
  if (!result.ok) throw new Error(result.error);
  transcriptCursor = result.cursor;
}

function setState(next: SessionState): void {
  sessionState = next;
  broadcast('chat:status', { sessionState: next });
}

function publishStreamingMessage(): void {
  if (!streamingMessage) return;
  syncStreamingContent();
  broadcast('chat:message-update', { message: cloneMessage(streamingMessage) });
}

function ensureStreamingMessage(): LiveMessage {
  if (!streamingMessage) {
    streamingMessage = {
      id: messageId('assistant'),
      role: 'assistant',
      content: [],
      timestamp: new Date().toISOString(),
      streamingTextActive: true,
    };
    turnProjection.reset();
  }
  return streamingMessage;
}

function ensureBlock(index: number, kind: WireBlock['type']): WireBlock {
  const blocks = turnProjection.pendingBlocks();
  while (blocks.length <= index) {
    blocks.push({ type: 'text', text: '' });
  }
  const current = blocks[index];
  if (current.type === kind) return current;
  const replacement: WireBlock = kind === 'thinking'
    ? { type: 'thinking', thinking: '', thinkingStartedAt: Date.now() }
    : kind === 'tool_use'
      ? { type: 'tool_use', tool: { id: '', name: '', inputJson: '', isLoading: true } }
      : { type: 'text', text: '' };
  blocks[index] = replacement;
  return replacement;
}

function handleStreamEvent(message: SDKMessage): void {
  if (message.type !== 'stream_event') return;
  ensureStreamingMessage();
  const event = message.event as unknown as Record<string, unknown>;
  const index = typeof event.index === 'number' ? event.index : 0;

  if (event.type === 'content_block_start') {
    const raw = event.content_block as Record<string, unknown> | undefined;
    if (raw?.type === 'thinking') {
      ensureBlock(index, 'thinking');
    } else if (raw?.type === 'tool_use') {
      const block = ensureBlock(index, 'tool_use');
      if (block.type === 'tool_use') {
        block.tool.id = typeof raw.id === 'string' ? raw.id : '';
        block.tool.name = typeof raw.name === 'string' ? raw.name : '';
        block.tool.inputJson = '';
        block.tool.isLoading = true;
      }
    } else {
      ensureBlock(index, 'text');
    }
    publishStreamingMessage();
    return;
  }

  if (event.type === 'content_block_delta') {
    const delta = event.delta as Record<string, unknown> | undefined;
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      const block = ensureBlock(index, 'text');
      if (block.type === 'text') block.text += delta.text;
    } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      const block = ensureBlock(index, 'thinking');
      if (block.type === 'thinking') block.thinking += delta.thinking;
    } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
      const block = ensureBlock(index, 'tool_use');
      if (block.type === 'tool_use') block.tool.inputJson = (block.tool.inputJson ?? '') + delta.partial_json;
    }
    publishStreamingMessage();
    return;
  }

  if (event.type === 'content_block_stop') {
    const blocks = turnProjection.pendingBlocks();
    const stopped = blocks[index];
    if (stopped?.type === 'thinking') {
      stopped.isComplete = true;
      stopped.thinkingDurationMs = stopped.thinkingStartedAt
        ? Date.now() - stopped.thinkingStartedAt
        : undefined;
    }
    if (stopped?.type === 'tool_use' && stopped.tool.inputJson) {
      try {
        stopped.tool.parsedInput = JSON.parse(stopped.tool.inputJson) as Record<string, unknown>;
      } catch {
        // Keep the raw partial input; the final assistant frame may repair it.
      }
    }
    ensureStreamingMessage().streamingTextActive = false;
    publishStreamingMessage();
  }
}

async function askUserQuestion(
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<PermissionResult> {
  const requestId = randomUUID();
  return await new Promise<PermissionResult>((resolve) => {
    const finish = (result: PermissionResult) => {
      pendingQuestions.delete(requestId);
      resolve(result);
    };
    pendingQuestions.set(requestId, { input, resolve: finish });
    broadcast('ask-user-question:request', {
      requestId,
      questions: Array.isArray(input.questions) ? input.questions : [],
      previewFormat: 'html',
    });
    signal.addEventListener('abort', () => {
      broadcast('ask-user-question:expired', { requestId });
      finish({ behavior: 'deny', message: 'User question was cancelled.' });
    }, { once: true });
  });
}

function buildProviderEnv(): Record<string, string | undefined> {
  const auth = resolveXiaojingMainAgentAuth();
  // 缺失时留空只服务于 initializeAgent 阶段的 configureXiaojingGeo；
  // runTurn 对缺失凭据 fail-fast，query 永远拿不到空 token。
  return {
    ...process.env,
    // 票 07：主 Agent 只走网关 Anthropic 兼容代理（网关根即协议根，后端
    // 挂 /v1/messages），账号 access token 作 Bearer。无直连回落。
    // 尾斜杠归一化避免拼出 //v1/messages。
    ANTHROPIC_BASE_URL: (auth?.baseUrl ?? '').replace(/\/+$/, ""),
    ANTHROPIC_AUTH_TOKEN: auth?.token ?? '',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_DEFAULT_OPUS_MODEL: XIAOJING_MAIN_AGENT.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: XIAOJING_MAIN_AGENT.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
  };
}

async function runTurn(
  text: string,
  images: ImagePayload[] | undefined,
  sessionFiles?: string[],
): Promise<void> {
  const turnId = randomUUID();
  completionTerminal = null;
  setState('starting');
  const abortController = new AbortController();
  activeAbortController = abortController;

  const attachments = messageAttachmentsFromImagePayloads(currentSessionId, images);
  const userMessage: LiveMessage = {
    id: messageId('user'),
    role: 'user',
    content: text,
    timestamp: new Date().toISOString(),
    attachments: attachments.map(attachment => ({
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      path: attachment.relativePath,
    })),
  };
  messages.push(userMessage);
  await persist(userMessage);
  await updateSessionTitleFromMessage(currentSessionId, text);
  broadcast('chat:message-replay', createLiveUserMessageReplay(currentSessionId, cloneMessage(userMessage)));

  // 凭据在 Sidecar 出生时一次性捕获（xiaojing-native-secret.ts）；
  // 这里缺失即永远缺失，直接 fail-fast，不把失败推迟成 SDK 的隐晦 401。
  if (!resolveXiaojingMainAgentAuth()) {
    completionTerminal = {
      sessionId: currentSessionId,
      workspacePath: workspacePath,
      turnId,
      status: 'error',
    };
    broadcast('chat:agent-error', {
      message: '主 Agent 凭据缺失：请先登录账号，然后重试。',
    });
    setState('error');
    return;
  }

  const resolvedImages = resolveImagePayloads(currentSessionId, images);
  const promptContent: Exclude<SDKUserMessage['message']['content'], string> = [];
  for (const image of resolvedImages ?? []) {
    promptContent.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: toClaudeImageMediaType(image.mimeType),
        data: image.data,
      },
    });
  }
  if (text) promptContent.push({ type: 'text', text });
  // 会话文件提醒只随本条消息出现一次；读取内容不进 transcript（ADR-0001）。
  const sessionFilesReminder = sessionFiles?.length
    ? buildSessionFilesReminder(sessionFiles.map((path) => ({
        path,
        status: isSessionFileImported(sessionFileReferenceName(path))
          ? ('imported' as const)
          : isSessionFileTextReadable(path)
            ? ('readable' as const)
            : ('binary' as const),
      })))
    : '';
  if (sessionFilesReminder) promptContent.push({ type: 'text', text: sessionFilesReminder });

  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: 'user',
      message: { role: 'user', content: promptContent },
      parent_tool_use_id: null,
      session_id: currentSessionId,
    };
  }

  const geoServer = await createXiaojingGeoServer();
  configureXiaojingGeo(buildProviderEnv() as Record<string, string>, {
    workspace: workspacePath,
    sessionId: currentSessionId,
  });

  const makeQuery = (resume: boolean): Query => query({
    prompt: prompt(),
    options: buildAgentQueryOptions({
      abortController,
      cwd: workspacePath,
      sessionId: currentSessionId,
      resume,
      geoServer,
      env: buildProviderEnv(),
      systemPrompt: buildSystemPrompt(),
      canUseTool: async (toolName, input, options) => {
        if (!isXiaojingMainAgentTool(toolName)) {
          return { behavior: 'deny', message: '小鲸同学只能调用已登记的 GEO 能力。' };
        }
        if (toolName === 'AskUserQuestion') {
          return askUserQuestion(input as Record<string, unknown>, options.signal);
        }
        return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
      },
    }),
  });

  try {
    activeQuery = makeQuery(canResumeSdkSession);
    setState('running');
    for await (const sdkMessage of activeQuery) {
      if (sdkMessage.type === 'system' && sdkMessage.subtype === 'init') {
        canResumeSdkSession = true;
        await updateSessionMetadata(currentSessionId, {
          sdkSessionId: currentSessionId,
        });
        continue;
      }

      handleStreamEvent(sdkMessage);

      if (sdkMessage.type === 'assistant') {
        // 段落累积：一个 runTurn 的全部 assistant 段落按序保留，
        // 后续段落不再覆盖早前段落的知识确认卡与工具历史。
        const message = ensureStreamingMessage();
        turnProjection.recordAssistantSegment(sdkMessage.uuid, sdkMessage.message.content);
        if (typeof sdkMessage.uuid === 'string') message.sdkUuid = sdkMessage.uuid;
        message.streamingTextActive = true;
        publishStreamingMessage();
        continue;
      }

      if (sdkMessage.type === 'user') {
        turnProjection.applyToolResults(sdkMessage.message.content);
        publishStreamingMessage();
        continue;
      }

      if (sdkMessage.type === 'result') {
        if (!streamingMessage && sdkMessage.subtype === 'success' && sdkMessage.result) {
          streamingMessage = {
            id: messageId('assistant'),
            role: 'assistant',
            content: sdkMessage.result,
            timestamp: new Date().toISOString(),
          };
        }
        if (streamingMessage && sdkMessage.usage) {
          const usage = sdkMessage.usage;
          streamingMessage.usage = {
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            cacheReadTokens: usage.cache_read_input_tokens ?? 0,
            cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
          };
          if (typeof sdkMessage.duration_ms === 'number') {
            streamingMessage.durationMs = sdkMessage.duration_ms;
          }
        }
        if (sdkMessage.subtype !== 'success') {
          throw new Error(sdkMessage.errors.join('\n') || 'Agent turn failed');
        }
      }
    }

    if (streamingMessage) {
      streamingMessage.streamingTextActive = false;
      messages.push(streamingMessage);
      await persist(streamingMessage);
      broadcast('chat:message-complete', { message: cloneMessage(streamingMessage) });
    }
    completionTerminal = {
      sessionId: currentSessionId,
      workspacePath: workspacePath,
      turnId,
      status: 'complete',
    };
    setState('idle');
  } catch (error) {
    const stopped = abortController.signal.aborted;
    // Partial 输出带终止标记落盘：否则崩溃恢复/重开后，本轮已流出的回答
    // 从 transcript 凭空消失（内存里 renderer 还留着，磁盘上没有）。
    if (streamingMessage) {
      streamingMessage.streamingTextActive = false;
      streamingMessage.terminal = stopped ? 'stopped' : 'error';
      messages.push(streamingMessage);
      try {
        await persist(streamingMessage);
      } catch {
        // 终止路径上落盘失败不能吞掉终止广播；内存副本仍随快照暴露。
      }
    }
    completionTerminal = {
      sessionId: currentSessionId,
      workspacePath: workspacePath,
      turnId,
      status: stopped ? 'stopped' : 'error',
    };
    if (stopped) {
      broadcast('chat:message-stopped', {
        message: streamingMessage ? cloneMessage(streamingMessage) : null,
      });
      setState('idle');
    } else {
      const message = error instanceof Error ? error.message : String(error);
      broadcast('chat:agent-error', { message });
      setState('error');
    }
  } finally {
    activeQuery = null;
    activeAbortController = null;
    streamingMessage = null;
    turnProjection.reset();
  }
}

export async function initializeAgent(
  nextWorkspacePath: string,
  initialPrompt?: string | null,
  initialSessionId?: string,
): Promise<void> {
  workspacePath = nextWorkspacePath;
  currentSessionId = initialSessionId ?? randomUUID();
  hasInitialPrompt = Boolean(initialPrompt?.trim());
  const transcript = await loadSessionTranscript(currentSessionId);
  transcriptCursor = transcript.cursor;
  messages = transcript.messages.map(message => ({ ...message }));
  canResumeSdkSession = Boolean(getSessionMetadata(currentSessionId)?.sdkSessionId);
  sessionState = 'idle';
  completionTerminal = null;
  configureXiaojingGeo(buildProviderEnv() as Record<string, string>, {
    workspace: workspacePath,
    sessionId: currentSessionId,
  });
  if (initialPrompt?.trim()) {
    void runTurn(initialPrompt.trim(), undefined);
  }
}

export async function enqueueUserMessage(
  text: string,
  images?: ImagePayload[],
  sessionFiles?: string[],
): Promise<{
  accepted: boolean;
  error?: string;
}> {
  if (isSessionBusy()) return { accepted: false, error: 'Agent is already responding.' };
  if (!text.trim() && (!images || images.length === 0) && (!sessionFiles || sessionFiles.length === 0)) {
    return { accepted: false, error: 'Empty message.' };
  }
  void runTurn(text.trim(), images, sessionFiles);
  return { accepted: true };
}

export async function interruptCurrentResponse(): Promise<boolean> {
  if (!activeQuery && !activeAbortController) return false;
  setState('stopping');
  activeAbortController?.abort();
  activeQuery?.close();
  return true;
}

export async function handleAskUserQuestionResponse(
  requestId: string,
  answers: Record<string, string> | null,
): Promise<boolean> {
  const pending = pendingQuestions.get(requestId);
  if (!pending) return false;
  pendingQuestions.delete(requestId);
  if (answers === null) {
    pending.resolve({ behavior: 'deny', message: 'User cancelled the question.' });
  } else {
    pending.resolve({
      behavior: 'allow',
      updatedInput: { ...pending.input, answers },
    });
  }
  return true;
}

export function getPendingInteractiveRequests(): Array<{
  type: 'ask-user-question:request';
  data: unknown;
}> {
  return [...pendingQuestions.entries()].map(([requestId, pending]) => ({
    type: 'ask-user-question:request',
    data: {
      requestId,
      questions: Array.isArray(pending.input.questions) ? pending.input.questions : [],
      previewFormat: 'html',
    },
  }));
}

export function getBuiltinLiveSessionSnapshot(targetSessionId: string): {
  snapshotRevision: number;
  inMemoryMessages: SessionMessage[];
  liveStreamingMessage: SessionMessage | null;
  liveSessionState: SessionState;
  pendingInteractiveRequests: ReturnType<typeof getPendingInteractiveRequests>;
} | null {
  if (targetSessionId !== currentSessionId) return null;
  return {
    snapshotRevision: messages.length + (streamingMessage ? 1 : 0),
    inMemoryMessages: messages.map(asPersistedMessage),
    liveStreamingMessage: streamingMessage ? asPersistedMessage(streamingMessage) : null,
    liveSessionState: sessionState,
    pendingInteractiveRequests: getPendingInteractiveRequests(),
  };
}

export function getAgentState(): {
  workspacePath: string;
  sessionState: SessionState;
  hasInitialPrompt: boolean;
} {
  return { workspacePath, sessionState, hasInitialPrompt };
}

export function getSessionCompletionTerminal(): SessionCompletionTerminal | null {
  return completionTerminal;
}

export function getLastBuiltinAssistantText(): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    if (typeof message.content === 'string') return message.content;
    return message.content
      .filter((block): block is Extract<WireBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('');
  }
  return '';
}

export function isSessionBusy(): boolean {
  return sessionState === 'starting' || sessionState === 'running' || sessionState === 'stopping';
}

export function getSessionId(): string {
  return currentSessionId;
}

export function setSidecarPort(port: number): void {
  process.env.XIAOJING_PORT = String(port);
}

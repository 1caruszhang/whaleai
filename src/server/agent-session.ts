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
 * 流式快照的 trailing-edge 合并间隔。content_block_delta 每 token 一次，
 * 每次同步 structuredClone 整条消息再 broadcast，消息随轮次变长后整体
 * O(n²)；delta 路径只标脏，由定时器按该间隔合并发出。
 */
export const STREAM_FLUSH_INTERVAL_MS = 80;
/**
 * interruptCurrentResponse 后置 stopping 的兜底时限：SDK 流挂死时
 * for-await 永不 settle，而 stopping 也算 busy（isSessionBusy），
 * 会永久阻塞新消息与会话删除。超时强制落 error 并广播终止事件。
 */
export const STOPPING_WATCHDOG_MS = 15_000;
let streamFlushTimer: ReturnType<typeof setTimeout> | null = null;
let streamFlushPending = false;
let stoppingWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * 当前占有流式定时器/看门狗/activeQuery 的 runTurn。stopping 看门狗强终止
 * 后，悬挂的旧 runTurn 若晚 settle，其 finally 只能清属于自己 turn 的
 * 状态——以本字段判定归属，避免误清新一轮 turn 的定时器与看门狗。
 */
let activeTurnId: string | null = null;

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

/**
 * 单条提问失效：撤登记、广播 expired 让渲染层撤卡、deny 掉 SDK 侧
 * Promise（无人消费也不泄漏）。
 */
function failQuestion(requestId: string, reason: string): void {
  const pending = pendingQuestions.get(requestId);
  if (!pending) return;
  pendingQuestions.delete(requestId);
  broadcast('ask-user-question:expired', { requestId });
  pending.resolve({ behavior: 'deny', message: reason });
}

/**
 * turn 死亡但用户尚未作答时，悬挂的提问必须随之失效——否则卡片
 * 残挂，点击提交后什么都不会发生。
 */
function failAllPendingQuestions(reason: string): void {
  for (const requestId of [...pendingQuestions.keys()]) {
    failQuestion(requestId, reason);
  }
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

function cancelStreamFlush(): void {
  if (streamFlushTimer) {
    clearTimeout(streamFlushTimer);
    streamFlushTimer = null;
  }
  streamFlushPending = false;
}

/** 立即发出积压的脏快照（若有）并取消合并定时器；生命周期事件先调它再发自己。 */
function flushStreamingMessage(): void {
  if (!streamFlushPending) {
    cancelStreamFlush();
    return;
  }
  cancelStreamFlush();
  publishStreamingMessage();
}

/** delta 路径只标脏；快照由 trailing-edge 定时器合并发出。 */
function markStreamingDirty(): void {
  streamFlushPending = true;
  if (streamFlushTimer) return;
  streamFlushTimer = setTimeout(() => {
    streamFlushTimer = null;
    if (!streamFlushPending) return;
    streamFlushPending = false;
    publishStreamingMessage();
  }, STREAM_FLUSH_INTERVAL_MS);
  streamFlushTimer.unref?.();
}

function clearStoppingWatchdog(): void {
  if (stoppingWatchdogTimer) {
    clearTimeout(stoppingWatchdogTimer);
    stoppingWatchdogTimer = null;
  }
}

/**
 * stopping 兜底看门狗：时限内 for-await 仍未 settle（状态没回到
 * idle/error），强制定为 error 并广播终止事件，让 isBusy 解锁。
 * 不写 completionTerminal：turnId 属于仍悬挂的 runTurn，若它之后
 * 真的 settle，正常 catch 路径会补上正确的终止记录。
 * 回调按 turn 归属判定：武装它的 turn 已不再是当前 turn 时（旧 runTurn
 * 的看门狗残留到新一轮），不得误终止新 turn。
 */
function armStoppingWatchdog(): void {
  clearStoppingWatchdog();
  const turnId = activeTurnId;
  stoppingWatchdogTimer = setTimeout(() => {
    stoppingWatchdogTimer = null;
    if (sessionState !== 'stopping') return;
    if (turnId !== activeTurnId) return;
    flushStreamingMessage();
    activeQuery = null;
    activeAbortController = null;
    // 强杀不经 abort，提问监听器不会触发；这里一并失效，防止卡片残挂。
    failAllPendingQuestions('Agent turn force-terminated; the question is no longer pending.');
    broadcast('chat:agent-error', {
      message: `停止响应超时（${STOPPING_WATCHDOG_MS / 1000}s）：Agent 未结束本轮，已强制终止。`,
    });
    setState('error');
  }, STOPPING_WATCHDOG_MS);
  stoppingWatchdogTimer.unref?.();
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
    // 生命周期事件立即发：先冲掉积压快照，再发块结构变化。
    flushStreamingMessage();
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
    markStreamingDirty();
    return;
  }

  if (event.type === 'content_block_stop') {
    flushStreamingMessage();
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
    pendingQuestions.set(requestId, { input, resolve });
    broadcast('ask-user-question:request', {
      requestId,
      questions: Array.isArray(input.questions) ? input.questions : [],
      previewFormat: 'html',
    });
    signal.addEventListener('abort', () => {
      failQuestion(requestId, 'User question was cancelled.');
    }, { once: true });
  });
}

function buildProviderEnv(requestAccountToken?: string): Record<string, string | undefined> {
  const auth = resolveXiaojingMainAgentAuth(requestAccountToken);
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
  requestAccountToken?: string,
): Promise<void> {
  const turnId = randomUUID();
  activeTurnId = turnId;
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
  // 请求级新鲜 token 优先于 admission env。两者都缺失即永远缺失，
  // 直接 fail-fast，不把失败推迟成 SDK 的隐晦 401。
  if (!resolveXiaojingMainAgentAuth(requestAccountToken)) {
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
  configureXiaojingGeo(buildProviderEnv(requestAccountToken) as Record<string, string>, {
    workspace: workspacePath,
    sessionId: currentSessionId,
    requestAccountToken,
  });

  const makeQuery = (resume: boolean): Query => query({
    prompt: prompt(),
    options: buildAgentQueryOptions({
      abortController,
      cwd: workspacePath,
      sessionId: currentSessionId,
      resume,
      geoServer,
      env: buildProviderEnv(requestAccountToken),
      systemPrompt: buildSystemPrompt(),
      canUseTool: async (toolName, input, options) => {
        if (!isXiaojingMainAgentTool(toolName)) {
          return { behavior: 'deny', message: '鲸杉geo只能调用已登记的 GEO 能力。' };
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
        flushStreamingMessage();
        const message = ensureStreamingMessage();
        turnProjection.recordAssistantSegment(sdkMessage.uuid, sdkMessage.message.content);
        if (typeof sdkMessage.uuid === 'string') message.sdkUuid = sdkMessage.uuid;
        message.streamingTextActive = true;
        publishStreamingMessage();
        continue;
      }

      if (sdkMessage.type === 'user') {
        flushStreamingMessage();
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

    // 终止处理同样按 turn 归属：本 turn 已被看门狗强终止且新一轮 turn
    // 接管共享状态后，晚 settle 的旧 turn 不得覆写新 turn 的消息与状态。
    if (activeTurnId === turnId) {
      if (streamingMessage) {
        flushStreamingMessage();
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
      // 流在提问未决时非异常收尾（罕见但真实）：扫尾防悬挂死卡。
      failAllPendingQuestions('Agent turn completed; the question is no longer pending.');
      setState('idle');
    }
  } catch (error) {
    if (activeTurnId === turnId) {
      const stopped = abortController.signal.aborted;
      flushStreamingMessage();
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
        // turn 非中止性死亡：悬挂提问随 turn 失效（abort 监听器不会触发）。
        failAllPendingQuestions('Agent turn failed; the question is no longer pending.');
        const message = error instanceof Error ? error.message : String(error);
        broadcast('chat:agent-error', { message });
        setState('error');
      }
    }
  } finally {
    // 只清仍属于本 turn 的状态：stopping 看门狗强终止后，悬挂的旧 runTurn
    // 若晚 settle，不能清掉新一轮 turn 的流式定时器/看门狗/activeQuery。
    if (activeTurnId === turnId) {
      activeTurnId = null;
      cancelStreamFlush();
      clearStoppingWatchdog();
      activeQuery = null;
      activeAbortController = null;
      streamingMessage = null;
      turnProjection.reset();
    }
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
  // transcript 加载可能抛错，悬挂提问的失效清理必须先行——旧会话的
  // 死卡不能在任何失败路径下跨初始化存活。
  failAllPendingQuestions('Session reinitialized; the question is no longer pending.');
  const transcript = await loadSessionTranscript(currentSessionId);
  transcriptCursor = transcript.cursor;
  messages = transcript.messages.map(message => ({ ...message }));
  canResumeSdkSession = Boolean(getSessionMetadata(currentSessionId)?.sdkSessionId);
  // 看门狗强终止会留下永不 settle 的悬挂 runTurn（finally 不执行），
  // 重新初始化时清掉它的流式残影与定时器。
  activeTurnId = null;
  cancelStreamFlush();
  clearStoppingWatchdog();
  streamingMessage = null;
  turnProjection.reset();
  activeQuery = null;
  activeAbortController = null;
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
  requestAccountToken?: string,
): Promise<{
  accepted: boolean;
  error?: string;
}> {
  if (isSessionBusy()) return { accepted: false, error: 'Agent is already responding.' };
  if (!text.trim() && (!images || images.length === 0) && (!sessionFiles || sessionFiles.length === 0)) {
    return { accepted: false, error: 'Empty message.' };
  }
  void runTurn(text.trim(), images, sessionFiles, requestAccountToken);
  return { accepted: true };
}

export async function interruptCurrentResponse(): Promise<boolean> {
  if (!activeQuery && !activeAbortController) return false;
  setState('stopping');
  activeAbortController?.abort();
  activeQuery?.close();
  armStoppingWatchdog();
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

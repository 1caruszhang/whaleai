import type { ChatTokenUsage } from '../domain/chat-usage';

/**
 * Anthropic /v1/messages usage 抽取（网关旁路计量，票 04）。
 * 非流式：最终 message JSON 的 `usage` 字段；流式：SSE 事件的
 * message_start（input/cache）与 message_delta（output，Anthropic 口径为
 * 累计值）——见 SseUsageTap。
 */

function pickNonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function usageFromShape(usage: unknown): ChatTokenUsage | undefined {
  if (typeof usage !== 'object' || usage === null) return undefined;
  const shape = usage as Record<string, unknown>;
  if (shape.input_tokens === undefined && shape.output_tokens === undefined) return undefined;
  return {
    inputTokens: pickNonNegativeInt(shape.input_tokens),
    cacheReadTokens: pickNonNegativeInt(shape.cache_read_input_tokens),
    cacheCreationTokens: pickNonNegativeInt(shape.cache_creation_input_tokens),
    outputTokens: pickNonNegativeInt(shape.output_tokens),
  };
}

/** 非流式 message JSON → {model, usage}；无 usage 字段（如错误体）返回 undefined。 */
export function extractUsageFromMessageJson(
  parsed: unknown,
): { model: string; usage: ChatTokenUsage } | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const message = parsed as Record<string, unknown>;
  const usage = usageFromShape(message.usage);
  if (!usage) return undefined;
  const model = typeof message.model === 'string' ? message.model : '';
  return { model, usage };
}

/**
 * 流式 usage 旁路监听器：喂入上游 SSE 的原始字节（逐块、跨块边界安全），
 * 在 message_start / message_delta 事件上累积真实用量，流结束时 finalize。
 * Anthropic 流式口径：message_start.message.usage 带 input（含 cache 字段），
 * message_delta.usage 的 output_tokens 为累计值（后到者胜）。
 */
export class SseUsageTap {
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private dataLines: string[] = [];
  private model = '';
  private inputTokens = 0;
  private cacheReadTokens = 0;
  private cacheCreationTokens = 0;
  private outputTokens = 0;

  feed(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      this.consumeLine(line);
    }
  }

  private consumeLine(line: string): void {
    if (line === '') {
      this.dispatchEvent();
      this.dataLines = [];
      return;
    }
    if (line.startsWith('data:')) {
      // SSE 允许多行 data 拼接（Anthropic 实际单行，按规范实现）。
      this.dataLines.push(line.slice('data:'.length).replace(/^ /, ''));
    }
    // event:/注释行不影响 usage 抽取，忽略。
  }

  private dispatchEvent(): void {
    if (this.dataLines.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.dataLines.join('\n'));
    } catch {
      return; // 非 JSON data 行（如上游注释/异常片段）不计量
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const event = parsed as Record<string, unknown>;
    if (event.type === 'message_start' && typeof event.message === 'object' && event.message !== null) {
      const message = event.message as Record<string, unknown>;
      if (typeof message.model === 'string') this.model = message.model;
      const usage = usageFromShape(message.usage);
      if (usage) {
        this.inputTokens = usage.inputTokens;
        this.cacheReadTokens = usage.cacheReadTokens;
        this.cacheCreationTokens = usage.cacheCreationTokens;
        if (usage.outputTokens > 0) this.outputTokens = usage.outputTokens;
      }
      return;
    }
    if (event.type === 'message_delta') {
      const usage = usageFromShape(event.usage);
      if (usage) {
        if (usage.inputTokens > 0) this.inputTokens = usage.inputTokens;
        if (usage.cacheReadTokens > 0) this.cacheReadTokens = usage.cacheReadTokens;
        if (usage.cacheCreationTokens > 0) this.cacheCreationTokens = usage.cacheCreationTokens;
        if (usage.outputTokens > 0) this.outputTokens = usage.outputTokens;
      }
    }
  }

  /** 流结束（message_stop 或上游关流）时取最终用量；无任何 usage 返回 undefined。 */
  finalize(): { model: string; usage: ChatTokenUsage } | undefined {
    this.dispatchEvent(); // 残留无尾换行的最后事件
    if (this.inputTokens === 0 && this.outputTokens === 0 && this.cacheReadTokens === 0 && this.cacheCreationTokens === 0) {
      return undefined;
    }
    return {
      model: this.model,
      usage: {
        inputTokens: this.inputTokens,
        cacheReadTokens: this.cacheReadTokens,
        cacheCreationTokens: this.cacheCreationTokens,
        outputTokens: this.outputTokens,
      },
    };
  }
}

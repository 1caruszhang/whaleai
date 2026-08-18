/**
 * OpenAI 系响应的 usage 抽取（网关旁路计量，票 05）。覆盖经网关代理的
 * ARK /chat/completions（`prompt_tokens`/`completion_tokens`）、/responses
 * 与 /embeddings/multimodal（`input_tokens`/`output_tokens` 口径）以及
 * 豆包搜索透传体（无 usage → 不计量 token，只计次数）。
 */

export interface OpenAiTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

function pickNonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

/** OpenAI 系 JSON → {inputTokens, outputTokens}；无 usage 字段返回 undefined。 */
export function extractOpenAiUsage(parsed: unknown): OpenAiTokenUsage | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const usage = (parsed as Record<string, unknown>).usage;
  if (typeof usage !== 'object' || usage === null) return undefined;
  const shape = usage as Record<string, unknown>;
  // chat/completions 用 prompt/completion_tokens；responses 与 embeddings
  // 用 input/output_tokens。两族字段都识别，均缺省则不算 usage。
  const input = shape.prompt_tokens ?? shape.input_tokens;
  const output = shape.completion_tokens ?? shape.output_tokens;
  if (input === undefined && output === undefined) return undefined;
  return { inputTokens: pickNonNegativeInt(input), outputTokens: pickNonNegativeInt(output) };
}

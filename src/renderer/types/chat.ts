export interface ToolUseSimple {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  inputJson?: string;
  parsedInput?: Record<string, unknown>;
  result?: string;
  isLoading?: boolean;
  isError?: boolean;
  isStopped?: boolean;
  isFailed?: boolean;
}

export interface ContentBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'server_tool_use';
  text?: string;
  thinking?: string;
  thinkingStartedAt?: number;
  thinkingDurationMs?: number;
  isComplete?: boolean;
  isStopped?: boolean;
  isFailed?: boolean;
  tool?: ToolUseSimple;
}

export interface MessageAttachment {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  savedPath?: string;
  relativePath?: string;
  previewUrl?: string;
  isImage?: boolean;
}

export interface MessageUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  providerId?: string;
  model?: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
  timestamp: Date;
  attachments?: MessageAttachment[];
  streamingTextActive?: boolean;
  usage?: MessageUsage;
  toolCount?: number;
  durationMs?: number;
}

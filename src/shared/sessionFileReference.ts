/**
 * 会话附件（session-attached file）引用契约。
 *
 * 领域规则见 docs/adr/0001：拖入聊天框的文档复制到
 * `<workspace>/xiaojing_files/<sessionId>/`（会话私有），消息文本里以
 * `@xiaojing_files/<sessionId>/<name>` token 持久化（transcript 契约），
 * 渲染端剥离 token 显示为 chip，服务端凭结构化路径列表构建提醒。
 */

export const SESSION_FILES_DIR = 'xiaojing_files';

/** 单条消息允许附带的最大文件数。 */
export const SESSION_FILE_MAX_MESSAGE_FILES = 10;

/** read_session_file 单次返回的默认头部字符数（ADR-0001）。 */
export const SESSION_FILE_READ_HEAD_CHARS = 10_000;

/** read_session_file 允许的最大起始偏移（字符）。 */
export const SESSION_FILE_READ_MAX_OFFSET_CHARS = 2_000_000;

/** 会话文件中文本类扩展名白名单（主 Agent 可直接读取）。 */
export const SESSION_FILE_TEXT_EXTENSIONS: readonly string[] = [
  'md', 'markdown', 'txt', 'csv', 'tsv', 'json', 'jsonl', 'html', 'htm', 'xml',
  'log', 'yml', 'yaml', 'toml', 'ini', 'conf', 'env', 'sql',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte',
  'py', 'rs', 'go', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs',
  'sh', 'bash', 'zsh', 'bat', 'ps1', 'lua', 'rb', 'php', 'css', 'scss', 'less',
];

/** 正文里的引用 token；路径段内不允许空白与 `@`，编码由 encode/decode 承担。 */
const SESSION_FILE_TOKEN_PATTERN = /@xiaojing_files\/[^\s@]+/g;

/** token 里的路径做百分号编码，保证含空格/`@`/`%` 的文件名可往返。 */
export function encodeSessionFileReferencePath(path: string): string {
  return path.replace(/%/g, '%25').replace(/@/g, '%40').replace(/\s/g, '%20');
}

export function decodeSessionFileReferencePath(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

/**
 * 把完整工作区相对路径（必须以 `xiaojing_files/` 开头）编码为消息文本里的
 * `@xiaojing_files/…` token；提取端用 extractSessionFileReferences 反解。
 */
export function buildSessionFileToken(path: string): string {
  return `@${encodeSessionFileReferencePath(path)}`;
}

export function sessionFileReferenceName(path: string): string {
  const segments = path.split('/');
  return segments[segments.length - 1] ?? path;
}

export interface ExtractedSessionFileReferences {
  cleanText: string;
  /** 按出现顺序去重后的解码路径列表。 */
  references: string[];
}

export function extractSessionFileReferences(text: string): ExtractedSessionFileReferences {
  const references: string[] = [];
  const cleanText = text.replace(SESSION_FILE_TOKEN_PATTERN, (token) => {
    const path = decodeSessionFileReferencePath(token.slice(1));
    if (!references.includes(path)) references.push(path);
    return '';
  })
    .replace(/ {2,}/g, ' ')
    .trimEnd();
  return { cleanText, references };
}

/**
 * 会话文件引用必须形如 `xiaojing_files/<sessionId>/<name>`：
 * 恰好三段、第二段等于当前会话 ID、无遍历/绝对路径成分。
 */
export function isSessionFileReference(path: string, sessionId: string): boolean {
  if (!path || !sessionId) return false;
  const segments = path.split('/');
  if (segments.length !== 3) return false;
  if (segments[0] !== SESSION_FILES_DIR || segments[1] !== sessionId) return false;
  const name = segments[2];
  if (!name || name === '.' || name === '..') return false;
  return true;
}

export function isSessionFileTextReadable(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return false;
  const extension = path.slice(dot + 1).toLowerCase();
  return SESSION_FILE_TEXT_EXTENSIONS.includes(extension);
}

/** 拖拽复制目标目录：会话私有的 `xiaojing_files/<sessionId>/`。 */
export function sessionFilesTargetDir(sessionId: string): string {
  return `${SESSION_FILES_DIR}/${sessionId}`;
}

import type { Options } from '@anthropic-ai/claude-agent-sdk';

type ClaudeExecutableOption = Pick<Options, 'pathToClaudeCodeExecutable'>;

/**
 * Rust owns packaged-runtime admission. The server only forwards the admitted
 * executable path to the SDK and never searches the system or a user profile.
 */
export function claudeExecutableOption(
  env: Readonly<Record<string, string | undefined>>,
): ClaudeExecutableOption {
  const executable = env.XIAOJING_CLAUDE_CODE_EXECUTABLE?.trim();
  if (!executable) return {};
  if (executable.includes('\0')) {
    throw new Error('Packaged Claude executable path contains a NUL byte');
  }
  return { pathToClaudeCodeExecutable: executable };
}

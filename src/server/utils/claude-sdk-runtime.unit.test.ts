import { describe, expect, it } from 'vitest';

import { claudeExecutableOption } from './claude-sdk-runtime';

describe('claudeExecutableOption', () => {
  it('preserves an admitted Windows path with Unicode, spaces and percent signs', () => {
    const path = String.raw`C:\Users\测试 用户%25\AppData\Local\小鲸同学\claude-agent-sdk\claude.exe`;
    expect(claudeExecutableOption({ XIAOJING_CLAUDE_CODE_EXECUTABLE: path })).toEqual({
      pathToClaudeCodeExecutable: path,
    });
  });

  it('does not invent a system executable fallback', () => {
    expect(claudeExecutableOption({})).toEqual({});
  });

  it('rejects a path that cannot be passed to a child process', () => {
    expect(() => claudeExecutableOption({
      XIAOJING_CLAUDE_CODE_EXECUTABLE: 'C:\\bad\0path\\claude.exe',
    })).toThrow(/NUL byte/);
  });
});

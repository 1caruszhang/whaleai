import { describe, expect, it } from 'vitest';

import { buildSystemPrompt } from './system-prompt';
import { buildSessionFilesReminder } from '../shared/systemReminder';

/**
 * system_prompt_architecture.md：修改 prompt 必须同步单测，且不得扩大能力面。
 * 这里断言的是边界语句与关键约束，不锁全文措辞。
 */
describe('buildSystemPrompt', () => {
  const prompt = buildSystemPrompt();

  it('requires simplified Chinese for both thinking and replies', () => {
    expect(prompt).toContain('你的思考过程与回复一律使用简体中文');
  });

  it('keeps the single registered capability boundary', () => {
    expect(prompt).toContain('xiaojing-geo');
    expect(prompt).toContain('start_geo_operation');
    expect(prompt).not.toMatch(/mcp__[a-z-]+__/);
  });

  it('locks the intent decision table with a full-optimization default', () => {
    expect(prompt).toContain('点名了具体环节');
    expect(prompt).toContain('没有点名环节');
    expect(prompt).toContain('full-optimization');
    expect(prompt).toContain('把步骤计划告诉用户');
    expect(prompt).not.toContain('只有用户明确要求完整');
    expect(prompt).not.toContain('让用户选择');
  });

  it('rations clarification to one structured AskUserQuestion with a recommended first option', () => {
    expect(prompt).toContain('通信默认是告知');
    expect(prompt).toContain('AskUserQuestion');
    expect(prompt).toContain('最多一个问题');
    expect(prompt).toContain('推荐项放在第一个');
  });

  it('keeps adjudication gates user-owned and never leaks internals', () => {
    expect(prompt).toContain('待确认门');
    expect(prompt).toContain('不要代替用户裁决');
    expect(prompt).not.toMatch(/ANTHROPIC|API[_ ]?KEY|localhost|127\.0\.0\.1|XIAOJING_PORT/);
  });
});

/**
 * GD-8③ 回归：XIAOJING_SESSION_FILES 提醒（systemReminder.ts，随消息投送）
 * 与主系统提示词里的会话文件规则（system-prompt.ts）是同一契约的两份文案，
 * system_reminder_protocol.md 要求两处必须同步修改。这里按"规则 token"而非
 * 全文措辞锁定：任何一侧改动导致关键规则缺失时，本测试失败。
 */
describe('session-files reminder copy stays in sync with the system prompt', () => {
  const reminder = buildSessionFilesReminder([
    { path: 'xiaojing_files/s/a.md', status: 'readable' },
    { path: 'xiaojing_files/s/logo.png', status: 'binary' },
    { path: 'xiaojing_files/s/b.md', status: 'imported' },
  ]);
  const prompt = buildSystemPrompt();

  it('both sides route readable brand material through import_pasted_material with the original file name', () => {
    expect(reminder).toContain('import_pasted_material');
    expect(reminder).toContain('displayName = original file name');
    expect(prompt).toContain('import_pasted_material');
    expect(prompt).toContain('displayName 使用原文件名');
  });

  it('both sides stop at the knowledge gate and defer adjudication to the user', () => {
    expect(reminder).toContain('knowledge confirmation gate');
    expect(prompt).toContain('知识裁决门');
  });

  it('both sides read readable files first and never re-read imported ones', () => {
    expect(reminder).toContain('read_session_file');
    expect(reminder).toContain('query brand knowledge');
    expect(prompt).toContain('read_session_file');
    expect(prompt).toContain('查询品牌知识');
  });

  it('both sides route binary files to the brand-material panel and act instead of open-ended asking', () => {
    expect(reminder).toContain('brand-material panel');
    expect(prompt).toContain('品牌材料面板');
    expect(reminder).toContain('do not stop at an open-ended question');
    expect(prompt).toContain('不要停在开放式提问');
  });
});

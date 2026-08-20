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
    // 阶段计划由进度卡片播报，正文只讲当前停靠的确认门，不复述全部步骤。
    expect(prompt).toContain('由聊天里的进度卡片播报');
    expect(prompt).toContain('不要复述全部步骤');
    expect(prompt).not.toContain('只有用户明确要求完整');
    expect(prompt).not.toContain('让用户选择');
  });

  // 回归（多门共存）：计划认可卡与知识确认卡同回合出现时，
  // agent 必须点明先后且说明裁决互不阻塞，不靠卡片顺序自解释。
  it('explains gate sequencing when the plan-ack card and knowledge card coexist', () => {
    expect(prompt).toContain('先在进度卡片上放行计划');
    expect(prompt).toContain('第一阶段的第一道门');
    expect(prompt).toContain('两道门的裁决互不阻塞');
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

  // GD-12 回归：对用户汇报必须用自然中文口吻，内部枚举/ID/revision
  // 等工程术语不得泄露到用户可见回复（决策表内部仍可用枚举名）。
  it('speaks natural Chinese and never surfaces internal engineering terms', () => {
    expect(prompt).toContain('专业、自然的日常中文口吻');
    expect(prompt).toContain('内部实现名称不得出现在回复中');
    // goal 与指代操作都用简短目标短语；阶段链条由进度卡片展示，不复述。
    expect(prompt).toContain('指代操作时用简短人话');
    expect(prompt).toContain('不把阶段链条展开写进 goal 或正文');
    expect(prompt).toContain('始终保持简体中文');
  });

  // 价格脱敏回归：聊天里费用一律用「点」，只能复述工具结果里已有的
  // 点数字段；不得出现人民币金额、不得换算、不得解释定价规则。
  it('keeps all cost talk in points and bans CNY amounts and pricing rules', () => {
    expect(prompt).toContain('一律用「点」表述');
    expect(prompt).toContain('只能引用工具结果中已有的点数字段');
    expect(prompt).toContain('不得做任何换算');
    expect(prompt).toContain('不得解释点数与人民币的关系');
    expect(prompt).toContain('定价规则');
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

  it('both sides route binary files to the agent-invoked material request card and act instead of open-ended asking', () => {
    expect(reminder).toContain('request_brand_material');
    expect(reminder).toContain('material request card');
    expect(prompt).toContain('request_brand_material');
    expect(prompt).toContain('材料请求卡');
    expect(reminder).toContain('do not stop at an open-ended question');
    expect(prompt).toContain('不要停在开放式提问');
  });

  // ADR 0005 回归：材料请求卡的唤起标准是提示词硬规则，含标准②的刻意
  // 排除——操作中途缺材料佐证不得打断，按来源层级推进交用户裁决。
  it('pins the material-request invocation criteria and the mid-operation exclusion', () => {
    expect(prompt).toContain('只在你判断需要新材料时调用');
    expect(prompt).toContain('制定计划时品牌还没有已确认知识');
    expect(prompt).toContain('用户明确表示要补充品牌材料');
    expect(prompt).toContain('不可直读的二进制品牌材料');
    expect(prompt).toContain('操作进行中不得因某个确认门缺材料佐证而调用');
    expect(prompt).toContain('材料是否够用只在制定计划时判断一次');
  });

  // 认可门是唯一入口：放行前不得开始执行任何计划步骤，
  // 材料请求卡也不得提前发出；放行后按计划顺序、从第一步开始执行。
  it('keeps every plan step (including the material request card) behind the plan-ack gate', () => {
    expect(prompt).toContain('不得开始执行任何阶段');
    expect(prompt).toContain('一律等放行后按计划顺序执行');
    expect(prompt).toContain('先做什么取决于计划的第一步');
    expect(prompt).toContain('不得在放行前提前发出');
    expect(prompt).toContain('随计划执行的请求卡等放行后执行到该步骤才发出');
    // 旧错误规则（与计划卡同回合发卡）不得回归。
    expect(prompt).not.toContain('必须在创建操作的同一回合调用 request_brand_material');
  });

  // GD-13 回归：所有闸门的操作入口统一为聊天内的交互卡片，
  // 卡片内容来自 agent 工具结果，右侧工作台只做结果展示。
  it('makes the in-chat gate cards the single entry for every confirmation', () => {
    expect(prompt).toContain('唯一的操作入口');
    // 多卡共存时方位指代会指错对象，入口指引不带「上方/下方」。
    expect(prompt).toContain('在聊天里对应的确认卡片上完成操作并确认');
    expect(prompt).not.toContain('在下方的确认卡片');
    expect(prompt).toContain('run_question_pool');
    expect(prompt).toContain('产品线取领域级');
    expect(prompt).toContain('自动取品牌已确认的领域');
    expect(prompt).toContain('品牌创建只需名称');
    expect(prompt).toContain('businessFocus');
    expect(prompt).toContain('plan_topics');
    expect(prompt).toContain('generate_articles');
    expect(prompt).toContain('plan_distribution');
    expect(prompt).toContain('prepare_publish');
    expect(prompt).toContain('你没有发起的阶段不会有卡片');
    expect(prompt).toContain('工作台只做结果展示');
    expect(prompt).toContain('你无权跨越');
  });
});

import { describe, expect, it } from 'vitest';

import { buildSystemPrompt } from './system-prompt';
import { buildSessionFilesReminder } from '../shared/systemReminder';
import { MATERIAL_COLLECTION_CONTRACT } from '../shared/geo/materialRequestCard';

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
    // 静态能力清单从 inspect_brand_context 返回体收敛到 prompt 身份段：
    // 登记能力全部可用、范围外不得声称——一次说清，不逐次重复发送。
    expect(prompt).toContain('产品登记的能力范围（当前全部处于可用状态）');
    expect(prompt).toContain('不得虚构计划中的能力切片');
  });

  // 回归（跨 Session 状态盲区）：品牌事实与已确认竞品是 BrandWorkspace 持久
  // 数据；新 Session 必须先读摘要再决定是否向用户要信息，不得重新征集。
  it('requires reading persisted brand state before asking the user for brand facts', () => {
    expect(prompt).toContain('品牌状态先读后问');
    expect(prompt).toContain('inspect_brand_context');
    expect(prompt).toContain('inspect_brand_fact');
    expect(prompt).toContain('enterprise-profile.competitors');
    expect(prompt).toContain('不得因换了 Session 就重新征集');
    // 读取失败（null / present:false）是异常不是数据缺失，不得当作不足重新征集。
    expect(prompt).toContain('绝不把读取异常当作信息不足向用户征集');
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

  // 闸门之间决定性推进（ADR-0011 Decision 2）：信封引述 next-step，模型
  // 从推导者降为执行者——照单执行、先重读再执行、不现场推导；引述缺失
  // 或过期时以重读的计划为准（保留「先重读再执行」指令）。
  it('advances decisively by executing the envelope-quoted next-step after re-reading', () => {
    expect(prompt).toContain('闸门之间决定性推进');
    expect(prompt).toContain('决策回执信封会携带从持久化计划引述的 next-step');
    expect(prompt).toContain('先重读操作状态→按信封引述的 next-step 执行');
    expect(prompt).toContain('不现场推导下一步');
    expect(prompt).toContain('以重读到的计划为准继续');
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
 * ADR-0010 Decision 5 / 票 #27 回归：「先读后问」细化为「带推荐与理由的
 * 选项式询问」（起点推导）。推导只决定从哪开始，不改写 18+1 步序列与
 * 确认门位置；接管被拒不裸报错。这里按规则 token 锁定，提示词漂移可被
 * 捕获。
 */
describe('starting-point derivation asks with a recommended option (ADR-0010, ticket #27)', () => {
  const prompt = buildSystemPrompt();

  // AC1：「先读后问」细化为带推荐与理由的选项式询问。
  it('refines read-then-ask into an option-style question with a recommendation and its reason', () => {
    expect(prompt).toContain('起点推导');
    expect(prompt).toContain('带推荐与理由的选项式询问');
    expect(prompt).toContain('推荐项放第一个');
    // 推荐必须给出理由（用户故事 5），不是裸选项。
    expect(prompt).toContain('写明推荐理由');
    // 全新品牌无可推导：不问，直接按意图决策表创建。
    expect(prompt).toContain('直接按意图决策表创建');
    // 起点询问不是范围开放式提问。
    expect(prompt).toContain('不得把它变成对范围的开放式提问');
  });

  // AC2：推导理由写入计划，计划认可门呈现「从哪开始」而不只是「开始」。
  it('routes the derived starting point into startingPointReason so the plan-ack gate shows where the round starts', () => {
    expect(prompt).toContain('startingPointReason');
    expect(prompt).toContain('从哪里开始');
    expect(prompt).toContain('计划认可门');
  });

  // AC3（票 #10 修订）：他轮不再进推导卡；卡点描述移到点名续轮的选择卡。
  it('requires the named-continuation selection card to carry the stuck-point description', () => {
    expect(prompt).toContain('未完成轮');
    expect(prompt).toContain('选择卡');
    expect(prompt).toContain('每个选项带该轮目标与卡点');
    expect(prompt).toContain('待审数量');
    expect(prompt).toContain('所属会话或无主');
  });

  // AC4：接管被拒不裸报错，转述为用户可行动的下一步（用户故事 19）。
  it('requires relaying takeover rejections as actionable next steps instead of raw errors', () => {
    expect(prompt).toContain('takeover_geo_operation');
    expect(prompt).toContain('可行动的下一步');
    expect(prompt).toContain('裸报');
  });

  // AC5：推导只经 endingPhase 表达跨度，理由不碰确认门（入口智能 + 中间确定）。
  it('keeps derivation from rewriting the step sequence or moving any gate', () => {
    expect(prompt).toContain('跨度必须由 endingPhase 显式表达');
    expect(prompt).toContain('不增删确认门');
    expect(prompt).toContain('不移动任何确认门的位置');
  });

  // 起止推导（endingPhase）：起点询问同时裁决终点，一个轮次一张计划卡。
  it('settles the round end in the same starting-point question and never re-asks mid-round', () => {
    expect(prompt).toContain('起止推导');
    expect(prompt).toContain('到哪里结束');
    expect(prompt).toContain('endingPhase');
    expect(prompt).toContain('endingPointReason');
    // 终点之后不新起操作、不重复征询「接下来做什么」。
    expect(prompt).toContain('一个轮次从起点到终点只用一个操作');
    expect(prompt).toContain('不在轮内重复征询');
    // 用户目标已点名终点时不问，直接带上。
    expect(prompt).toContain('不问终点，直接带上');
  });
});

/**
 * ADR-0011 Decision 5 / 票 #33 回归：goal 措辞纪律——goal 必须与结构跨度
 * 一致，起点为知识链路时不得写「从问题选择开始」类矛盾措辞；起止如实经
 * startingPointReason/endingPhase 进入认可门文案。与 #30 的 next-step 条款
 * 同 PR 审读过：纪律只管创建时的叙事口径，放行后的门间推进仍照信封引述
 * 的 next-step 执行——两条分别锚定不同生命周期段，互不冲突。
 */
describe('keeps goal wording consistent with the structural span (ADR-0011, ticket #33)', () => {
  const prompt = buildSystemPrompt();

  // AC1：起点为知识链路时禁用「从问题选择开始」类矛盾措辞。
  it('bans question-selection wording when the round starts from the knowledge chain', () => {
    expect(prompt).toContain('goal 措辞纪律');
    expect(prompt).toContain('goal 的措辞还必须与计划的真实跨度一致');
    expect(prompt).toContain('起点为知识链路');
    expect(prompt).toContain('「从问题选择开始」');
    expect(prompt).toContain('与起点矛盾的措辞');
  });

  // AC1 后半：起止如实经 startingPointReason/endingPhase 进入认可门文案，
  // goal、认可门文案与跨度标签三处同跨度，不得两张皮。
  it('routes the truthful span through startingPointReason/endingPhase so goal, gate copy and span label agree', () => {
    expect(prompt).toContain('起止如实经 start_geo_operation 的 startingPointReason 与 endingPhase');
    expect(prompt).toContain('进入认可门文案');
    expect(prompt).toContain('三处必须是同一个跨度');
    expect(prompt).toContain('不得互相矛盾');
  });

  // 验收观察（#33 关单后修复）：「从哪里开始、到哪里结束、为什么」是起止推导
  // 段的认可门呈现事实，纪律条款只指路不复述——短语全提示词仅出现一次，
  // 防两段同短语漂移。
  it('keeps the gate-copy phrase single-sourced in the starting-point derivation paragraph', () => {
    const gateCopyPhrase = '从哪里开始、到哪里结束、为什么';
    expect(prompt.split(gateCopyPhrase).length - 1).toBe(1);
  });
});

/**
 * geo-plan-normalization 票 #06 回归：起点推导到创建/接管的映射与通信
 * 例外——提示词与归一后的服务端行为（票 02）零矛盾。「继续上轮」选项是
 * 接管语义（f74ce69e 实证断裂：选项是接管语义、模型却新建了操作），映射
 * 措辞强化到「唯一后续动作 + 新建是错误动作」；起点推导询问在「通信默认
 * 告知」条款中显式例外化，消除两条规则的现场优先级排序。
 */
describe('maps the starting-point picks to creation/takeover without contradiction (geo-plan-normalization, ticket #06)', () => {
  const prompt = buildSystemPrompt();

  // 决策表：选定「开新一轮」→ 创建首选显式带 updateKnowledge=false；
  // 归一兜底（首选非强制），但答案不得省略——省略与用户选择矛盾。
  it('states the preferred path for the start-new-round pick: carry updateKnowledge=false at creation', () => {
    expect(prompt).toContain('选定「开新一轮」');
    expect(prompt).toContain('updateKnowledge 传 false');
    expect(prompt).toContain('首选非强制');
    expect(prompt).toContain('归一为同一计划形状');
    expect(prompt).toContain('不得省略答案');
  });

  // 「继续上轮」→ 接管：票 #10 修订后入口从推导选项改为点名续轮路径
  // （查→选择卡→单次接管），新建仍是错误动作。
  it('maps the named continue-a-prior-round request to takeover as its only follow-up action', () => {
    expect(prompt).toContain('点名续轮是唯一例外');
    expect(prompt).toContain('唯一的后续动作就是单次调用 takeover_geo_operation');
    expect(prompt).toContain('新建操作是错误动作');
  });

  // 通信条款显式例外化：起点推导询问不按「阻塞且无安全默认」衡量，
  // 例外不得延伸到其他场合。
  it('lists the starting-point derivation question as an explicit exception in the communication clause', () => {
    expect(prompt).toContain('通信默认是告知');
    expect(prompt).toContain('显式例外');
    expect(prompt).toContain('不受「阻塞且无安全默认」门槛约束');
    expect(prompt).toContain('不得援引该例外');
  });
});

/**
 * geo-plan-normalization 票 #10 修订（2026-09-02 方向变更，用户裁决）：
 * 起点推导卡不再枚举任何其他会话的轮次——新会话只复用最新品牌资产，
 * 他轮的发现与接管全部收敛到「点名续轮」专用路径（查→选择卡→单次
 * 接管）。背景实测：摘要携带 4 个未完成轮时，选项构造与 4 选项上限
 * 数学冲突，effort 降档后仍有 17,742 字思考全花在「怎么取舍选项」上；
 * 消除裁量靠把信息撤出场，不靠禁令。派生席位按已确认产物链查表填空。
 */
describe('keeps other sessions\' rounds out of the derivation card (geo-plan-normalization, ticket #10 revision)', () => {
  const prompt = buildSystemPrompt();

  // 推导卡席位：固定两席（开新一轮/全量重来）+ 派生两席（查表填空）。
  it('fills derivation options by fixed slots with no on-the-spot trade-offs', () => {
    expect(prompt).toContain('起点题的选项按固定席位查表填空，不现场取舍、不展开备选方案权衡');
    expect(prompt).toContain('「开新一轮」（从已有问题池选择开始、不更新品牌知识）与「全量重来」（从知识更新开始）必须始终在列');
    expect(prompt).toContain('沿品牌级已确认产物链取最深下游入口与次深入口');
    expect(prompt).toContain('无已确认产物时不设派生席位，推荐「开新一轮」');
  });

  // 硬边界：派生选项只引用品牌级已确认产物；他轮待审工作集属接管语义。
  it('forbids deriving options from other sessions\' pending work', () => {
    expect(prompt).toContain('派生选项只引用品牌级已确认产物，绝不引用其他会话轮次的待审工作集');
    expect(prompt).toContain('起点推导不得考虑、提及或推荐任何其他会话的轮次');
    expect(prompt).toContain('新会话默认只复用最新的品牌资产（含最新知识版本）');
  });

  // 点名续轮路径：查→选择卡（哪怕单轮也列卡）→选定即整卡确认→单次接管。
  it('routes named continuation through query, one selection card, and a single takeover', () => {
    expect(prompt).toContain('includeUnfinishedRounds');
    expect(prompt).toContain('把查得的轮次（哪怕只有一轮）列成一张 AskUserQuestion 选择卡');
    expect(prompt).toContain('用户在卡上选定某轮即完成整卡一次确认');
    expect(prompt).toContain('单次调用 takeover_geo_operation');
    expect(prompt).toContain('查无未完成轮时如实告知并停，不创建任何东西');
  });

  // 旧机制防回归：推导选项即接管确认、按轮次分列的措辞不得回潮。
  it('does not regress to derivation-card takeover options', () => {
    expect(prompt).not.toContain('继续上轮');
    expect(prompt).not.toContain('接管信号');
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

  // ADR 0005 回归（票 03 修订口径）：材料请求卡的触发收敛为材料收集契约
  // （计划放行后执行到材料收集步骤即调用），知识状态限定词不再出现在调用
  // 现场；标准②的刻意排除保持——操作中途缺材料佐证不得打断，按来源层级
  // 推进交用户裁决。
  it('pins the material-collection contract, the plan-external entries and the mid-operation exclusion', () => {
    expect(prompt).toContain('材料收集契约');
    expect(prompt).toContain(MATERIAL_COLLECTION_CONTRACT);
    expect(prompt).toContain('计划外的合法入口只有两个');
    expect(prompt).toContain('用户明确表示要补充品牌材料');
    expect(prompt).toContain('不可直读的二进制品牌材料');
    expect(prompt).toContain('操作进行中不得因某个确认门缺材料佐证而调用');
    expect(prompt).toContain('按来源层级以 AI 补全行推进');
    // 知识状态限定词不得回归（票 03：不在调用现场重判知识是否够用）。
    expect(prompt).not.toContain('制定计划时品牌还没有已确认知识');
    expect(prompt).not.toContain('明显撑不起本次目标');
    expect(prompt).not.toContain('材料是否够用只在制定计划时判断一次');
  });

  // 认可门是唯一入口：放行前不得开始执行任何计划步骤，
  // 材料请求卡也不得提前发出；放行后按计划顺序、从第一步开始执行。
  it('keeps every plan step (including the material request card) behind the plan-ack gate', () => {
    expect(prompt).toContain('不得开始执行任何阶段');
    expect(prompt).toContain('一律等放行后按计划顺序执行');
    expect(prompt).toContain('先做什么取决于计划的第一步');
    expect(prompt).toContain('不得在放行前提前发出');
    // 契约首句承载「放行后执行到该步骤才发出」的时序语义。
    expect(prompt).toContain('计划放行后执行到材料收集步骤即调用材料请求卡');
    // 旧错误规则（与计划卡同回合发卡）不得回归。
    expect(prompt).not.toContain('必须在创建操作的同一回合调用 request_brand_material');
  });

  // GD-13 回归：所有闸门的操作入口统一为聊天内的交互卡片，
  // 卡片内容来自 agent 工具结果，右侧工作台只做结果展示。
  it('makes the in-chat gate cards the single entry for every confirmation', () => {
    expect(prompt).toContain('唯一的操作入口');
    // 多卡共存时方位指代会指错对象，入口指引不带「上方/下方」。
    expect(prompt).toContain("在聊天里对应的确认卡片上完成操作并确认");
    expect(prompt).not.toContain("在下方的确认卡片");
    expect(prompt).toContain("run_question_pool");
    expect(prompt).toContain("产品线取领域级");
    expect(prompt).toContain("自动取品牌已确认的领域");
    expect(prompt).toContain("品牌创建只需名称");
    expect(prompt).toContain("businessFocus");
    expect(prompt).toContain("plan_topics");
    expect(prompt).toContain("generate_articles");
    // 批准卡重新呈现走只读 get_article_operation，不允许靠重新生成找回卡片。
    expect(prompt).toContain("get_article_operation");
    expect(prompt).toContain("绝不能靠重新生成整批来找回卡片");
    expect(prompt).toContain("已确认竞品不足 5 家");
    expect(prompt).toContain("confirm_ranking_competitors");
    expect(prompt).toContain("工具只传这些 names");
    expect(prompt).toContain("服务端会绑定本 Session 的不足门、目标主体与最新持久化用户原话");
    expect(prompt).not.toContain("userInstruction 必须");
    expect(prompt).toContain("不要再次调用 generate_articles");
    expect(prompt).toContain("plan_distribution");
    expect(prompt).toContain("prepare_publish");
    expect(prompt).toContain("你没有发起的阶段不会有卡片");
    expect(prompt).toContain("工作台只做结果展示");
    expect(prompt).toContain("你无权跨越");
  });
});

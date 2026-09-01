# System Reminder Protocol

结构化确认门完成持久化决策后，Node Sidecar 路由在同一 Session 上投递一条隐藏 reminder（作为新用户回合、经 SDK 会话恢复唤醒 agent），使主聊天从权威结果继续。

`src/shared/systemReminder.ts` 是唯一 envelope builder。所有动态字段先做 XML escaping，数字归一为非负整数；payload 只携带 artifact/operation 的结构化标识、revision、数量与状态（如 planId、articleId、approvedRevision、assignmentCount），不复制正文或 secret；此外携带从持久化计划引述的 next-step（工具名 + 一句话指引，ADR-0011）——引述随信封 revision 防过期，不构成第二权威，信封仍是收据。

决策回执覆盖五个确认门，指令语义一致：「从权威结果继续，不重复询问已裁决内容；按信封引述的 next-step 执行，不现场推导」：

- `XIAOJING_KNOWLEDGE_DECISION`：知识单条与批量裁决（`knowledge/decide`、`knowledge/decide-batch`）。
- `XIAOJING_QUESTION_POOL_DECISION`：问题池确认（`question-pools/confirm`）。
- `XIAOJING_TOPIC_PLAN_DECISION`：选题计划确认（`topic-plans/confirm`）。
- `XIAOJING_ARTICLE_APPROVAL_DECISION`：文章批准门（`articles/approve`），批准后继续进入渠道分发规划。
- `XIAOJING_DISTRIBUTION_PLAN_DECISION`：分发计划确认（`distribution-plans/confirm`），确认后继续进入发布准备。

发送顺序固定为：

1. Rust owner 提交决策并返回成功的 exact revision。
2. Node 路由经 `sendXiaojingMessage`（`xiaojing-reminder-send.ts` 单出口）在同一 Session 投递隐藏 envelope；没有 visible tail。
3. Agent 重新读取对应 owner，按信封引述的 next-step（基于该 revision 的计划快照）执行下一步；引述过期时以重读结果为准。

Renderer 投影：决策回执 reminder 会作为用户消息进入 transcript（Agent 需要读到信封原文才能继续），聊天流里由 `parseDecisionReminderText`（`src/shared/systemReminder.ts`）识别「整条消息就是一个决策回执信封」的用户消息，在 `Message.tsx` 投影成自然语言气泡（如「认可本次计划」），并打上 `data-system-reminder` 标记；XML 扁平文本与 UUID 不进入可见 UI。解析失败或真实用户输入回落普通用户气泡，信封原文始终保留在 transcript 中供 LLM。

Reminder 不是持久化 authority、队列或重试日志。提交失败时不得发送；重复投递也不能绕过 idempotency/revision 检查。提醒入队失败不回滚已提交的决策，路由响应显式返回 `notificationQueued` / `notificationError` 状态。

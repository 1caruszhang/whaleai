# 进度卡承载计划级认可门，plan-ack 是唯一挂在操作卡本体的确认面板

聊天进度卡此前只播报权威阶段/步骤计划并承载生命周期控制（暂停/恢复/重试/取消），「认可这份计划」没有显式动作：用户的意图即授权，范围裁剪靠换意图重新发起。为补上放行前的显式确认，每个可执行计划的首步改为合成的 `acknowledge-plan` 步骤，携带 `plan-ack` typed confirmation（authority `geo-operation`，借首个工作步骤的 capability 落进开头阶段）。操作创建即整单停靠在计划认可门；用户在进度卡的 `GeoPlanAckPanel` 上一次点击放行整份计划，走既有 `/api/xiaojing/geo-operations/confirm-step` 端点与 revision CAS，路由随决策投递 `XIAOJING_GEO_OPERATION_EVENT` reminder 唤醒 agent 从第一阶段继续。放行不裁决任何阶段产物：各阶段仍停在各自的产物门，`AUTO_CONFIRMABLE_CONFIRMATION_KINDS` 不收 `plan-ack`，任何自治档位下都保持用户所有。

计划仍是意图的确定性编译产物（纯 policy），不是 agent 现场撰写、可自由 replan 的清单；`decide-knowledge-refresh` 未决分支是唯一没有认可门的计划（它本身就是决策步），`choose_next_round_knowledge` 的显式回答即计划放行——replace-plan 在 service seam 剥离认可门，替换后的计划直接从首个工作步骤开始，不产生第二次停靠。

## Considered Options

- **并入通用 plan-and-execute 引擎（agent 拥护计划、自由 replan）**：被否决。revision CAS、execution generation、checkpoint、crash recovery、各产物门 owner 裁决全部按固定 step id/capability 键入，计划漂移即失去锚点；且 `geo_operations.md` 明确不建通用 Workflow Engine。
- **把 plan-ack 挂在首个工作步骤上**：被否决。`confirm-step` 会把该步骤直接置为 succeeded，等于跳过工作；必须是独立合成步骤（与 `decide-knowledge-refresh` 同型）。
- **只改 UI（卡片加无后端的按钮）**：被否决。没有持久化确认就没有审计与 reminder 唤醒，agent 无法从权威结果续跑。
- **受约束的计划裁剪门（放行前增删阶段）**：暂缓。需求出现时作为独立 gate 接入，不与认可门混作一步。

## Consequences

- 每次操作多一次点击；换来放行前的显式 human ack 与完整的审计/唤醒链路。ADR 0003 的方向（减少无效确认、保留实质裁决）不受影响——认可门裁决的是「是否放行这份确定性计划」，与产物裁决正交。
- 下一轮优化只经历一次放行语义：聊天里显式回答「是否更新知识」即视为计划放行，replace-plan 剥离认可门后直接执行；用户不会遇到两次连续停靠。
- 若 agent 违反纪律在放行前开始执行业务动作，owner 侧提交仍会成功，但 milestone 推进按状态机安全空转（begin/confirm 被拒并跳过），操作投影停留在认可门；纪律约束在系统提示词与 `start_geo_operation` 工具描述中。
- 跨语言枚举（TS union 与 Rust `CONFIRMATION_KINDS`/`CONFIRMATION_AUTHORITIES`/kind-authority 配对）新增 `plan-ack`/`geo-operation`，由 shared 契约测试与 Rust 状态机测试双向锁定。
- 认可面板的位置沿用知识确认卡「整卡确认常驻卡头、不藏在长列表底部」的既定原则（DESIGN.md 信息闸门卡片）：停靠在认可门时 `GeoPlanAckPanel` 渲染在进度卡卡头（目标行之后、步骤重播之前），19 步重播保留在其下方供放行前审阅；其余闸门面板仍在卡尾。认可卡与其他确认卡（如附件导入产出的知识确认卡）同回合共存时的先后说明由系统提示词约束：先放行计划，知识确认是第一阶段第一道门，先裁决任一门都不阻塞；卡片指引文案不用「上方/下方」方位指代。

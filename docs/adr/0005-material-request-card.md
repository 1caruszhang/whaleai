# 材料上传入口从输入区常驻区域改为 agent 判断唤起的材料请求卡

品牌知识确认后，挂在聊天输入框上方的常驻「导入品牌材料」区域（`XiaojingChatMaterialImport`，票 27 的产物）只剩噪音价值。决定删除该区域：用户发起上传的唯一入口改为 agent 经新工具 `request_brand_material` 在聊天流里发出的**材料请求卡**（工具结果带 `material-request-card` kind，走既有工具结果投影管线），卡头一行 agent 撰写理由，卡体保留文件选择/粘贴文本/官网 URL 三条路径与进行中行轮询。卡片锚定在发起那轮消息、随 transcript 持久，重放即重挂载、重挂载即恢复轮询——进行中导入的恢复不再依赖任何 renderer 侧显隐条件（无机械 override、无 shared 显隐纯函数）。冷启动零消息空态不显示任何入口，由 `ChatStarterSuggestions` 增补材料引导语承接；随区域一并删除 pending Session 提交禁用逻辑（卡片只存在于真实会话之后）。

唤起标准写入系统提示词硬规则：① 制定计划时品牌无已确认知识或明显过薄；③ 用户带来二进制附件、受限读取无法处理；④ 用户明确要求补材料。标准②（操作中途闸门缺材料佐证）**刻意排除**：中途不打断，按来源层级以「AI 补全」行推进、用户裁决兜底；材料充分性只在计划时点判断一次。

## Considered Options

- **操作闸门 confirmation kind（plan-ack 模板）**：被否决。闸门寄生操作生命周期，覆盖不了操作外场景；要改 TS union 与 Rust `CONFIRMATION_KINDS` 双侧枚举；且 `GeoOperationGatePanels` 对 `brand-material-import` 刻意返回 null——票 27 已把导入发起从操作闸门搬出过，走此路等于两头翻旧决定。
- **system reminder 通道**：被否决。协议投递顺序写死「先提交决策、后发回执」，builder 只在 Node 路由、agent 无发射工具；借道做 agent 主动请求要反转协议语义，且反正得加新工具。
- **保留区域 + 机械显隐条件（无知识/有进行中导入）**：被否决。动机是知识确认后去噪音，机械条件只解决一半；区域是 `/materials/status` 唯一轮询者，瞬态生命周期与恢复语义互相纠缠，比 transcript 持久卡片更脆。

## Consequences

- 可发现性代价：用户想主动补材料必须先在聊天里开口（标准④兜底）；卡片随消息上滚，与知识确认卡同款先例。
- 票 27 的决定被部分推翻：真实用户入口仍在聊天内、工作台仍无材料面板不变，但「输入框上方常驻」的形态与「常驻即显」的触发被本 ADR 取代。
- 无 SSE 白名单、无 Rust 枚举改动；`system-prompt.ts` 二进制引导、`read_session_file` 失败提示、session-files reminder 图例、`run_question_pool` 报错四处旧文案与新工具描述同步改写。

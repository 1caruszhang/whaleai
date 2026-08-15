# 关键词 / 问题池不变量

## Owner 与身份

- Node `QuestionPoolService` 拥有挖词、生成与评分的业务编排，只使用 Ticket 05 的 `keyword-search` / `generation` / `embedding` typed ports。
- Rust `BrandWorkspaceStore` 拥有知识快照读取、pool / attempt / checkpoint / decision 持久化与 CAS。它们和 Ticket 06/07 的品牌状态位于同一 `project.sqlite`，不形成第二套品牌权威。
- Renderer 只是当前 Tab/Session 的投影；所有请求经 `useTabApi().apiPost`，必须同时携带 `workspaceId` 与已固化的 `sessionId`。
- pool identity 是 `knowledge_version + product_line + target_region + generation_parameters`。只有全部相同的 awaiting-selection / confirmed pool 可复用。

## 生成与评分

1. `keyword-search` 返回 core / scene / longtail 分类。地域提示要求目标城市及 3–5 个直属下级地域；解析后用品牌精确标识做确定性过滤。过滤后为空必须失败为 `question_pool_empty_keywords`。
2. `question-generation` 只从过滤后关键词生成问题；每个候选必须至少有一个 `sourceKeywords` 与当前真实挖掘词精确匹配。缺失或全部无效的候选直接剔除，不允许用其他关键词回填来源。
3. `embedding` 为问题、当前知识上下文与最近一批已选问题生成向量。PRED-1 的可追溯记录为：

```text
relevance             = round(clamp(max(0, cos(question, knowledge)) * 100, 0, 100))
recentPoolSimilarity  = round(clamp(max cos(question, recent selected), -1, 1) * 100)
optimizationPotential = round(clamp((1 - max cos(question, recent selected)) * 50, 0, 100))
priorityTotal         = relevance + optimizationPotential
high                  = priorityTotal >= 150
medium                = 100 <= priorityTotal < 150
low                   = priorityTotal < 100
```

当没有最近选中池时，nearest cosine 按 `0` 计，因此 `recentPoolSimilarity = 0` 且 `optimizationPotential = 50`。每题持久化三个原始分量、sum、阈值、formula 与 `policyVersion=js-ai-dev-pred-1-v1`，修改阈值必须升级 policy version。

## Checkpoint、取消与确认

- 阶段固定为 `keyword-search -> question-generation -> embedding -> persist`，不是可扩展的通用工作流。
- `idempotency_key` 定位 attempt；`attempt_id + stage` 定位 checkpoint；`attempt_id:stage` 是稳定 billing key。每次 claim 记录 input hash、attempt number 与一次性 claim token，finish 使用 token CAS。
- completed checkpoint 必须返回缓存输出，不重复调用 Provider；重试只重新 claim 当前 failed stage，已成功的付费阶段不重复计费。
- 取消同时 abort 当前 Provider signal 并把 attempt/checkpoint 标记为 cancelled。
- 用户勾选、编辑、删除、新增的结果以 `confirm-selection` decision 附加写入，并用 expected revision CAS。已有 decision 的 pool 不可再 persist 或覆写。Sidecar 只投送带固定 tag 的隐藏结构化 event，不生成可见 user message。

## 测试边界

Provider 单测必须使用 fake/stub，不访问网络、凭据或付费端点。Rust 测试覆盖 identity/reuse/version/CAS；Node 测试覆盖 typed-port 编排和阶段重试；DOM 测试覆盖真实工作台入口与结构化增删改选。

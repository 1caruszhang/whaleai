# Xiaojing 架构总览

本文是小鲸同学当前 owner、进程边界和主数据流的权威说明。实现细节和事故约束位于 `specs/tech_docs/`。

## 项目定位

小鲸同学是桌面 GEO 营销工作台。产品有四个一级入口：

- 主聊天：用户与唯一内置 Agent 交互，过程推进、确认与操作控制都在聊天侧。
- 品牌工作台：聊天右侧的权威产物投影，按六阶段骨架只读展示品牌事实、问题池、选题、文章、分发、发布与监测产物。
- 品牌档案：左侧栏品牌级整页，只读展示知识版本史与已批准产物血缘。
- 效果：左侧栏品牌级整页，承载按需基线探测、监测管理与真实效果看板。

应用不提供通用 Agent 管理、扩展管理、外部执行器、通讯频道、桌面宠物、全局检索或独立任务产品面。

## 进程与通信

```text
React renderer
  ├─ Tauri IPC ────────────────┐
  ├─ Rust HTTP/SSE proxy ──┐   │
  └─ registered attachments│   │
                           ▼   ▼
                     Tauri/Rust app
                     ├─ window + lifecycle
                     ├─ SessionSidecarManager
                     ├─ Session/BrandWorkspace stores
                     ├─ workspace file service
                     ├─ provider admission
                     ├─ notification/deep-link routing
                     └─ hidden GEO scheduler
                           │
                           ▼
                 one Node Sidecar per Session
                 ├─ Claude Agent SDK query
                 ├─ xiaojing-geo product tool
                 └─ GEO domain services
```

Renderer 的普通 HTTP/SSE 控制面必须经 Rust。只有 `/refs/:id` 和 `/attachment/*` 是明确登记的大载荷数据面；新增例外必须同时更新 CORS、CSP、大小与路径安全测试。

## 核心 owner

| 事实/生命周期 | 决策 owner | 持久化或执行 owner |
|---|---|---|
| 品牌共享事实和批准产物 | GEO domain policy | Rust `BrandWorkspaceStore` |
| 聊天历史和 Session-private 工作 | Session runtime | Rust Session store + Session Sidecar |
| 一次 GEO 动作 | GEO service | `GeoOperation` records in BrandWorkspace |
| 工作区文件 | workspace path policy | Tauri workspace commands |
| 账号登录态与 token（票 06 起） | account admission policy | Rust account owner（OS 凭据库 + config 投影） |
| Provider 全局并发 | provider capability policy | Rust FIFO limiter |
| 定时发布 | publish policy | Rust `PublishScheduler` |
| 发布后监测 | monitoring policy | Rust hidden monitor scheduler |
| UI 状态 | renderer view model | React memory only |

后产生的数据不会自动获得其他 owner 的写权限。跨表示转换、比较与写回必须经过对应 owner 的现有入口。

## Session 与 Sidecar 生命周期

`Session : Sidecar = 1 : 1`。仅以下 token 能持有 Session Sidecar：

- `Tab`
- `BackgroundCompletion`
- `GeoMonitor`
- `PublishExecutor`（票 08 起：Rust 确定性发布执行器借用执行来源 Session 的 Sidecar 走网关 egress port，同监测调度器的隐藏调度 attach 模式）

全部 token 释放后才停止进程。每个 generation 有自己的 dispatch gate；manager 在锁内关闭准入和确认 generation，在锁外等待请求排空、停止进程和完成资源释放。崩溃恢复保留逻辑 owner，但旧 generation 的迟到结果不能提交新状态。

Sidecar 使用应用内置 Node 启动。管理端口、generation、Session identity 和 workspace path 由 Rust 注入；Node 不通过用户目录、端口文件或 renderer 参数猜测身份。应用退出先关闭新的 lifecycle birth，再停止全部已登记进程。

## 数据与凭据边界

`BrandWorkspace` 是共享品牌业务边界，`Session` 是聊天和执行上下文边界。一个 Session 可以创建多个 `GeoOperation`，多个 Session 可以并发读取同一品牌的已确认事实和批准产物。未确认的问题、计划、草稿与运行状态只属于创建 Session。

Rust 分别拥有：

- Xiaojing 应用数据根、日志根和 Session 元数据；
- BrandWorkspace SQLite 与材料/产物文件；
- config 写盘合并；
- 工作区文件原子 IO；
- OS credential store 和 Provider admission。

首版只使用 Xiaojing 自己的数据目录、协议和 schema，不读取、迁移或删除其他产品目录。真实凭据不得进入 renderer、数据库、transcript、日志、构建产物或测试夹具。

### 品牌删除

用户可以删除整个品牌：`preview_workspace_deletion` 在品牌库内登记一次性 admission token 并汇总删除范围；`cmd_brand_workspace_delete` 在全部品牌 Session 的 lifecycle fence 内复用会话删除的 owner/busy 谓词（任一 Session 有持久 owner、不可释放 Tab 或忙碌 Sidecar 即拒绝），随后删除这些 Session 的 transcript、释放 Tab owner、从 `brands.json` 目录移除品牌并删除整个工作区目录（SQLite、材料、产物、媒体）。intent 存放在被删品牌自己的库内，随目录一起消失。目录删除先改目录登记再删文件：失败时留下无登记的孤儿目录，可安全重试。Provider 凭据是应用级存储，不随品牌删除。

## GEO 数据流

```text
material import
  → candidate facts
  → explicit knowledge decision
  → question pool
  → confirmed topic plan
  → article revisions + approval
  → distribution plan + confirmation
  → deterministic publish queue
  → hidden post-publish monitoring
  → real GEO dashboard
```

主链（full-optimization，含计划认可门）共 19 步，不内嵌基线探测。每个可执行计划创建后先停在计划认可门，由用户在聊天进度卡上一次放行；各阶段产物仍停在各自的确认门。基线探测是品牌级「效果」入口内的按需动作：监测计划启用前必须先在那里冻结一次基线；效果看板只聚合真实基线与逐轮监测证据。

每个阶段持久化 immutable input identity、版本、来源、尝试和裁决。真实 Provider 缺失或失败时返回 unavailable/failed，不生成模板值、伪证据或随机成功。付费发布必须显式确认，并使用稳定幂等键、claim/lease 与人工核对状态。

GEO 能力只通过固定 typed ports 暴露：主 Agent、抽取、关键词检索、生成、反思、向量化、对象存储和分发。所有重型调用先取得 Rust 应用级 permit。Renderer 只看到非 secret 的 catalog/status。

## UI 边界

主聊天是唯一 Agent 入口。品牌工作台是同一窗口内的只读产物视图，不创建新的执行器概念。需要用户决策的知识确认、计划确认、批准、付费发布和安全重试必须由结构化 UI 触发；模型不能代替确认。唯一例外是 ranking 在开始前明确发现已确认竞品不足 5 家：Session Sidecar 保存一次待补充门并绑定原文章请求、品牌主体和当时最新用户消息，该状态跨每轮重建的 MCP server 存续，同请求重试不移动原签发边界，但部分采纳后边界推进到刚消费的用户消息（同一条消息不得授权多轮采纳）；后续用户可在当前聊天直接说出并确认补充名称，MCP 只接收名称，Node 从 Gate 取主体并逐字核对最新持久化用户消息与名称后才映射成 `asked/user-stated` 的 KnowledgeAuthority 提议与采纳，模型推断或搜索结果不得借此自动确认；补足后工具直接恢复原文章请求。左侧栏「品牌档案」与「效果」是品牌级整页入口：品牌档案只读展示知识版本史与产物血缘；按需基线探测、监测计划的显式启用门与真实效果看板都从「效果」进入。监测调度 owner 仍留在 BrandWorkspace，该入口只做只读展示与显式启用。

「效果」页的数据通道按读写拆分（2026-08-19 拍板）：真实投影读取（最新基线 `cmd_geo_baseline_latest_ui`、监测计划 latest/get `cmd_post_publish_monitor_*_ui` 可选 sessionId、最新发布执行 `cmd_publish_execution_latest_ui`）走 Rust IPC 免会话直读——这些查询本就是 workspace 级，不要求借用聊天 Tab 的 Session；基线探测执行、引擎可用性读取和监测 prepare/activate/retry 等执行类控制面仍借用该品牌已打开聊天 Tab 的 Session Sidecar owner 身份，未打开会话时以提示条引导，不新建第二个 Agent 入口。

桌面通知只针对主聊天完成和 GEO 监测告警。点击通知通过精确 Session/BrandWorkspace/operation identity 深链，不提供模糊的全局跳转。

## 构建与运行基础设施

最小发行基础设施包括：Tauri app/window、内置 Node、Claude Agent SDK sidecar binary、前端和 Sidecar bundle、CSP、代理、日志、图标及平台运行依赖。Windows 内测只允许 x86_64-pc-windows-msvc、NSIS current-user 与固定摘要资源；内部候选明确未签名，生产签名通过独立 overlay 和 CI 环境 admission fail-closed。仓库仍没有发布上传、更新通道或更新端点配置，签名材料也不进入配置、日志或构建产物。

## 模块路由

- 进程、边界 helper：`pit_of_success.md`
- Session/恢复：`session_architecture.md`、`sidecar_cold_start.md`
- 提示词：`system_prompt_architecture.md`、`system_reminder_protocol.md`
- Provider 与 GEO 契约：`geo_port_contract.md`、`geo_provider_capabilities.md`、`geo_operations.md`
- 各业务阶段：`material_import.md` 至 `real_geo_dashboard.md`
- 文件与附件：`tool_attachment_pipeline.md`
- Windows：`windows_platform.md`
- 代理、日志、内置 Node：`proxy_config.md`、`unified_logging.md`、`bundled_node.md`

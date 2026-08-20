# Jingshan GEO — Desktop GEO Workbench

鲸杉geo（Jingshan GEO）是基于 Tauri v2 与 Claude Agent SDK 的桌面 GEO 营销工作台。使用 Conventional Commits；不得提交密钥、令牌或用户隐私数据。

## 权威来源

1. API、版本、脚本、文件名和可执行约束以代码、类型、测试、lint 配置和 `package.json` 为准。
2. Owner、进程边界与数据流以 `specs/ARCHITECTURE.md` 为准。
3. 模块不变量与 helper 用法以对应 `specs/tech_docs/` 为准。
4. `.scratch/` 中的 issue 只解释历史验收上下文，不能覆盖现行实现。

若文档与代码冲突，先用实现、测试和 git 历史确认现状，再修正文档。

## 工作方法

1. 先判断任务影响的 owner、进程边界和权威数据源，再读取匹配文档。
2. 用 `rg` 搜索同类实现、调用方、测试和已有 helper，沿既有路径扩展。
3. 对接 Claude Agent SDK 时，先核对已安装版本的 `sdk.d.ts`、`sdk-tools.d.ts` 与官方文档，不凭记忆猜接口。
4. 先修 owner/scope 错位，再考虑 cache、guard、retry 或 wrapper。若需要新状态 owner、进程类型或通信模式，先与用户讨论架构。

## 项目地图

| 区域 | 职责 |
|---|---|
| `src/renderer/` | React 19 + TypeScript + Vite 桌面 UI；主聊天与品牌工作台 |
| `src/server/` | Node.js v24 Session Sidecar；Claude Agent SDK 与 GEO 领域服务 |
| `src/shared/` | renderer/server 共用的纯类型和策略 |
| `src-tauri/` | Tauri v2 壳、进程 owner、持久化、代理、工作区 IO、通知和 GEO 调度 |
| `specs/` | 当前架构、设计规范、模块技术文档与构建指南 |

Sidecar 与 SDK 子进程使用应用内置的 Node.js，不依赖用户系统安装的 Node。

## 常驻架构心智模型

### Owner 与 authority

Owner 必须针对具体事实、scope 与 lifecycle phase 定义。`BrandWorkspace` 拥有共享品牌事实和批准产物；`Session` 拥有聊天上下文与未确认工作；`GeoOperation` 拥有一次 Session-private 操作。Renderer 只持有 projection，不反写权威状态。

### Session 与 Sidecar

- `Session : Sidecar = 1 : 1`。仅 Tab、后台补全和 GEO 监测持有 Sidecar owner token；全部释放后才停止进程。
- Chat Tab 独立隔离，请求使用 `useTabState()` 的 `apiGet`/`apiPost`，不能误发到其他 Session。
- `messageGenerator()` 是常驻 generator；中止走 `abortPersistentSession()`。
- Session 创建与复用只服从 `ensureSessionSidecar` 锁内结果，不能用事前端口探测猜测。

### 通信与持久化

- Renderer/Sidecar 控制面 HTTP/SSE 经 Rust 转发，localhost client 使用 `crate::local_http`。
- 只有已登记的 `/refs/:id` 与 `/attachment/*` 是原生 fetch 大载荷数据面，并同时满足 CORS、CSP、大小和路径约束。
- 新 SSE JSON 事件必须加入 renderer 白名单。
- BrandWorkspace SQLite、Session 元数据、配置、工作区文件和凭据各有独立 owner；不能用 React state 覆盖磁盘事实。
- Provider 凭据只由 Rust admission 注入当前 Session Sidecar，不能进入 renderer、日志、数据库或构建产物。账号登录 token（commercial-beta，票 06 起）只存 OS 凭据库与 Rust 进程内存；admission 改为注入运营网关地址 + 账号 access token，renderer 只拿登录态/余额投影，拿不到 token 本体。admission env token 只是启动兜底：Rust 发往 Sidecar 的控制面请求统一附 `x-xiaojing-account-token` 头携带当前新鲜 token（按 exp 临期自动 refresh，单飞轮换），Sidecar 头优先、无头回退 env。
- 监测调度仍由 BrandWorkspace owner 驱动，但以品牌级「效果」入口呈现（只读展示 + 显式启用门），不形成第二个 Agent 入口。主链不内嵌基线探测；基线在「效果」入口按需执行，监测启用前必须先冻结一次基线。

## 文档路由

设计、评估、重构、跨模块/进程、Session/Sidecar/owner 变更先读 `specs/ARCHITECTURE.md`。其余只读命中的模块文档：

| 范围 | 必读文档 |
|---|---|
| 可执行护栏、进程和跨语言边界 | `specs/tech_docs/pit_of_success.md` |
| Sidecar 冷启动 | `specs/tech_docs/sidecar_cold_start.md` |
| Session 状态、恢复与配置 | `specs/tech_docs/session_architecture.md` |
| 系统提示词和逐轮提醒 | `specs/tech_docs/system_prompt_architecture.md`、`specs/tech_docs/system_reminder_protocol.md` |
| Provider admission 与能力槽位 | `specs/tech_docs/geo_provider_capabilities.md` |
| BrandWorkspace/GEO 领域能力 | 对应 `specs/tech_docs/geo_*.md`、`material_import.md`、`knowledge_authority.md`、`question_pool.md`、`topic_planning.md`、`article_generation.md`、`distribution_planning.md`、`publish_scheduler.md`、`post_publish_monitoring.md` |
| 工作区文件、附件与外部 URL | `specs/tech_docs/tool_attachment_pipeline.md` |
| 前端 UI、布局与交互 | `specs/DESIGN.md`；React effect 再读 `specs/tech_docs/react_stability_rules.md` |
| Windows、CSP、WebView 与进程 | `specs/tech_docs/windows_platform.md` |
| 内置 Node、代理、日志与 i18n | `specs/tech_docs/bundled_node.md`、`proxy_config.md`、`unified_logging.md`、`i18n_architecture.md` |

## 验证与共享工作区

- 修改后运行与影响面匹配的最小确定性验证；Bug 修复增加回归测试。默认测试不得依赖真实网络、真实密钥或真实用户目录。
- 工作区可能有其他 Session 的未提交改动。开始和交付前检查 `git status`，只修改任务需要的文件，不回滚、覆盖或清理别人的改动。
- 不使用 `git add -A`、`git add .` 或 `git add -f`。不在 `main` 直接提交；合并、发布或打 tag 需要用户明确授权。
- Rust 工具链版本以 `rust-toolchain.toml` 为准，避免浮动工具链产生无关 diff。

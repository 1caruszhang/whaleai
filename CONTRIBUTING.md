# Contributing to WhaleAI / 参与 WhaleAI 开发

WhaleAI is the private development repository for the current MyAgents-based desktop Agent codebase. The application and package identifiers remain `MyAgents` / `myagents` until a complete migration is implemented.

## 中文

### 开始之前

1. 阅读 [`CLAUDE.md`](CLAUDE.md) / [`AGENTS.md`](AGENTS.md)。
2. 根据任务范围阅读 [`specs/ARCHITECTURE.md`](specs/ARCHITECTURE.md) 和命中的 `specs/tech_docs/` 文档。
3. 搜索现有实现、调用方、测试和 helper，沿已有 owner 与数据流扩展。
4. 涉及外部 SDK 时，以已安装版本的源码、类型与官方文档为准。

仓库入口：<https://github.com/1caruszhang/whaleai>

### 本地环境

```bash
git clone git@github.com:1caruszhang/whaleai.git
cd whaleai
npm ci
npm run typecheck
```

完整桌面开发环境请运行：

```bash
./setup.sh
./start_dev.sh
```

Rust toolchain 由 [`rust-toolchain.toml`](rust-toolchain.toml) 固定，不要使用浮动工具链制造无关格式化差异。

### 分支与提交

- 不在 `main` 直接开发；使用 `feat/...`、`fix/...`、`docs/...` 或 `agent/...` 分支。
- 使用 Conventional Commits，例如 `feat: add ...`、`fix: handle ...`、`docs: clarify ...`。
- Commit 除 subject 外必须有非空正文，说明为什么修改以及关键取舍。
- 只暂存任务范围内的文件；禁止使用 `git add .`、`git add -A` 或 `git add -f` 扩大范围。
- 不覆盖、回滚或清理其他会话留下的工作区修改。

### 测试要求

选择与影响面匹配的最小确定性验证，并在提交前运行：

```bash
npm run typecheck
npm run lint
npm run test:classification
npm run test:unit
```

按改动范围追加：

```bash
npm run test:dom           # React 组件、Hook、浏览器行为
npm run test:integration   # Server、Session、Runtime、IO、安全边界
npm run test:geo-contract  # GEO 契约、算法与确认语义
npm test                   # 默认完整测试套件
```

Bug 修复应先加入能复现问题的回归测试。默认测试不得依赖真实网络、真实密钥或真实用户目录；`npm run test:credentialed` 只能在明确配置测试凭据后手动运行。

### 架构与代码要求

- 先确认谁创建、持久化、修改、释放和裁决相关状态。
- 修复 owner 或 scope 错位，不用 cache、guard、flag 或 retry 掩盖错误边界。
- Chat Tab 使用 tab-scoped API；Global surface 不得误接 Session Sidecar。
- Runtime 操作统一经过 `src/server/session-engine/`。
- 工作区文件 IO 统一经过 Tauri/Rust owner。
- 新增 SSE JSON 事件时同步更新 Renderer 白名单。
- 不 suppress lint 或依赖边界错误；修复违规原因。

### GEO 变更

GEO 代码必须以 [`src/shared/geo/portContract.ts`](src/shared/geo/portContract.ts) 为行为基线，并阅读 [`specs/tech_docs/geo_port_contract.md`](specs/tech_docs/geo_port_contract.md)。如果需要改变 owner、人工确认门、评分阈值、渠道召回、发布权限或模型路由，应先更新架构决策和 parity tests，而不是静默改变行为。

### 安全与隐私

不要提交：

- `.env`、API key、OAuth token、Cookie、私钥或真实 Provider 凭据；
- 用户会话、日志、客户数据、个人邮箱、真实工作区绝对路径；
- `.scratch`、研究草稿、演示数据或本地生成产物；
- 未确认可再分发的第三方二进制或素材。

漏洞请按 [`SECURITY.md`](SECURITY.md) 私密报告，不要创建公开 issue。

### Pull Request

PR 描述至少说明：

- 修改了什么以及为什么；
- 影响的 owner、进程边界和用户行为；
- 关键取舍与未覆盖范围；
- 已运行的验证及结果；
- 涉及 UI 时附带截图或录屏。

## English

Before contributing, read [`CLAUDE.md`](CLAUDE.md), [`specs/ARCHITECTURE.md`](specs/ARCHITECTURE.md), and the relevant module documentation. Follow existing owners and data flows, use Conventional Commits with a non-empty explanatory body, stage only intended files, and run checks proportional to the change.

Never commit credentials, user data, logs, local paths, `.scratch` material, or unrelated external assets. Default tests must not depend on real networks, credentials, or user directories. Security reports must follow [`SECURITY.md`](SECURITY.md).

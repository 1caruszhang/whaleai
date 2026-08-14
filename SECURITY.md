# Security Policy / 安全策略

## 中文

### 支持范围

WhaleAI 当前是私有开发仓库。安全修复优先落在 `main` 的最新代码；历史构建和未维护分支不承诺单独回补。

### 私密报告漏洞

请不要为未修复漏洞创建公开 issue、Discussion 或 Pull Request。

优先使用 GitHub 的私密安全通告入口：

<https://github.com/1caruszhang/whaleai/security/advisories/new>

报告应尽量包含：

- 受影响版本、commit 或分支；
- 可复现步骤和最小 proof of concept；
- 实际影响、攻击前提和数据边界；
- 已知缓解方法；
- 报告者希望使用的署名方式。

不要在报告中附带真实用户数据、生产密钥、完整访问令牌或不必要的客户资料。必须提供敏感证据时，先提供脱敏样例并等待维护者确认传输方式。

### 重点安全边界

- API key、OAuth token 和 Provider 凭据只能进入现有本地安全存储，不得写入代码、日志或测试 fixture。
- Renderer 与 Sidecar 的普通 HTTP/SSE 控制面必须经过 Rust；大载荷直连只适用于已登记端点。
- 工作区路径和文件操作由 Tauri/Rust owner 裁决，必须维持路径穿越和符号链接防护。
- 外部 URL、附件、媒体和 MCP 配置必须经过 SSRF、大小、协议与来源检查。
- 默认测试必须阻断真实网络，不读取真实用户目录或真实凭据。
- 日志、截图、issue 和诊断包必须先移除 token、邮箱、绝对路径、会话内容与业务数据。

### 响应流程

维护者会确认报告是否可复现、评估严重性、协调修复与披露时间，并在修复可用后通知报告者。复杂漏洞的修复时间取决于影响面和发布风险；在双方约定披露时间前请保持信息私密。

## English

WhaleAI is currently a private development repository. Security fixes target the latest `main` branch; historical builds and inactive branches are not guaranteed separate backports.

Do not open a public issue, discussion, or pull request for an unpatched vulnerability. Use GitHub's private advisory flow:

<https://github.com/1caruszhang/whaleai/security/advisories/new>

Include the affected revision, reproduction steps, minimal proof of concept, impact, prerequisites, and known mitigations. Never attach real user data, production credentials, complete access tokens, or unnecessary customer information.

Credentials must remain in the existing local secure storage. Renderer/Sidecar control traffic, workspace paths, external URLs, attachments, MCP configuration, logs, and default tests must preserve the security boundaries documented in [`specs/ARCHITECTURE.md`](specs/ARCHITECTURE.md) and [`specs/tech_docs/pit_of_success.md`](specs/tech_docs/pit_of_success.md).

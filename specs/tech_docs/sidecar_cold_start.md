# Session Sidecar Cold Start

冷启动目标是让一个 BrandWorkspace Session 尽快达到可接收 turn 的 readiness，同时保持完整 authority。

## 启动路径

1. Rust 在 per-Session lifecycle fence 内预留 generation。
2. 从内置资源定位 Node 与 `server-dist.js`。
3. 注入 Session/workspace identity、management port、generation、代理策略和通过 admission 的 Provider secret。
4. Node 只组合聊天、Session 读取和 `/api/xiaojing/*` route。
5. readiness handshake 成功后 Rust 发布端口并交付 dispatch lease。

没有共享 Sidecar、系统 Node fallback或页面级预热假象。pre-warm 与普通创建复用同一条真实路径。

## 性能规则

- bundle 顶层不得初始化未使用的 GEO Provider 客户端。
- BrandWorkspace SQLite 和附件处理在首次业务调用时打开。
- readiness 只表示路由与 SDK 会话可用，不表示某个 GEO 操作成功。
- 日志记录各阶段时长和 generation，不记录 prompt、正文或密钥。

冷启动回归先用确定性测试和本地 trace 定位阶段；不得通过放宽 owner、跳过 admission 或并行创建第二进程换取表面速度。

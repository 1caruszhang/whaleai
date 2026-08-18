# Unified Logging

日志目录固定为当前 Xiaojing 数据根下的 `logs/`。Rust 桌面壳与每个 Session Sidecar 分别写入带日期、PID 和 nonce 的有界文件；应用启动 owner 负责 retention。

## 数据边界

允许记录 request id、Session id、generation、状态、耗时、bytes、hash 和有界错误码。禁止记录：

- Provider secret、代理口令或完整环境快照；
- system prompt、用户正文、流式 delta、附件 base64；
- workspace 文件内容或完整外部 URL query；
- 结构化卡片中的自由文本。

Rust HTTP client 传播 Xiaojing request/session/tab headers。Node 侧同一个事件只有一个文件 owner，避免 stderr 与结构化 logger 双写。

测试将目录覆盖到临时根，验证大小上限、轮转、redaction 和并发写入。不得为了诊断读取真实用户日志，除非用户明确报告运行问题并把该目录放入任务范围。

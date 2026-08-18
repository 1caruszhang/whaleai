# Chat SSE Recovery Validation

目标：证明一个 Tab 的 SSE transport 可在当前 Session Sidecar replacement 后恢复，同时不丢失 owner 与 generation fence。

## 自动化覆盖

Rust `sse_proxy` tests 使用 loopback server 覆盖连接拒绝、HTTP error、正常 EOF、截断 body、read timeout、事件大小上限、旧 subscription emit fence 和 replacement port 重连。Renderer tests 覆盖 generation envelope、白名单与 Tab identity。

运行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml sse_proxy
npm run test:unit
npm run test:dom
```

## 手工本地验证

1. 打开两个 BrandWorkspace Session Tab，并分别发送无副作用问题。
2. 结束其中一个 Session Sidecar 子进程。
3. 确认 Rust 只替换目标 Session generation，另一 Tab 不重连。
4. 目标 Tab 恢复后继续发送消息，旧 generation 不再 emit。
5. 关闭一个仍在生成的 Tab，确认后台 owner 接力；显式停止后 owner 释放。

全过程不调用真实 Provider 时应使用本地替身或仅验证连接层。

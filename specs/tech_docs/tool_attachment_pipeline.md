# Attachment Pipeline

## 数据面

二进制附件不经过 Tauri JSON IPC。用户附件存放在当前 Xiaojing 数据根的 `attachments/<session>/`，工具结果使用 Session/turn scoped storage；Renderer 只接收有界 metadata 与相对引用。

macOS/Linux 通过 `xiaojing://attachment/...` 和 `xiaojing://tool-attachment/...` 读取；Windows 使用对应的 `http://xiaojing.localhost/...` 形式。`attachment_protocol.rs` 对 segment、percent decoding、扩展名、大小和 canonical path 逐项验证。

## 控制面

上传、workspace 导入和 metadata 查询仍走 Rust 命令或 Rust HTTP proxy。原生 fetch 例外只适用于登记的 `/refs/:id` 与 `/attachment/*` 大载荷端点；不能扩展到普通 API。

## 安全与清理

- 路径必须保持在 exact Session 根内，拒绝 `..`、反斜杠、符号链接逃逸和未知 scheme。
- CSP 只允许 Xiaojing 自有 scheme/localhost 与明确图片来源。
- 日志只记录 mime、bytes、hash 和相对引用，不记录 base64 或用户正文。
- Session 删除只清理当前 Xiaojing Session 的附件目录，不探测其它应用数据。

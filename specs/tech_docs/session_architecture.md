# Session Architecture

## Identity 与持久化

Product Session ID 是单一 canonical path segment。Rust `session_metadata` 创建和更新 `Xiaojing/sessions.json`；每个 Session 的 transcript 与附件位于同一个全新 Xiaojing 数据根下。代码不读取、迁移或删除任何前代产品目录。

Session metadata 固化 workspace path、标题、创建/更新时间和 SDK resume identity。BrandWorkspace identity 由 Rust 对 canonical workspace 路径裁决，不能由 Renderer 自报。

## Sidecar 生命周期

`Session : Sidecar = 1 : 1`。Sidecar owner 只有：

- `Tab(tabId)`：挂载的聊天页。
- `BackgroundCompletion(sessionId)`：关闭 Tab 后仍在完成的 turn。
- `GeoMonitor(wakeId)`：已授权的 GEO 监测唤醒。

所有 owner 释放后才停止进程。pre-warm 创建可直接复用的真实 Session Sidecar；调用方必须服从 `ensure_session_sidecar` 锁内返回的 generation 和 `is_new`。

## 请求和事件

Tab 请求携带 exact Session hint 与 Tab owner，经 Rust HTTP/SSE proxy 分派到当前 generation。SSE subscription 可替换，但旧 generation 的 terminal、重连和清理不能写入新 generation。

关闭 transport 不取消 turn。显式中止走常驻 message generator 的 abort 路径；配置变化先保存 resume state，再替换 Sidecar。

turn 以 stopped/error 终止时，已流出的 assistant partial 输出随 `terminal` 标记（`stopped`/`error`）写入 transcript；恢复渲染凭该标记标注「未完成」，不丢已生成的回答。主 Agent 凭据缺失时 turn 在启动前 fail-fast：广播明确原因并进入 error 状态，不把失败推迟成 SDK 的隐晦 401。

## 删除

用户删除由 Rust `cmd_delete_session_if_unowned` 裁决。它验证 canonical ID、mounted Tab 授权、Sidecar idle 和非 Tab owner，在相同 lifecycle fence 内停止目标 generation，并以文件锁删除当前 Xiaojing Session metadata、transcript 与附件。

删除命令只解析当前数据根中的精确 Session 路径；没有前代路径探测、迁移或清理分支。失败时保留 metadata 和 Tab，不做 renderer rollback 猜测。

## 测试边界

测试必须把数据根指向临时目录，覆盖新路径、创建/改名、owner fence、删除拒绝与 generation replacement。默认测试不得触碰真实用户目录。

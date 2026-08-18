# Windows Platform

本文记录由小鲸桌面壳维护的跨平台边界。Ticket 22 只建立 Windows x64 内测打包输入；安装、升级、卸载和 SmartScreen 仍必须在 Windows 10/11 x64 实机验证，详见 [Windows x64 内测构建与验收](../guides/windows_x64_internal_beta.md)。

## 进程

GUI 子进程统一走 `process_cmd::spawn_tree()`。Windows child 在执行用户代码前加入 kill-on-close Job Object，并使用 no-window flags；owner 保存 `ChildTree`，停止时只结束精确后代。

内置 Node 从 app resources 的当前平台目录解析，不搜索系统安装或用户 home。路径、argv 和环境分别传递，不通过 `cmd.exe` 拼接。

Windows 内测资源固定为 `x86_64-pc-windows-msvc`。Session Sidecar 仍是内置 Node 执行 `server-dist.js`，不是新的 Tauri 外部二进制；Rust admission 同时注入已验收的 Claude Agent SDK 原生执行文件、Sharp `NODE_PATH` 与 PortableGit/Git Bash 绝对路径。任何一项缺失均在创建 Session 进程前失败，不回退到系统 Node、Git 或用户目录。

## 文件系统

workspace IO 使用 handle-relative/no-follow helper，拒绝 junction、reparse point、设备路径、ADS 和系统/凭据目录。原子替换使用 Windows 明确的 replace 语义；测试在临时目录覆盖 junction race。

当前应用数据根是 `%LOCALAPPDATA%\\Xiaojing`，identifier 为 `com.xiaojing.geo`，附件 localhost origin 为 `xiaojing.localhost`。没有前代目录 fallback。

NSIS 使用 current-user 模式，程序目录与 `%LOCALAPPDATA%\\Xiaojing` 数据目录分离。安装 hook 只处理已验哈的 WebView2 前置项，卸载 hook 不删除数据目录；BrandWorkspace、Session、GeoOperation、配置、日志和附件因此不属于卸载器清理范围。旧版本覆盖被阻止，同版本重装与更高版本升级仍须在 Windows 实机验收。

## WebView、代理与通知

CSP 只开放本机控制面、Xiaojing 附件 scheme/localhost 和必要图片来源。系统通知携带精准 Session/GEO navigation payload；点击激活主窗口后由 Rust 验证目标。

Windows 子进程继续使用 kill-on-close Job Object。代理 owner 继续向 Sidecar 同时注入大小写两种 no-proxy，并保护 `localhost`、IPv4 loopback 与 IPv6 loopback；普通控制面 HTTP/SSE 仍由 Rust 转发，Renderer 没有新增直连路径。

macOS 开发机可验证配置、脚本、资源契约和共享 Rust/TypeScript 行为，但不能宣称完成 Windows x64 bundle、资源布局、安装器或真实 WebView2 环境验收。

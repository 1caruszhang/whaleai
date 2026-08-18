# Windows x64 内测构建与验收

本指南只覆盖 x86_64-pc-windows-msvc 的内部候选。当前 macOS 开发 Session 没有构建或运行 Windows 安装器，本文矩阵全部保持“待 Windows 实机”；交叉编译或静态解析不能替代安装结果。

## 产品与数据边界

- package、crate 与主程序名：xiaojing / xiaojing.exe
- 产品名：小鲸同学
- identifier：com.xiaojing.geo
- 内部 protocol：xiaojing
- 数据根：%LOCALAPPDATA%\Xiaojing
- 安装范围：NSIS current-user，不请求管理员权限
- 目标：仅 Windows x64；不生成其他 Windows 架构

程序文件默认位于当前用户的本地应用目录，数据根独立保存 BrandWorkspace 数据库、Session 元数据与 transcript、GeoOperation 状态、配置、日志和用户附件。覆盖安装只替换程序文件；卸载默认保留整个数据根。卸载器没有数据删除入口。

## 固定构建输入

[Windows x64 资源清单](../../scripts/windows-x64-resources.json) 是唯一资源清单。准备脚本只从其中的 HTTPS 地址取文件，先验证摘要，再解压或执行已登记的自解压包。src-tauri/resources/windows-x64-staging.json 记录每个 staging 文件的 SHA-256、大小和上游摘要；它是本地生成物，不进入版本库。

Tauri 字段按仓库已安装的 CLI 2.11.4 schema、Rust crate 2.11.2 类型和 [tauri-v2.11.4 NSIS 模板源码](https://github.com/tauri-apps/tauri/blob/tauri-v2.11.4/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi) 校验。current-user 使用 HKCU；默认卸载器可能清理 identifier 对应的 WebView profile，但 identifier com.xiaojing.geo 与数据根 Xiaojing 不同，定制 hook 也没有数据删除动作。

| 资源 | 固定版本/修订 | 上游摘要 |
|---|---|---|
| Node.js Windows x64 zip | 24.14.0 | 313fa40c0d7b18575821de8cb17483031fe07d95de5994f6f435f3b345f85c66 |
| PortableGit 64-bit | 2.55.0.windows.4 | 016e84230a3767f0c6b3788e79ba0c58a17377086801719d46700fca4f7b36b5 |
| Claude Agent SDK Windows x64 package | 0.3.220 | 清单中的 SHA-512；claude.exe SHA-256 为 af5bf1f1b2aadffc768eccd787084c6fdf9ba81624cbe96c1c6d9ac1a1550231 |
| Sharp Windows x64 runtime | 0.34.5 | 清单中的各 npm SHA-512 |
| WebView2 Evergreen bootstrapper | 固定内容修订 eb04ea38 | be695eb3732a94e181f008ab5cf6ee650f8644676e87f9e02b6ab0d02f2ea08e |

来源分别是 [Node.js 官方归档](https://nodejs.org/en/download/archive/v24.14.0)、[Git for Windows 官方仓库](https://github.com/git-for-windows/git/releases/tag/v2.55.0.windows.4)、npm 官方 registry 与 [Microsoft WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2)。准备脚本还检查可执行文件的 x64 PE machine；对提供 Authenticode 的上游可执行文件同时要求签名有效。

当前 xiaojing.exe、Node、Claude 原生执行文件和 Sharp Windows 原生模块的导入闭包不需要单独的 Visual C++ 动态运行库。Windows 构建使用 dumpbin /dependents 复核所有已打包 PE；一旦出现 VCRUNTIME*、MSVCP* 或 CONCRT* 动态导入，构建立即失败，必须先建立精确的 app-local 输入，不能静默执行需要管理员权限的全局安装器。清单仅审计记录 [Microsoft 当前支持的 x64 redistributable](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist?view=msvc-170) 作为故障分析参考，明确不打包、不执行。

## Windows/CI 准备与构建

机器必须是原生 Windows x64，安装 Visual Studio 2022 Build Tools 的 Desktop development with C++、仓库锁定的 Rust 工具链、Node/npm 与 PowerShell。先安装唯一 Rust target：

~~~powershell
rustup target add x86_64-pc-windows-msvc
npm ci --ignore-scripts
~~~

准备资源并运行 staging 校验：

~~~powershell
.\scripts\prepare-windows-x64.ps1
node .\scripts\validate-windows-x64.mjs --staging
npm run test:windows-x64
~~~

受控网络环境可先填充 .windows-x64-cache，随后使用 -Offline 验证缓存；缺文件或摘要不符会直接失败。脚本不读取本地 .env，不启动真实 Provider，也不把凭据传给 Renderer。

生成明确标注的内部未签名候选：

~~~powershell
.\scripts\build-windows-x64.ps1 -Mode internal-unsigned
~~~

输出位于 artifacts\windows-x64\internal-unsigned，文件名包含 INTERNAL-UNSIGNED，旁边的 candidate.json 记录 SHA-256，并将 Windows 安装验证标为 pending。脚本不上传、不发布。

## WebView2 恢复路径

安装器先查当前机器与当前用户的 WebView2 registry 状态。缺失时只运行安装包内已验哈的 Microsoft bootstrapper；返回非零或资源缺失会中止安装，不留下“安装成功”的假状态。

bootstrapper 需要联网。如果目标机必须离线，由管理员在另一台受控机器从 Microsoft 官方页面取得 Evergreen Standalone Installer x64，按组织的软件入库流程验签和转运，在目标机先安装 WebView2，再重新运行小鲸安装器。离线安装器不混入本候选，也不能用空文件代替。

## 内部安装与故障采集

1. 从内部受控渠道取得 INTERNAL-UNSIGNED 安装器与 candidate.json，用 Get-FileHash -Algorithm SHA256 比对。
2. 未签名候选预期可能显示 SmartScreen 或 “Unknown publisher”。只有确认内部来源和 SHA-256 后，才按组织内测策略选择继续；这不代表已建立发布者信誉。
3. current-user 安装不应弹出 UAC。若弹出，停止并记录截图、系统版本和安装器 SHA-256。
4. 首次启动后创建品牌与新 Session，确认主聊天仍是唯一 Agent 入口。
5. 日志位于 %LOCALAPPDATA%\Xiaojing\logs；崩溃材料位于其 crash 子目录。收集前先退出应用，只复制与故障时段相关文件，并人工去除 workspace 路径、内容和任何 Provider 值。
6. 同时记录 winver、WebView2 版本、安装器 SHA-256、复现步骤、是否启用系统代理、Windows Security 拦截记录。不得直接提交完整数据根。

路径场景必须覆盖中文用户名、Unicode、空格、% 与长路径。路径始终通过独立 argv/环境值传递，不能改成 cmd.exe 字符串拼接。代理场景必须确认普通 API 仍经 Rust，本地 HTTP/SSE 命中 no-proxy，附件只走已登记的 xiaojing 数据面。

## 升级、重装、卸载与回滚

- 同版本重装与更高版本覆盖：安装前退出应用；安装后确认原品牌、Session、GEO 产物、配置和附件仍在。
- 更旧版本：安装器必须拒绝直接覆盖，避免较旧 schema 写入新数据。
- 卸载：只移除程序文件和快捷方式；随后核对 %LOCALAPPDATA%\Xiaojing 仍存在且内容未变。脚本不得为了测试而删除该目录。
- 回滚：先退出应用，复制整个数据根到受控备份位置；卸载当前程序后安装经批准的旧候选。若旧候选不能读取较新的数据 schema，恢复程序而不是改写或删除数据，交由数据 owner 决定迁移策略。

## 生产签名硬门槛

内部候选允许未签名，但面向普通用户前必须让主程序、卸载程序和 NSIS 安装器全部通过 SHA-256 Authenticode 与可信时间戳验证。签名配置只启用 [Tauri Windows 签名 overlay](../../src-tauri/tauri.windows.signing.conf.json) 的 wrapper，不在仓库保存证书、密码或时间服务配置。

受保护 Windows CI 需要从 secret 注入以下环境变量：

- XIAOJING_WINDOWS_SIGN_PFX_PATH
- XIAOJING_WINDOWS_SIGN_PFX_PASSWORD
- XIAOJING_WINDOWS_SIGN_CERT_SHA1
- XIAOJING_WINDOWS_SIGN_TIMESTAMP_URL
- 可选 XIAOJING_WINDOWS_SIGNTOOL_PATH

CI 必须先把 PFX 导入 Cert:\CurrentUser\My，且不得打印命令参数或变量值，再运行：

~~~powershell
.\scripts\build-windows-x64.ps1 -Mode production-signed
~~~

缺少任一 admission 输入、签名身份不符、时间戳缺失或验签失败都会阻止候选生成。有效签名也不等于 SmartScreen 已获得信誉；只能记录实机观察，不能宣称绕过或通过。

## Windows 10/11 x64 实机验收矩阵

以下项目截至 Ticket 22 的 macOS 实现 Session 均未执行。每一格必须保存系统版本、候选 SHA-256、结果和去隐私化证据。

| 场景 | Windows 10 22H2 x64 | Windows 11 x64 |
|---|---|---|
| 全新 current-user 安装，无 UAC | 待实机 | 待实机 |
| WebView2 已存在 / 缺失后 bootstrapper 恢复 | 待实机 | 待实机 |
| SmartScreen / Unknown publisher 观察 | 待实机 | 待实机 |
| 首次启动、主聊天、新 Session、Session:Sidecar=1:1 | 待实机 | 待实机 |
| 创建 BrandWorkspace 并读取 Tickets 09–21 已有产物 | 待实机 | 待实机 |
| GeoOperation、通知、后台补全与重启恢复 | 待实机 | 待实机 |
| xiaojing 深链/附件数据面与本地 HTTP/SSE | 待实机 | 待实机 |
| 系统代理开启时 localhost no-proxy | 待实机 | 待实机 |
| 中文、Unicode、空格、%、长路径 workspace | 待实机 | 待实机 |
| 中止与退出后 Node、Claude、Git 进程树全部终止 | 待实机 | 待实机 |
| 同版本重装与更高版本升级保留全部数据 | 待实机 | 待实机 |
| 更旧版本覆盖被拒绝 | 待实机 | 待实机 |
| 卸载仅移除程序，数据根完整保留 | 待实机 | 待实机 |
| 回滚步骤与备份恢复演练 | 待实机 | 待实机 |
| 生产凭据可用时主程序/卸载程序/安装器验签与时间戳 | 待实机 | 待实机 |

完成矩阵前，不得把候选描述为 Windows 已验收、SmartScreen 已通过或可公开分发。

# macOS arm64 内测构建与验收

本指南只覆盖 aarch64-apple-darwin（Apple Silicon）的内部候选。当前 Windows 构建机不能构建或运行 macOS 安装器，本文矩阵全部保持"待 macOS 实机"；交叉编译或静态解析不能替代安装结果。Intel（x86_64-apple-darwin）与 Universal 2 候选不在本期范围；新增时需要单独的 x64 清单与实机矩阵。

## 产品与数据边界

- package、crate 与主程序名：xiaojing / xiaojing
- 产品名：鲸杉geo（鲸杉geo.app）
- identifier：com.xiaojing.geo
- 内部 protocol：xiaojing
- 数据根：~/Library/Application Support/Xiaojing
- 分发形式：DMG，用户拖入 /Applications 完成安装；不请求管理员权限（若用户拖入 /Applications 需要权限则由其自行决定）
- 目标：仅 Apple Silicon（arm64）；最低系统 macOS 11.0

程序文件即 鲸杉geo.app 本体；数据根独立保存 BrandWorkspace 数据库、Session 元数据与 transcript、GeoOperation 状态、配置、日志和用户附件。覆盖替换 .app 不影响数据根；没有卸载器，删除 .app 不移除数据根。

## 固定构建输入

[macOS arm64 资源清单](../../scripts/macos-arm64-resources.json) 是唯一资源清单。准备脚本 scripts/prepare-macos-arm64.sh 只从其中的 HTTPS 地址取文件，先验证摘要，再解压。src-tauri/resources/macos-arm64-staging.json 记录每个 staging 文件的 SHA-256、大小和上游摘要；它是本地生成物，不进入版本库。

Tauri 字段按仓库已安装的 CLI 2.11.4 schema 与 Rust crate 2.11.2 类型校验。src-tauri/tauri.macos.conf.json 由 Tauri CLI 在 macOS target 构建时自动合并，只声明 dmg target、应用类别（Business）、最低系统版本与 DMG 窗口布局。

| 资源 | 固定版本/修订 | 上游摘要 |
|---|---|---|
| Node.js macOS arm64 tar.gz | 24.14.0 | a1a54f46a750d2523d628d924aab61758a51c9dad3e0238beb14141be9615dd3 |
| Claude Agent SDK macOS arm64 package | 0.3.220 | 清单中的 SHA-512；claude SHA-256 为 8addc857f3fe64d5a0368af9ee50321b50afb4a6918ba3ef018ab84f5dbbe081 |
| Sharp macOS arm64 runtime（含 @img/sharp-libvips-darwin-arm64 1.2.4） | 0.34.5 | 清单中的各 npm SHA-512 |

来源分别是 [Node.js 官方归档](https://nodejs.org/en/download/archive/v24.14.0) 与 npm 官方 registry。准备脚本还用 `file` 复核 node 与 claude 均为 arm64 Mach-O 可执行文件，并保证可执行位在 staging 后仍然保留。

与 Windows 的差异：macOS 不打包 PortableGit（使用系统 /usr/bin/git）与 WebView2（Tauri 在 macOS 使用系统 WKWebView）。运行时准入由 Rust 侧 apply_macos_bundled_runtime 完成：缺失 claude-agent-sdk/claude 或 sharp-runtime/node_modules 会在创建 Session 进程前失败，不回退到用户安装的运行时。

## macOS/CI 准备与构建

机器必须是原生 Apple Silicon Mac，安装 Xcode Command Line Tools、仓库锁定的 Rust 工具链与 Node/npm。先安装唯一 Rust target：

~~~sh
rustup target add aarch64-apple-darwin
npm ci --ignore-scripts
~~~

准备资源（下载并验摘要，或离线复用缓存）：

~~~sh
bash scripts/prepare-macos-arm64.sh            # 在线
bash scripts/prepare-macos-arm64.sh --offline  # 复用 .macos-arm64-cache
~~~

生成明确标注的内部未签名候选：

~~~sh
bash scripts/build-macos-arm64.sh internal-unsigned
~~~

构建脚本门禁顺序：宿主与 target 准入 → 签名材料卫生检查（任何 APPLE_* / TAURI_SIGNING_* 环境变量存在即拒绝，避免产出含糊的签名状态）→ 资源摘要准备 → npm run typecheck → npm run lint → tauri build --ci --target aarch64-apple-darwin --bundles dmg --no-sign → 包内检查（主程序单架构 arm64、.app 内 nodejs/bin/node 与 claude-agent-sdk/claude 存在且可执行、DMG 时间戳新鲜、无 Developer ID 签名）。

输出位于 artifacts/macos-arm64/internal-unsigned，文件名包含 INTERNAL-UNSIGNED，旁边的 candidate.json 记录 SHA-256，并将 macOS 安装验证标为 pending。脚本不上传、不发布。

production-signed 模式当前明确拒绝：Developer ID 证书导入、公证（notarytool）与 staple 验证属于未登记的准入步骤，不能用临时签名绕过。

## 内部安装与故障采集

1. 从内部受控渠道取得 INTERNAL-UNSIGNED DMG 与 candidate.json，用 `shasum -a 256` 比对。
2. 未公证候选首次打开时 Gatekeeper 预期拦截。只有确认内部来源和 SHA-256 后，才按组织内测策略选择"系统设置 → 隐私与安全性 → 仍要打开"或右键打开；这不代表已建立发布者信誉。禁止用 `xattr -dr com.apple.quarantine` 批量清除未知来源应用的隔离属性作为常规流程。
3. 安装不应弹出管理员授权。若弹出，停止并记录截图、系统版本和 DMG SHA-256。
4. 首次启动后创建品牌与新 Session，确认主聊天仍是唯一 Agent 入口。
5. 日志位于 ~/Library/Application Support/Xiaojing/logs；崩溃材料位于其 crash 子目录，macOS 崩溃报告另见于 ~/Library/Logs/DiagnosticReports。收集前先退出应用，只复制与故障时段相关文件，并人工去除 workspace 路径、内容和任何 Provider 值。
6. 同时记录 sw_vers、硬件型号（sysctl hw.model）、DMG SHA-256、复现步骤、是否启用系统代理。不得直接提交完整数据根。

路径场景必须覆盖中文用户名、Unicode、空格与长路径。路径始终通过独立 argv/环境值传递，不能改成 shell 字符串拼接。代理场景必须确认普通 API 仍经 Rust，本地 HTTP/SSE 命中 no-proxy，附件只走已登记的 xiaojing 数据面。

## 验收矩阵（全部待 macOS 实机）

- 全新安装：拖拽安装 → 首次启动 → 创建品牌 → 新 Session 完整对话
- 覆盖安装：旧版本 .app 替换为新版本 → 数据根与 Session 历史保留
- 删除 .app 后重装：数据根保留并可继续使用
- Gatekeeper 提示文案与"仍要打开"路径截图归档
- 断网启动、系统代理开启启动、中文/Unicode 用户名路径
- 升级 candidate.json 中 macosInstallValidation 字段为实测结论

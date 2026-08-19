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

以下项目截至 Ticket 22 与票 13 的 macOS 实现 Session 均未执行。每一格必须保存系统版本、候选 SHA-256、结果和去隐私化证据；批次事实（winver、WebView2 版本、安装器 SHA-256 实测值）按「证据归档（票 13）」记入当批 `environment.md` 一次即可，逐格记录结果、证据文件与操作者。

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

### 商业化场景逐格矩阵（票 13）

以下商业化场景与基础矩阵同样逐格执行，两台实机各自完整跑一遍。内测环境为 `api.jingshanai.com`（部署依赖票 12 runbook 的用户侧执行，见文末清单）。每格统一证据基线：场景截图（或日志片段）+ 执行时间与操作者；系统版本与候选 SHA-256 以当批 `environment.md` 为准。凡实机无法稳定构造的场景（如真实拒稿、部分单位失败退款），结果栏如实标注「未覆盖（原因）」，由本地测试结论补充说明，不得宣称通过。

| 场景 | Windows 10 22H2 x64 | Windows 11 x64 |
|---|---|---|
| C1 登录门与首登强制改密 | 待实机 | 待实机 |
| C2 协议勾选与三份合规文件入口 | 待实机 | 待实机 |
| C3 7 天断网宽限（宽限内可用、超期拦截） | 待实机 | 待实机 |
| C4 计费扣点与 /admin 流水一致 | 待实机 | 待实机 |
| C5 余额 0 对话 402 拦截与充值恢复 | 待实机 | 待实机 |
| C6 计费操作余额不足弹窗拦截 | 待实机 | 待实机 |
| C7 发布授权、订单状态流转与退点 | 待实机 | 待实机 |
| C8 卸载后数据根完整保留（含商业化数据） | 待实机 | 待实机 |

#### C1 登录门与首登强制改密

- **前置条件**：内测环境可达（票 12 runbook 第 7 节冒烟 1–2 已过）；/admin 已建验收账号（手机号 + 初始密码，自动赠 500 点）；本机处于未登录态（全新安装或已退出登录）。
- **操作步骤**：1. 启动应用观察首屏；2. 输入正确手机号 + 错误密码提交一次；3. 用初始密码正确登录；4. 在强制改密屏完成改密；5. 退出应用重启。
- **预期**：未登录时只呈现全屏登录门（产品名、手机号、密码、协议勾选），无法绕过进入工作台；错误密码出现明确错误反馈且应用不崩溃；首登强制改密完成前无法进入工作台；改密成功后进入主聊天工作台；重启后保持登录态直达工作台。
- **证据要求**：登录门截图（手机号打码）、错误反馈截图、改密屏截图、进入工作台截图；该时段 `%LOCALAPPDATA%\Xiaojing\logs` 日志片段（去手机号）。
- **记录位**：`matrix.md` C1 行（两台机器各自记录）。

#### C2 协议勾选与三份合规文件入口

- **前置条件**：同 C1（未登录态）。
- **操作步骤**：1. 不勾选协议观察登录按钮与提交提示；2. 依次打开勾选行内的《用户协议（2026 年正式版）》《隐私政策》《计费标准》三个链接并滚动到文末；3. 勾选协议并登录；4. 打开左下角设置 → 个人信息，逐一打开三份文件入口；5. 退出登录回到登录页观察勾选状态。
- **预期**：未勾选时无法提交（按钮禁用并给出勾选提示）；三个链接打开只读全文查看器，点链接不改变勾选状态、不触发提交；个人信息面板三份文件入口可用且全文一致；同设备再次到登录页时协议按已同意记录预勾选。
- **证据要求**：未勾选禁用态截图、三份文件查看器截图（各一张，可并排裁剪）、个人信息面板入口截图、再次登录页预勾选截图。
- **记录位**：`matrix.md` C2 行。

#### C3 7 天断网宽限（宽限内可用、超期拦截）

- **前置条件**：已登录并完成首登改密；可控制系统断网；个人信息面板可见「离线宽限 可用至 …」。
- **操作步骤**：1. 联网登录成功一次刷新宽限锚点，记下个人信息面板显示的宽限截止时间；2. 断网并重启应用，浏览品牌、Session、文章并尝试导出本地数据；3. 断网状态下发起一次计费操作；4. 观察超期拦截（二选一并如实记录方法）：a. 时钟法——断网后把系统时间调到宽限截止之后一天再重启应用，观察后恢复系统时间；b. 等待法——保持断网满 7 天后重启；5. 恢复网络与真实时间，重新登录。
- **预期**：宽限期内断网可进入应用浏览与导出本地数据；断网期间的计费操作失败但零扣点（未接触服务器即无 permit），联网后自然恢复；超期后登录门出现「已超过 7 天未连接服务器，请重新联网登录后继续使用。」提示且无法进入工作台；联网重新登录后恢复正常。
- **证据要求**：个人信息面板宽限截止截图；断网进入应用截图；超期提示截图（注明时钟法或等待法）；恢复登录截图；/admin 流水截图证明断网期间无扣点。
- **记录位**：`matrix.md` C3 行（注明超期观察方法）。

#### C4 计费扣点与 /admin 流水一致

- **前置条件**：已登录；账号余额 ≥ 10 点；内测网关可用。
- **操作步骤**：1. 在 /admin 记录账号当前余额 B0 与流水末条编号；2. 在客户端「效果」入口执行一次基线探测（选 1 问 = 5 点）；3. 完成后在设置 → 个人信息刷新余额；4. 在 /admin 账号页查流水；5.（可选，如实记录）对同一操作做一次网络中断重试或恢复重跑，再核对流水。
- **预期**：余额精确减少 5 点（B0 − 5）；/admin 出现对应 `consume` 流水且 Σdelta == balance；重试/重跑不产生第二笔扣减（permit 幂等，复用同一 permitId）；浏览、预览、读取历史零扣点。
- **证据要求**：探测发起与完成截图、余额前后对比截图、/admin 流水页截图（手机号打码）；重试场景若无法稳定复现，标注「未观察到」即可。
- **记录位**：`matrix.md` C4 行。

#### C5 余额 0 对话 402 拦截与充值恢复

- **前置条件**：已登录；运营在 /admin 将账号调点至 0（备注「票 13 验收 C5」）。
- **操作步骤**：1. 客户端主聊天发送一条消息；2. 观察聊天内错误反馈与应用状态；3. /admin 充值 ¥200（+2000 点）；4. 客户端刷新个人信息余额后重发消息。
- **预期**：余额 0 时对话被网关 402 拒绝，聊天内出现「对话需要账号点数余额大于 0，请充值后再试。」提示，应用不崩溃、不白屏、其余本地功能可用；充值后对话恢复且无需重新登录。
- **证据要求**：聊天 402 提示截图（文案完整）、/admin 调点与充值两条流水截图（手机号打码）、恢复后正常对话截图。
- **记录位**：`matrix.md` C5 行。

#### C6 计费操作余额不足弹窗拦截

- **前置条件**：已登录；运营在 /admin 将账号调点至低于一次计费操作所需（例：调至 5 点，随后发起 2 问基线探测，需 10 点）。
- **操作步骤**：1. 发起该计费操作；2. 观察弹窗内容；3. 关闭弹窗后浏览、预览历史品牌与文章；4. 在 /admin 核对流水。
- **预期**：发起前弹出「点数余额不足」弹窗，如实展示「本次操作需 X 点，当前余额 Y 点」并给出充值引导（对公转账 + 联系运营），操作不发起；/admin 无新增 `consume` 流水；浏览与预览不受影响、零扣点。
- **证据要求**：弹窗截图（数字清晰可读）、浏览历史截图、/admin 流水无新扣点截图（手机号打码）。
- **记录位**：`matrix.md` C6 行。

#### C7 发布授权、订单状态流转与退点

- **前置条件**：已登录；品牌工作台已有生成并审批通过的文章与分发计划；账号点数足够下单；超级媒介资金池已预存（票 12 前置 6，未预存时真实下单会因上游余额不足失败）。
- **操作步骤**：1. 在主聊天/品牌工作台触发发布准备，等待发布授权卡；2. 逐项核对渠道列表、每渠道单价（点数）与总价；3. 勾选不可逆确认并启动发布；4. 在发布状态视图观察逐条目的 OSS 上传与订单状态流转（待处理/发布中/已发布）与发布链接，可手动刷新；5. 打开渠道回传的订单截图内容；6.（如可构造）触发拒稿/取消/退款路径并核对余额与流水；7. 充值恢复被拦截的功能（若 C5 已暂停对话）。
- **预期**：授权卡单价 = 媒介价 × 1.6 向上取整的点数，总价为各渠道之和，界面不出现「服务费」字样；订单进入列表后可见状态流转与发布链接，进入「发布中」才正式扣点；渠道回传截图经现有 sanitize 栈渲染（脚本、事件处理器、`javascript:` 链接被清洗，无脚本执行痕迹）；拒稿/取消/退款呈现对应状态且点数原路退回（余额与 /admin 流水一致）。真实拒稿/退款若内测期无法稳定构造，标注「未覆盖（原因）」，以本地 mock/契约测试结论补充，不宣称通过。
- **证据要求**：授权卡截图（单价与总价）、订单各状态截图、发布链接截图、截图内容渲染截图、/admin 结转与退款流水截图（手机号打码）。
- **记录位**：`matrix.md` C7 行。

#### C8 卸载后数据根完整保留（含商业化数据）

- **前置条件**：本机已完成 C1–C7（数据根内已有品牌、Session、GEO 产物、日志等商业化场景数据）；先退出应用并记录卸载前清单：
  `Get-ChildItem -Recurse -File "$env:LOCALAPPDATA\Xiaojing" | Measure-Object -Sum Length | Select-Object Count, Sum`。
- **操作步骤**：1. 在 Windows 设置 → 应用卸载「小鲸同学」，确认卸载器没有数据删除入口；2. 复查上述清单命令对比文件数与总大小；3. 重装同一候选并启动。
- **预期**：卸载只移除程序文件与快捷方式；`%LOCALAPPDATA%\Xiaojing` 完整保留且文件数/总大小与卸载前一致；重装后原品牌、Session、GEO 产物、配置与附件全部可读；OS 凭据库中的登录 token 不受卸载影响，重装启动直达已登录工作台（若观察结果不同，如实记录）。
- **证据要求**：卸载前后清单命令输出（截图或文本）、卸载完成截图、重装后原品牌数据截图、登录态截图。
- **记录位**：`matrix.md` C8 行。

完成基础矩阵与商业化矩阵前，不得把候选描述为 Windows 已验收、SmartScreen 已通过或可公开分发。

## 证据归档（票 13）

验收证据属于内部运营材料，永不进入版本库：根 `.gitignore` 已整体忽略 `artifacts/windows-x64/`，本节目录随之被忽略，不得为其新增例外。

### 目录结构

~~~text
artifacts/windows-x64/acceptance/<YYYYMMDD>-<候选SHA-256前8位>/
├── candidate.json          # 构建脚本产出原样拷贝（file、sha256、windowsInstallValidation=pending…）
├── environment.md          # 本批次环境事实，一次记录即覆盖全格：winver 输出、WebView2 版本、
│                           #   安装器 SHA-256 实测值（Get-FileHash）、构建 git commit、是否系统代理
├── windows-10-22h2/
│   ├── matrix.md           # 基础矩阵 + 商业化矩阵逐格记录位
│   ├── evidence/           # 截图与照片：C1-01-login-gate.png、fresh-install-01-uac-absent.png …
│   └── logs/               # 去隐私后的应用日志片段（退出应用后从 %LOCALAPPDATA%\Xiaojing\logs 复制）
└── windows-11/             # 与 windows-10-22h2 同构
~~~

命名规则：证据文件名以场景标识开头——商业化场景用 C1–C8，基础矩阵行用行义 slug（如 `fresh-install`、`webview2-recovery`、`smartscreen`、`long-path`）；同场景多张用两位序号递增。`matrix.md` 每行记录结果（通过 / 未通过 / 未覆盖+原因）、证据文件名列表、执行时间与操作者，例如：

~~~markdown
| 场景 | 结果 | 证据 | 备注 |
|---|---|---|---|
| 基础：SmartScreen / Unknown publisher 观察 | 如实记录 | smartscreen-01.png | 未签名候选出现「未知发布者」，选择继续，不宣称通过 |
| C1 登录门与首登强制改密 | 通过 | C1-01..C1-04.png | 手机号已打码 |
~~~

### 去隐私要求（对照 AGENTS.md 密钥红线）

- 截图与日志不得出现完整手机号：验收账号手机号一律打码（如 `138****0001`）。
- 账号 token、网关凭证与任何 Provider 密钥绝不允许出现在证据里。renderer 本就不持有 token 本体；从数据根复制的日志先逐段人工复查，发现疑似凭据立即删除该段或整份作废重取。
- 不得复制或上传整个 `%LOCALAPPDATA%\Xiaojing` 数据根；只取与验收时段相关的日志文件，并人工去除 workspace 路径与内容（沿用「内部安装与故障采集」第 5 条）。
- `candidate.json` 只含产品标识、文件名、SHA-256 与 pending 标记，无敏感信息，原样归档。

### candidate.json 的产出与归档

`.\scripts\build-windows-x64.ps1 -Mode internal-unsigned` 在 `artifacts\windows-x64\internal-unsigned\` 产出安装器与同目录 `candidate.json`（`sha256`、`windowsInstallValidation: "pending-on-windows-10-and-11-x64"`、`uploaded/published: false`）。验收开始时把两者一起复制进当批 acceptance 目录；实机安装前用 `Get-FileHash -Algorithm SHA256` 实测并与 `candidate.json` 比对，实测值记入 `environment.md`。验收结论只记录在 `matrix.md`；不回写、不修改 `candidate.json` 的任何字段——`uploaded`/`published` 属后续人工分发动作，且任何版本都不入仓库。

## 票 13 用户执行清单（实机构建 + 逐格验收 + 生产联调）

macOS 可自动化层已随票 13 交付：`npm run verify:windows-x64`、`npm run test:windows-x64`、`npm run lint` 全绿（lint 含 verify:geo-surface / verify:agent-docs）。资源清单核对结论：商业化功能（登录门、点数计费、发布下单、合规勾选）分别落在 renderer bundle（三份合规文件经 Vite `?raw` 构建期内联，无独立资源文件）、`xiaojing.exe` 编译产物与远端网关（`backend/`，随票 12 部署），没有新增 Windows 资源文件、图标或外部二进制；`scripts/windows-x64-resources.json` 与 Tauri resources 最小集无需变更，其契约由 `npm run verify:windows-x64` 持续钉住。以下步骤由用户在原生 Windows x64 实机执行。

### 第 1 步：Windows 实机构建

机器要求与完整说明见「Windows/CI 准备与构建」；最小命令序列：

~~~powershell
rustup target add x86_64-pc-windows-msvc
npm ci --ignore-scripts
.\scripts\prepare-windows-x64.ps1
node .\scripts\validate-windows-x64.mjs --staging
npm run test:windows-x64
.\scripts\build-windows-x64.ps1 -Mode internal-unsigned
~~~

产物为 `artifacts\windows-x64\internal-unsigned\Xiaojing_<版本>_x64_INTERNAL-UNSIGNED-setup.exe` 与 `candidate.json`。构建完成后把两者转入 `artifacts\windows-x64\acceptance\<YYYYMMDD>-<sha8>\`（见「证据归档」），再经内部受控渠道分发到验收实机。

### 第 2 步：内测环境就绪（依赖票 12 runbook 用户侧执行）

1. `api.jingshanai.com` 已按[部署 runbook](deploy-api-jingshanai.md)第 4 节完成宝塔反代 + SSL，第 7 节生产冒烟 1–2 项通过（`/healthz`、`/admin` 登录）。
2. /admin 建验收账号（真实手机号 + 初始密码，自动赠 500 点）；超级媒介资金池已预存（C7 真实下单前置）。
3. 两台验收实机（Windows 10 22H2 x64、Windows 11 x64）可直连 `api.jingshanai.com:443`。

### 第 3 步：逐格验收（两台实机各自完整执行）

1. 按「内部安装与故障采集」安装候选：`Get-FileHash -Algorithm SHA256` 与 `candidate.json` 比对；SmartScreen / 未知发布者提示如实截图记录，不宣称通过。
2. 执行基础矩阵全部行。
3. 执行商业化矩阵 C1–C8。
4. 每格结果与证据按「证据归档」落盘到本机 `matrix.md` 与 `evidence/`、`logs/`。

### 第 4 步：商业化生产联调最短路径

登录与改密（C1）→ 一次计费操作并核对 /admin 流水（C4）→ 发布授权与订单流转（C7）→ 欠费拦截（C5、C6，用 /admin 调点构造，结束后恢复余额并留备注流水）→ 卸载数据保留（C8）。顺序依赖：C7 前先完成资金池预存与内容准备；C8 必须最后执行（卸载后才能核对数据根保留）。

### 第 5 步：汇总与判定

两台机器的 `matrix.md` 全部行均为「通过」或明确「未覆盖（原因）」后，才可在批次目录汇总验收结论；SmartScreen 只记录观察事实。矩阵完成前沿用本指南红线：不得把候选描述为 Windows 已验收、SmartScreen 已通过或可公开分发。

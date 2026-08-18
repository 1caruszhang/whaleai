import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../..");

function source(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

describe("Xiaojing product shell contract", () => {
  it("projects existing tabs through the focused three-column shell", () => {
    const app = source("src/renderer/App.tsx");
    expect(app).toContain("<XiaojingSidebar");
    expect(app).toContain("<XiaojingGeoWorkbench");
    expect(app).toContain("data-tab-content-workspace");
    expect(app).toContain("<XiaojingWelcome");
  });

  it("mounts the workbench only inside chat tabs so welcome and brand pages span full width", () => {
    const app = source("src/renderer/App.tsx");
    // 票 28：工作台仅挂载于聊天 Tab；欢迎页与品牌整页主区全宽。
    expect(app.match(/<XiaojingGeoWorkbench/g)?.length).toBe(1);
    expect(app).not.toContain("activeTab?.view !== 'chat'");
  });

  // 票 30/票 31：一级导航机制——品牌级入口跟随当前选中品牌、不依赖任何
  // Session。「品牌档案」（票 30）与「效果」（票 31）落地后，四个一级入口
  // （主聊天、品牌工作台、品牌档案、效果）完整。
  it("hosts brand-level full pages through sidebar primary navigation", () => {
    const app = source("src/renderer/App.tsx");
    const sidebar = source(
      "src/renderer/components/xiaojing/XiaojingSidebar.tsx",
    );
    const archive = source(
      "src/renderer/components/xiaojing/XiaojingBrandArchivePage.tsx",
    );
    const effectPage = source(
      "src/renderer/components/xiaojing/XiaojingGeoEffectPage.tsx",
    );
    const workbench = source(
      "src/renderer/components/xiaojing/XiaojingGeoWorkbench.tsx",
    );
    // 左侧栏一级导航承载品牌档案与效果；入口只调品牌级回调，不经过任何
    // onOpenWorkspace/onOpenSession 会话打开路径。
    expect(sidebar).toContain("onOpenBrandArchive");
    expect(sidebar).toContain("xiaojingSidebar.brandArchive");
    expect(sidebar).toContain("activeTab?.view === 'brand-archive'");
    expect(sidebar).toContain("onClick={onOpenBrandArchive}");
    expect(sidebar).toContain("onOpenBrandEffect");
    expect(sidebar).toContain("xiaojingSidebar.brandEffect");
    expect(sidebar).toContain("activeTab?.view === 'brand-effect'");
    expect(sidebar).toContain("onClick={onOpenBrandEffect}");
    // 品牌档案与效果是独立整页 tab 视图（单例复用），跟随当前选中品牌，
    // 不绑定任何 Session 身份。
    expect(app).toContain("view: 'brand-archive'");
    expect(app).toContain("<XiaojingBrandArchivePage");
    expect(app).toContain("view: 'brand-effect'");
    expect(app).toContain("<XiaojingGeoEffectPage");
    expect(app).toContain("tab.view === 'brand-effect'");
    expect(app).toContain("brandState.currentWorkspace");
    // 品牌档案整页只读投影：版本史与产物血缘来自 BrandWorkspace 历史投影，
    // 无确认或动作入口。
    expect(archive).toContain("loadBrandHistory");
    expect(archive).toContain('aria-label="品牌知识版本"');
    expect(archive).toContain('aria-label="已批准产物"');
    expect(archive).not.toContain("decideGeoKnowledge");
    expect(archive).not.toContain("controlGeoOperation");
    expect(archive).not.toContain("apiPost");
    // 效果整页：三面板原样搬迁，控制面借用已打开聊天 Tab 的 Session owner
    // 身份，不新建 Sidecar owner。
    expect(effectPage).toContain("<XiaojingGeoEffectPanel");
    expect(effectPage).toContain("sessionSidecarFetch");
    expect(effectPage).toContain("TabApiContext.Provider");
    expect(effectPage).not.toContain("readOnly");
    // 工作台双页签移除：不再渲染效果面板，历史面板同样在左侧栏整页。
    expect(workbench).not.toContain("BrandHistoryPanel");
    expect(workbench).not.toContain("XiaojingGeoEffectPanel");
    expect(workbench).not.toContain('role="tablist"');
  });

  it("registers only focused Session and GEO route families in the Sidecar", () => {
    const composition = source("src/server/sidecar-composition.ts");
    expect(composition).toContain("pathname.startsWith('/api/xiaojing/')");
    expect(composition).toContain("pathname.startsWith('/chat/')");
  });

  // 票 06：账号 admission 取代旧 Provider 凭据注入——品牌 Session Sidecar
  // 只拿网关地址 + 账号 access token；旧传输名逐一清洗，非品牌 Session 全部
  // scrub。旧凭据配置命令不得再回到 invoke_handler。
  it("admits only the gateway address and account token into brand Session sidecars", () => {
    const lifecycle = source("src-tauri/src/sidecar/session_lifecycle.rs");
    const accountAuth = source("src-tauri/src/account_auth.rs");
    const lib = source("src-tauri/src/lib.rs");
    expect(lifecycle).toMatch(
      /if crate::brand_workspace::is_brand_workspace_path\(workspace_path\) \{\s*\/\/ 票 06[\s\S]*?crate::account_auth::inject_into_sidecar\(&mut cmd\)\?;/,
    );
    expect(lifecycle).toMatch(/else \{\s*crate::account_auth::scrub_account_admission\(&mut cmd\);/);
    expect(lifecycle).not.toContain("deepseek_credentials");
    expect(lifecycle).not.toContain("geo_provider_credentials::inject_into_sidecar");
    // 账号投影不得携带 token（AccountState 无 token 字段由 Rust 单测
    // state_projection_never_carries_token_material 钉死）；token 只经 OS
    // 凭据库 + admission 传输名流转。
    expect(accountAuth).toContain('pub const GATEWAY_BASE_URL_ENV: &str = "XIAOJING_GATEWAY_BASE_URL";');
    expect(accountAuth).toContain('pub const ACCOUNT_ACCESS_TOKEN_ENV: &str = "XIAOJING_ACCOUNT_ACCESS_TOKEN";');
    expect(lib).toContain("account_auth::cmd_account_state");
    expect(lib).toContain("account_auth::cmd_account_login");
    expect(lib).not.toContain("cmd_deepseek_credential_save");
    expect(lib).not.toContain("cmd_geo_provider_credentials_save");
    expect(lib).not.toContain("cmd_geo_provider_capability_verify");
  });

  it("keeps the workbench honest without inventing GeoOperation state", () => {
    const workbench = source(
      "src/renderer/components/xiaojing/XiaojingGeoWorkbench.tsx",
    );
    const operationPanel = source(
      "src/renderer/components/xiaojing/XiaojingGeoOperationPanel.tsx",
    );
    const chat = source("src/renderer/pages/Chat.tsx");
    const starterSuggestions = source(
      "src/renderer/components/chat/ChatStarterSuggestions.tsx",
    );
    expect(workbench).not.toContain("当前没有运行中的 GEO 操作");
    expect(workbench).not.toContain("当前品牌");
    expect(workbench).toContain(
      "在聊天中发起 GEO 目标后，小鲸会先确认事实与目标",
    );
    expect(workbench).toContain("xiaojing:geo-workbench-collapsed");
    expect(workbench).toContain("<XiaojingGeoOperationPanel");
    expect(workbench).toContain("<XiaojingBrandKnowledgePanel");
    // 票 30：历史面板移出工作台，知识版本史与产物血缘整页迁往「品牌档案」。
    expect(workbench).not.toContain("<XiaojingBrandHistoryPanel");
    expect(operationPanel).toContain("<XiaojingQuestionPoolPanel");
    expect(operationPanel).toContain("<XiaojingTopicPlanPanel");
    expect(operationPanel).toContain("<XiaojingArticleGenerationPanel");
    expect(operationPanel).toContain("<XiaojingDistributionPlanPanel");
    expect(operationPanel).toContain("<XiaojingPublishSchedulerPanel");
    expect(operationPanel).toContain("<XiaojingPostPublishMonitoringPanel");
    expect(operationPanel).toContain("<XiaojingRealGeoDashboard");
    // 票 28：骨架按共享六阶段分组渲染手风琴，产物按阶段归属。
    expect(operationPanel).toContain("GEO_OPERATION_PHASES");
    expect(operationPanel).toContain('aria-label="GEO 阶段骨架"');
    // 过程块（阶段总览 grid、执行步骤列表、checkpoint、pending/error
    // 明细）只存在于聊天进度卡，工作台不再渲染。
    expect(operationPanel).not.toContain("GEO 阶段总览");
    expect(operationPanel).not.toContain("最小执行步骤");
    expect(operationPanel).not.toContain("恢复检查点");
    expect(operationPanel).not.toContain("待确认事项");
    expect(operationPanel).not.toContain("已固化产物");
    // Ticket 25：过程控制只有聊天进度卡一个入口——revision CAS 提交钉在
    // 聊天卡上，工作台面板不得再出现任何控制提交路径。
    const eventCard = source(
      "src/renderer/components/xiaojing/GeoOperationEventCard.tsx",
    );
    expect(eventCard).toContain("expectedRevision: live.revision");
    expect(operationPanel).not.toContain("controlGeoOperation");
    expect(operationPanel).not.toContain("runControl");
    expect(workbench).not.toContain("hover:-translate-y-px");
    expect(workbench).not.toContain("hover:border-[var(--accent)]/45");
    expect(workbench).toContain("max-[900px]:absolute");
    // Capability launch cards are gone from the workbench: the four preset GEO
    // goals live only in the chat empty state and send through the normal chat
    // send path, keeping chat the single entry point for starting actions.
    expect(workbench).not.toContain("可启动的 GEO 能力");
    expect(workbench).not.toContain("完整 GEO 优化");
    expect(workbench).not.toContain("问题机会发现");
    expect(workbench).not.toContain("生成 GEO 内容");
    expect(workbench).not.toContain("GEO 效果检测");
    expect(workbench).not.toContain("onOpenWorkspace");
    expect(chat).toContain("<ChatStarterSuggestions");
    expect(starterSuggestions).toContain("starterSuggestions.items.");
    expect(starterSuggestions).not.toContain("onOpenWorkspace");
  });

  it("keeps structured operation events on the existing Session control plane", () => {
    const client = source("src/renderer/api/geoOperationClient.ts");
    const server = source("src/server/routes/xiaojing-geo-operations.ts");
    const shared = source("src/server/routes/xiaojing-shared.ts");
    const toolUse = source("src/renderer/components/ToolUse.tsx");
    const eventCard = source(
      "src/renderer/components/xiaojing/GeoOperationEventCard.tsx",
    );
    expect(client).toContain('"/api/xiaojing/geo-operations/list"');
    expect(client).toContain('"/api/xiaojing/geo-operations/control"');
    expect(client).not.toContain("fetch(");
    expect(client).not.toContain("invoke(");
    expect(server).toContain("payload.sessionId !== runtimeSessionId");
    expect(server).toContain("includeAllSessions: false");
    expect(shared).toContain("buildGeoOperationEventReminder");
    expect(toolUse).toContain("parseGeoOperationEventCard(tool.result)");
    expect(eventCard).toContain("这是系统维护的进度卡片，不是用户发送的消息");
    expect(eventCard).not.toContain('data-message-role="user"');
  });

  it("uses the Rust BrandWorkspace authority instead of legacy project projection", () => {
    const app = source("src/renderer/App.tsx");
    const sidebar = source(
      "src/renderer/components/xiaojing/XiaojingSidebar.tsx",
    );
    const store = source("src-tauri/src/brand_workspace.rs");
    expect(app).toContain("useBrandWorkspaces()");
    expect(sidebar).toContain("createWorkspace");
    expect(sidebar).toContain("switchWorkspace");
    expect(sidebar).toContain("xiaojingSidebar.deleteFailed.");
    expect(store).toContain('"project.sqlite"');
    expect(store).toContain("PRAGMA journal_mode = WAL");
    expect(store).toContain("session_deletion_intents");
    expect(sidebar).not.toContain("useConfig");
  });

  it("surfaces material upload only via the agent-invoked in-chat request card", () => {
    const app = source("src/renderer/App.tsx");
    const chat = source("src/renderer/pages/Chat.tsx");
    const toolUse = source("src/renderer/components/ToolUse.tsx");
    const message = source("src/renderer/components/Message.tsx");
    const requestCard = source(
      "src/renderer/components/xiaojing/MaterialRequestCard.tsx",
    );
    const workbench = source(
      "src/renderer/components/xiaojing/XiaojingGeoWorkbench.tsx",
    );
    const operationPanel = source(
      "src/renderer/components/xiaojing/XiaojingGeoOperationPanel.tsx",
    );
    const gatePanels = source(
      "src/renderer/components/xiaojing/GeoOperationGatePanels.tsx",
    );
    // ADR 0005：输入框上方常驻导入区域删除；上传只出现在 agent 经
    // request_brand_material 发起的消息流卡片上，随转录持久与恢复。
    expect(app).toContain("workspaceForPath(brandState.workspaces, tab.workspacePath)");
    expect(app).toContain("workspacePathsEqual(workspace.rootPath, path)");
    expect(chat).not.toContain("XiaojingChatMaterialImport");
    expect(toolUse).toContain("parseMaterialRequestCard(tool.result)");
    expect(message).toContain("parseMaterialRequestCard");
    expect(requestCard).toContain("useCurrentWorkspace()");
    expect(requestCard).toContain("useTabApi()");
    expect(requestCard).toContain("useTabState()");
    expect(requestCard).toContain("import('@tauri-apps/plugin-dialog')");
    expect(requestCard).not.toContain("readFile");
    // 票 27 的边界保持：工作台与闸门卡仍不出现任何材料面板或导入发起。
    expect(workbench).not.toContain("MaterialImport");
    expect(operationPanel).not.toContain("MaterialImport");
    expect(gatePanels).not.toContain("MaterialImport");
  });

  it("uses the Xiaojing identity and removes generic product controls from GEO chat chrome", () => {
    const input = source(
      "src/renderer/components/chat-input/SimpleChatInput.tsx",
    );
    const entry = source("src/renderer/index.html");
    const main = source("src/renderer/main.tsx");
    expect(input).toContain('placeholder="告诉小鲸你想完成的 GEO 工作…"');
    expect(input).not.toContain("capabilitySurface");
    expect(input).not.toContain("modelOptions");
    expect(input).not.toContain("pluginOptions");
    expect(entry).toContain('lang="zh-CN"');
    expect(entry).toContain("<title>小鲸同学</title>");
    expect(entry).toContain('data-theme-id="xiaojing"');
    expect(entry).not.toContain(
      "localStorage.getItem('xiaojing:theme-bootstrap')",
    );
    expect(main).toContain("<XiaojingI18nSync />");
    expect(main).toContain("<XiaojingThemeRuntime ownsMainWindowBridge>");
  });
});

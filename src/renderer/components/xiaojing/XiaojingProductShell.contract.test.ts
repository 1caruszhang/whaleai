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

  it("mounts the workbench only inside chat tabs so welcome and settings span full width", () => {
    const app = source("src/renderer/App.tsx");
    // 票 28：工作台仅挂载于聊天 Tab；欢迎页/设置页主区全宽。
    expect(app.match(/<XiaojingGeoWorkbench/g)?.length).toBe(1);
    expect(app).not.toContain("activeTab?.view !== 'chat'");
  });

  // 票 30：一级导航机制——品牌级入口跟随当前选中品牌、不依赖任何 Session。
  // 「品牌档案」先落地；「效果」由票 31 复用同一机制加入后，四个一级入口
  // （主聊天、品牌工作台、品牌档案、效果）完整。
  it("hosts brand-level full pages through sidebar primary navigation", () => {
    const app = source("src/renderer/App.tsx");
    const sidebar = source(
      "src/renderer/components/xiaojing/XiaojingSidebar.tsx",
    );
    const archive = source(
      "src/renderer/components/xiaojing/XiaojingBrandArchivePage.tsx",
    );
    const workbench = source(
      "src/renderer/components/xiaojing/XiaojingGeoWorkbench.tsx",
    );
    // 左侧栏一级导航承载品牌档案；入口只调品牌级回调，不经过任何
    // onOpenWorkspace/onOpenSession 会话打开路径。
    expect(sidebar).toContain("onOpenBrandArchive");
    expect(sidebar).toContain("xiaojingSidebar.brandArchive");
    expect(sidebar).toContain("activeTab?.view === 'brand-archive'");
    expect(sidebar).toContain("onClick={onOpenBrandArchive}");
    // 品牌档案是独立整页 tab 视图（单例复用），跟随当前选中品牌，
    // 不绑定任何 Session 身份。
    expect(app).toContain("view: 'brand-archive'");
    expect(app).toContain("<XiaojingBrandArchivePage");
    expect(app).toContain("tab.view === 'brand-archive'");
    expect(app).toContain("brandState.currentWorkspace");
    // 整页只读投影：版本史与产物血缘来自 BrandWorkspace 历史投影，无确认
    // 或动作入口；工作台不再渲染历史面板。
    expect(archive).toContain("loadBrandHistory");
    expect(archive).toContain('aria-label="品牌知识版本"');
    expect(archive).toContain('aria-label="已批准产物"');
    expect(archive).not.toContain("decideGeoKnowledge");
    expect(archive).not.toContain("controlGeoOperation");
    expect(archive).not.toContain("apiPost");
    expect(workbench).not.toContain("BrandHistoryPanel");
  });

  it("registers only focused Session and GEO route families in the Sidecar", () => {
    const composition = source("src/server/sidecar-composition.ts");
    expect(composition).toContain("pathname.startsWith('/api/xiaojing/')");
    expect(composition).toContain("pathname.startsWith('/chat/')");
  });

  it("injects the native DeepSeek secret only into brand Session sidecars", () => {
    const lifecycle = source("src-tauri/src/sidecar/session_lifecycle.rs");
    expect(lifecycle).toMatch(
      /if crate::brand_workspace::is_brand_workspace_path\(workspace_path\) \{\s*crate::deepseek_credentials::inject_into_sidecar/,
    );
    expect(lifecycle).toMatch(
      /else \{\s*cmd\.env_remove\(crate::deepseek_credentials::SIDECAR_SECRET_ENV\)/,
    );
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

  it("mounts material import only in the tab-scoped chat input area", () => {
    const app = source("src/renderer/App.tsx");
    const chat = source("src/renderer/pages/Chat.tsx");
    const materialImport = source(
      "src/renderer/components/xiaojing/XiaojingChatMaterialImport.tsx",
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
    expect(app).toContain("workspaceForPath(brandState.workspaces, tab.workspacePath)");
    expect(app).toContain("workspacePathsEqual(workspace.rootPath, path)");
    expect(chat).toContain("useCurrentWorkspace()");
    expect(chat).toContain("<XiaojingChatMaterialImport");
    // 票 27：材料入口只存在于聊天输入区；工作台与闸门卡不出现材料面板。
    expect(workbench).not.toContain("MaterialImport");
    expect(operationPanel).not.toContain("MaterialImport");
    expect(gatePanels).not.toContain("MaterialImport");
    expect(materialImport).toContain("useTabApi()");
    expect(materialImport).toContain("useTabState()");
    expect(materialImport).toContain("isPendingSessionId(sessionId)");
    expect(materialImport).toContain("import('@tauri-apps/plugin-dialog')");
    expect(materialImport).not.toContain("readFile");
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

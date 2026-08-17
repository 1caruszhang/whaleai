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
    expect(workbench).toContain("在聊天中发起 GEO 目标后，小鲸会先确认事实与目标");
    expect(workbench).toContain("xiaojing:geo-workbench-collapsed");
    expect(workbench).toContain("<XiaojingGeoOperationPanel");
    expect(workbench).toContain("<XiaojingBrandHistoryPanel");
    expect(operationPanel).toContain("<XiaojingQuestionPoolPanel");
    expect(operationPanel).toContain("<XiaojingTopicPlanPanel");
    expect(operationPanel).toContain("<XiaojingArticleGenerationPanel");
    expect(operationPanel).toContain("<XiaojingDistributionPlanPanel");
    expect(operationPanel).toContain("<XiaojingPublishSchedulerPanel");
    expect(operationPanel).toContain("<XiaojingPostPublishMonitoringPanel");
    expect(operationPanel).toContain("<XiaojingRealGeoDashboard");
    expect(operationPanel).toContain('operation.kind === "full-optimization"');
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

  it("mounts material import only inside a tab-scoped Xiaojing workbench", () => {
    const app = source("src/renderer/App.tsx");
    const workbench = source(
      "src/renderer/components/xiaojing/XiaojingGeoWorkbench.tsx",
    );
    const materialPanel = source(
      "src/renderer/components/xiaojing/XiaojingMaterialImportPanel.tsx",
    );
    const operationPanel = source(
      "src/renderer/components/xiaojing/XiaojingGeoOperationPanel.tsx",
    );
    expect(app).toContain("materialImportEnabled");
    expect(app).toContain("tab.view === 'chat' ? workspaceForPath");
    expect(app).toContain("workspacePathsEqual(workspace.rootPath, path)");
    expect(workbench).toContain("<XiaojingGeoOperationPanel");
    expect(operationPanel).toContain("<XiaojingMaterialImportPanel");
    expect(materialPanel).toContain("useTabApi()");
    expect(materialPanel).toContain("useTabState()");
    expect(materialPanel).toContain("isPendingSessionId(sessionId)");
    expect(materialPanel).toContain("import('@tauri-apps/plugin-dialog')");
    expect(materialPanel).not.toContain("readFile");
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
    expect(entry).toContain('<title>小鲸同学</title>');
    expect(entry).toContain('data-theme-id="xiaojing"');
    expect(entry).not.toContain("localStorage.getItem('xiaojing:theme-bootstrap')");
    expect(main).toContain('<XiaojingI18nSync />');
    expect(main).toContain('<XiaojingThemeRuntime ownsMainWindowBridge>');
  });
});

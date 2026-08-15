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
    expect(app).not.toContain("<GlobalSidebar");
    expect(app).not.toContain("onOpenTaskCenter={handleOpenTaskCenter}");
    expect(app).not.toContain("onOpenCapabilities={handleOpenCapabilities}");
    expect(app).toContain("<XiaojingWelcome");
    expect(app).not.toContain("<Launcher");
  });

  it("does not start retired automation or IM products against a legacy data root", () => {
    const nativeApp = source("src-tauri/src/lib.rs");
    const titleGenerator = source("src/server/title-generator.ts");
    expect(nativeApp).not.toContain("cron_task::initialize_cron_manager(");
    expect(nativeApp).not.toContain("im::schedule_auto_start(");
    expect(nativeApp).not.toContain("im::schedule_agent_auto_start(");
    expect(nativeApp).not.toContain("im::monitor_agent_channels(");
    expect(titleGenerator).toContain("process.env.XIAOJING_DATA_ROOT");
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
    expect(workbench).not.toContain("当前没有运行中的 GEO 操作");
    expect(workbench).toContain("选择一项能力后，小鲸会先在会话中确认目标");
    expect(workbench).toContain("xiaojing:geo-workbench-collapsed");
    expect(workbench).toContain("完整 GEO 优化");
    expect(workbench).toContain("问题机会发现");
    expect(workbench).toContain("生成 GEO 内容");
    expect(workbench).toContain("GEO 效果检测");
    expect(workbench).toContain("<XiaojingQuestionPoolPanel");
    expect(workbench).not.toContain("hover:-translate-y-px");
    expect(workbench).not.toContain("hover:border-[var(--accent)]/45");
    expect(workbench).toMatch(/await onOpenWorkspace\(\s*currentWorkspace,\s*\{ text: capability\.prompt \}/);
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
    expect(sidebar).toContain("t('xiaojingSidebar.deletePrompt')");
    expect(store).toContain('"project.sqlite"');
    expect(store).toContain("PRAGMA journal_mode = WAL");
    expect(store).toContain("session_deletion_intents");
    expect(sidebar).not.toContain("useConfig");
    expect(sidebar).not.toContain("useGlobalSidebarTaskCenterData");
  });

  it("mounts material import only inside a tab-scoped Xiaojing workbench", () => {
    const app = source("src/renderer/App.tsx");
    const workbench = source(
      "src/renderer/components/xiaojing/XiaojingGeoWorkbench.tsx",
    );
    const materialPanel = source(
      "src/renderer/components/xiaojing/XiaojingMaterialImportPanel.tsx",
    );
    expect(app).toContain("materialImportEnabled={kind !== 'deferred-chat'}");
    expect(app).toContain("tab.view === 'chat' && tab.agentDir");
    expect(app).toContain("workspacePathsEqual(workspace.rootPath, tab.agentDir!)");
    expect(workbench).toContain("<XiaojingMaterialImportPanel");
    expect(materialPanel).toContain("useTabApi()");
    expect(materialPanel).toContain("useTabState()");
    expect(materialPanel).toContain("isPendingSessionId(sessionId)");
    expect(materialPanel).toContain("import('@tauri-apps/plugin-dialog')");
    expect(materialPanel).not.toContain("readFile");
  });

  it("uses the Xiaojing identity and removes generic product controls from GEO chat chrome", () => {
    const product = source("src/shared/product.ts");
    const launcher = source(
      "src/renderer/components/launcher/BrandSection.tsx",
    );
    const input = source(
      "src/renderer/components/chat-input/SimpleChatInput.tsx",
    );
    const entry = source("src/renderer/index.html");
    const main = source("src/renderer/main.tsx");
    expect(product).toMatch(/displayName:\s*["']小鲸同学["']/);
    expect(product).toMatch(/internalName:\s*["']Xiaojing["']/);
    expect(launcher).toContain("variant === 'xiaojing'");
    expect(launcher).toContain('capabilitySurface="geo"');
    expect(launcher).toContain('resolvedTheme.hero.productName');
    expect(launcher).toContain("resolvedTheme.hero.slogans['zh-CN']");
    expect(input).toContain("const isGeoSurface = capabilitySurface === 'geo'");
    expect(input).toContain("{!isGeoSurface && (");
    expect(entry).toContain('lang="zh-CN"');
    expect(entry).toContain('data-theme-id="xiaojing"');
    expect(entry).not.toContain("localStorage.getItem('myagents:theme-bootstrap')");
    expect(main).toContain('<XiaojingI18nSync />');
    expect(main).toContain('<XiaojingThemeRuntime>');
    expect(main).toContain('<XiaojingThemeRuntime ownsMainWindowBridge>');
  });
});

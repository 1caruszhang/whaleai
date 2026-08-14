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

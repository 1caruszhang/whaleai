import {
  BarChart3,
  ChevronLeft,
  ChevronRight,
  FilePenLine,
  Radar,
  SearchCheck,
  Sparkles,
} from "lucide-react";
import {
  memo,
  useCallback,
  useState,
  type ComponentType,
} from "react";

import type { BrandWorkspace } from "@/api/brandWorkspaceClient";
import type { InitialMessage } from "@/types/tab";
import XiaojingMaterialImportPanel from "./XiaojingMaterialImportPanel";
import XiaojingQuestionPoolPanel from "./XiaojingQuestionPoolPanel";

interface XiaojingGeoWorkbenchProps {
  currentWorkspace: BrandWorkspace | null;
  onOpenWorkspace: (
    workspace: BrandWorkspace,
    initialMessage?: InitialMessage,
    entryIntent?: "open_workspace" | "workspace_init",
  ) => Promise<boolean>;
  materialImportEnabled?: boolean;
}

interface GeoCapability {
  title: string;
  description: string;
  prompt: string;
  icon: ComponentType<{ className?: string }>;
}

const GEO_CAPABILITIES: readonly GeoCapability[] = [
  {
    title: "完整 GEO 优化",
    description: "从品牌理解到发布监测的受控闭环",
    prompt: "请为当前品牌开始一次完整 GEO 优化，先核对品牌事实和本次目标。",
    icon: Sparkles,
  },
  {
    title: "问题机会发现",
    description: "挖掘用户真正会向 AI 提出的问题",
    prompt: "请为当前品牌挖掘 GEO 问题机会，先确认行业、地域和重点产品线。",
    icon: SearchCheck,
  },
  {
    title: "生成 GEO 内容",
    description: "基于权威品牌事实生成可引用内容",
    prompt:
      "请基于当前品牌知识生成 GEO 内容，先询问我本次的主题、数量和发布场景。",
    icon: FilePenLine,
  },
  {
    title: "GEO 效果检测",
    description: "使用真实探测数据评估品牌可见性",
    prompt:
      "请检测当前品牌的 GEO 表现，只使用真实探测数据，先确认检测范围和引擎。",
    icon: Radar,
  },
] as const;

export default memo(function XiaojingGeoWorkbench({
  currentWorkspace,
  onOpenWorkspace,
  materialImportEnabled = false,
}: XiaojingGeoWorkbenchProps) {
  const [collapsed, setCollapsed] = useState(
    () =>
      typeof localStorage !== "undefined" &&
      localStorage.getItem("xiaojing:geo-workbench-collapsed") === "true",
  );
  const [startingPrompt, setStartingPrompt] = useState<string | null>(null);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((value) => {
      const next = !value;
      localStorage.setItem("xiaojing:geo-workbench-collapsed", String(next));
      return next;
    });
  }, []);

  const startCapability = useCallback(
    async (capability: GeoCapability) => {
      if (!currentWorkspace || startingPrompt) return;
      setStartingPrompt(capability.prompt);
      try {
        await onOpenWorkspace(
          currentWorkspace,
          { text: capability.prompt },
          "open_workspace",
        );
      } finally {
        setStartingPrompt(null);
      }
    },
    [currentWorkspace, onOpenWorkspace, startingPrompt],
  );

  if (collapsed) {
    return (
      <aside
        className="flex w-12 shrink-0 flex-col items-center border-l border-[var(--line)] bg-[var(--global-sidebar-bg)] py-3"
        data-xiaojing-workbench="collapsed"
      >
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label="展开 GEO 工作台"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <BarChart3 className="mt-5 h-4 w-4 text-[var(--accent)]" />
        <span className="mt-3 [writing-mode:vertical-rl] text-xs font-semibold tracking-[0.18em] text-[var(--ink-muted)]">
          GEO 工作台
        </span>
      </aside>
    );
  }

  return (
    <aside
      className="flex w-[320px] shrink-0 flex-col border-l border-[var(--line)] bg-[var(--global-sidebar-bg)] text-[var(--ink)]"
      data-xiaojing-workbench="expanded"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--line-subtle)] px-4">
        <BarChart3 className="h-4 w-4 text-[var(--accent)]" />
        <h2 className="text-sm font-semibold">GEO 工作台</h2>
        <span className="rounded-full bg-[var(--accent-warm-subtle)] px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-[var(--accent)]">
          就绪
        </span>
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label="折叠 GEO 工作台"
          className="ml-auto flex h-7 w-7 items-center justify-center rounded-lg text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <section className="overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--paper-elevated)]">
          <div className="h-1 bg-[var(--accent)]" />
          <div className="p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--accent)]">
              当前品牌
            </p>
            <h3 className="mt-2 truncate text-base font-semibold">
              {currentWorkspace?.name ?? "尚未创建品牌"}
            </h3>
            <p className="mt-2 text-xs leading-5 text-[var(--ink-muted)]">
              {currentWorkspace
                ? "选择一项能力后，小鲸会先在会话中确认目标，再创建受控的 GEO 操作。"
                : "先在左侧选择品牌，再启动 GEO 能力。"}
            </p>
          </div>
        </section>

        {materialImportEnabled && currentWorkspace && (
          <>
            <XiaojingMaterialImportPanel
              key={`${currentWorkspace.id}:materials`}
              workspaceId={currentWorkspace.id}
            />
            <XiaojingQuestionPoolPanel
              key={`${currentWorkspace.id}:question-pool`}
              workspaceId={currentWorkspace.id}
              productLines={currentWorkspace.productLines}
            />
          </>
        )}

        <div className="mb-3 mt-6 flex items-center justify-between">
          <h3 className="text-xs font-semibold">可启动的 GEO 能力</h3>
          <span className="text-xs text-[var(--ink-subtle)]">
            按意图最小执行
          </span>
        </div>
        <div className="space-y-2.5">
          {GEO_CAPABILITIES.map((capability) => {
            const Icon = capability.icon;
            const starting = startingPrompt === capability.prompt;
            return (
              <button
                key={capability.title}
                type="button"
                onClick={() => {
                  void startCapability(capability);
                }}
                disabled={!currentWorkspace || startingPrompt !== null}
                className="flex w-full items-start gap-3 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-3 text-left transition-shadow hover:shadow-sm disabled:opacity-55"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-warm-subtle)] text-[var(--accent)]">
                  <Icon
                    className={`h-4 w-4 ${starting ? "animate-pulse" : ""}`}
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-[var(--ink)]">
                    {capability.title}
                  </span>
                  <span className="mt-1 block text-xs leading-4 text-[var(--ink-muted)]">
                    {capability.description}
                  </span>
                </span>
                <ChevronRight className="mt-2 h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  );
});

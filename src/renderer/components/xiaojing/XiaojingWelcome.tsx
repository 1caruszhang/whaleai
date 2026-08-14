import { ArrowLeft, Building2, MessageSquareText, Sparkles } from 'lucide-react';

import xiaojingLogo from '@/assets/brand/xiaojing-logo.png';
import type { AssistantEntry, EntryIntent, Surface } from '@/analytics';
import type { Project } from '@/config/types';
import type { InitialMessage, LaunchSessionBirthHint } from '@/types/tab';

interface XiaojingWelcomeProps {
  /** Host-owned workspace transition seam. Brand selection currently starts from the sidebar. */
  onLaunchProject: (
    project: Project,
    initialMessage?: InitialMessage,
    analyticsContext?: {
      surface?: Surface;
      entryIntent?: EntryIntent;
      assistantEntry?: AssistantEntry;
    },
    sessionBirthHint?: LaunchSessionBirthHint,
  ) => void;
}

/** First-run center surface. The legacy generic Launcher stays compiled but is never the product entry. */
export default function XiaojingWelcome({ onLaunchProject }: XiaojingWelcomeProps) {
  // Keep the host transition seam attached to this Tab surface even though
  // the product's current selection affordance lives in XiaojingSidebar.
  void onLaunchProject;
  return (
    <main className="flex h-full items-center justify-center overflow-y-auto bg-[var(--paper)] px-8 py-12 text-[var(--ink)]" data-xiaojing-welcome>
      <div className="w-full max-w-3xl">
        <div className="flex items-center gap-4">
          <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-2xl bg-white shadow-sm">
            <img src={xiaojingLogo} alt="" className="h-14 w-14 object-contain" />
          </div>
          <div>
            <p className="text-sm font-semibold tracking-[0.18em] text-[var(--accent)]">小鲸同学</p>
            <h1 className="mt-1 text-3xl font-semibold">从一个真实品牌开始 GEO 工作</h1>
          </div>
        </div>

        <p className="mt-6 max-w-2xl text-base leading-7 text-[var(--ink-muted)]">
          建立品牌工作区后，小鲸会在独立会话中理解目标、组织 GEO 分析，并只调用产品登记的受控能力。
        </p>

        <div className="mt-8 grid gap-3 md:grid-cols-3">
          {[
            [Building2, '建立品牌边界', '品牌知识、会话与产物相互隔离。'],
            [MessageSquareText, '持续对话', '每个 Session 都能暂停、恢复和续聊。'],
            [Sparkles, '受控 GEO 能力', '明确确认后才进入后续操作。'],
          ].map(([Icon, title, description]) => (
            <section key={String(title)} className="rounded-2xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4">
              <Icon className="h-5 w-5 text-[var(--accent)]" />
              <h2 className="mt-3 text-sm font-semibold">{title as string}</h2>
              <p className="mt-1 text-xs leading-5 text-[var(--ink-muted)]">{description as string}</p>
            </section>
          ))}
        </div>

        <div className="mt-8 flex items-center gap-2 text-sm font-medium text-[var(--accent)]">
          <ArrowLeft className="h-4 w-4" />
          请在左侧点击“创建品牌”进入工作台
        </div>
      </div>
    </main>
  );
}

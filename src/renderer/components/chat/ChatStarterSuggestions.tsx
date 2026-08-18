import { FilePenLine, Radar, SearchCheck, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ComponentType } from 'react';

const STARTER_SUGGESTION_KEYS = [
  'fullOptimization',
  'questionOpportunities',
  'contentGeneration',
  'effectInspection',
] as const;

export type ChatStarterSuggestionKey = (typeof STARTER_SUGGESTION_KEYS)[number];

const SUGGESTION_ICONS: Record<ChatStarterSuggestionKey, ComponentType<{ className?: string }>> = {
  fullOptimization: Sparkles,
  questionOpportunities: SearchCheck,
  contentGeneration: FilePenLine,
  effectInspection: Radar,
};

export interface ChatStarterSuggestionsProps {
  /** Sends the preset first message through the normal chat send path. */
  onSend: (prompt: string) => void;
  disabled?: boolean;
}

/**
 * Chat empty-state starter suggestions: the four preset GEO goals that used to
 * live on workbench capability cards. Clicking sends the preset message in the
 * current session, so chat stays the single entry point for starting actions.
 */
export default function ChatStarterSuggestions({ onSend, disabled = false }: ChatStarterSuggestionsProps) {
  const { t } = useTranslation('chat');

  return (
    <div className="py-16 text-center" data-chat-starter-suggestions>
      <p className="text-sm text-[var(--ink-muted)]">{t('starterSuggestions.heading')}</p>
      <p className="mt-1 text-xs text-[var(--ink-subtle)]">{t('starterSuggestions.hint')}</p>
      <div className="mx-auto mt-5 grid max-w-xl gap-2.5 text-left sm:grid-cols-2">
        {STARTER_SUGGESTION_KEYS.map((key) => {
          const Icon = SUGGESTION_ICONS[key];
          return (
            <button
              key={key}
              type="button"
              onClick={() => onSend(t(`starterSuggestions.items.${key}.prompt`))}
              disabled={disabled}
              className="flex items-start gap-3 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-3 transition-shadow hover:shadow-sm disabled:pointer-events-none disabled:opacity-55"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-warm-subtle)] text-[var(--accent)]">
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-[var(--ink)]">
                  {t(`starterSuggestions.items.${key}.title`)}
                </span>
                <span className="mt-1 block text-xs leading-4 text-[var(--ink-muted)]">
                  {t(`starterSuggestions.items.${key}.description`)}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

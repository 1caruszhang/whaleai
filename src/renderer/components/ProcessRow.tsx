import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { memo, useState } from 'react';

import type { ContentBlock } from '@/types/chat';
import Markdown from './Markdown';
import ToolUse from './ToolUse';

interface ProcessRowProps {
  block: ContentBlock;
  isStreaming?: boolean;
  onUserExpand?: () => void;
}

/** Compact trace row for fixed-Agent thinking and GEO tool calls. */
export default memo(function ProcessRow({ block, isStreaming, onUserExpand }: ProcessRowProps) {
  const [expanded, setExpanded] = useState(block.type === 'tool_use' || block.type === 'server_tool_use');
  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) onUserExpand?.();
  };

  if (block.type === 'text') return <div data-process-row className="px-3 py-2"><Markdown>{block.text ?? ''}</Markdown></div>;
  if (block.type === 'thinking') {
    return (
      <div data-process-row className="border-b border-[var(--line-subtle)] last:border-b-0">
        <button type="button" aria-expanded={expanded} onClick={toggle} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--ink-muted)]">
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          {isStreaming && !block.isComplete && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          <span>思考过程</span>
        </button>
        {expanded && block.thinking && <div className="px-4 pb-3 text-sm text-[var(--ink-secondary)]"><Markdown>{block.thinking}</Markdown></div>}
      </div>
    );
  }
  if ((block.type === 'tool_use' || block.type === 'server_tool_use') && block.tool) {
    return <div data-process-row data-tool-id={block.tool.id} className="border-b border-[var(--line-subtle)] px-3 py-2 last:border-b-0"><ToolUse tool={block.tool} /></div>;
  }
  return <></>;
});

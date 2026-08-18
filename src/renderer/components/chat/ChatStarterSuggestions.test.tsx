import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithTheme } from '@/test/renderWithTheme';
import { classifyGeoIntent } from '../../../shared/geo/operation';
import ChatStarterSuggestions from './ChatStarterSuggestions';

// The four GEO-goal presets must stay byte-identical to the original workbench
// launch cards so intent classification semantics are unchanged. The material
// starter (ADR 0005) leads the list: it is the cold-start guidance for brands
// without confirmed knowledge and sends an explicit material request.
const PRESET_PROMPTS: readonly {
  title: string;
  prompt: string;
  intent?: 'full-optimization' | 'question-opportunities' | 'performance-inspection';
}[] = [
  {
    title: '导入品牌材料',
    prompt: '我想先补充品牌材料，请帮我发起材料导入。',
  },
  {
    title: '完整 GEO 优化',
    prompt: '请为当前品牌开始一次完整 GEO 优化，先核对品牌事实和本次目标。',
    intent: 'full-optimization',
  },
  {
    title: '问题机会发现',
    prompt: '请为当前品牌挖掘 GEO 问题机会，先确认行业、地域和重点产品线。',
    intent: 'question-opportunities',
  },
  {
    title: '生成 GEO 内容',
    prompt: '请基于当前品牌知识生成 GEO 内容，先询问我本次的主题、数量和发布场景。',
  },
  {
    title: 'GEO 效果检测',
    prompt: '请检测当前品牌的 GEO 表现，只使用真实探测数据，先确认检测范围和引擎。',
    intent: 'performance-inspection',
  },
];

describe('ChatStarterSuggestions', () => {
  it('renders the preset goals in the chat empty state', () => {
    renderWithTheme(<ChatStarterSuggestions onSend={vi.fn()} />);

    expect(screen.getByText('告诉小鲸你想先完成哪一步 GEO 工作。')).toBeInTheDocument();
    for (const preset of PRESET_PROMPTS) {
      expect(screen.getByRole('button', { name: new RegExp(preset.title) })).toBeEnabled();
    }
  });

  it('sends the preset prompt of the clicked suggestion', () => {
    const onSend = vi.fn();
    renderWithTheme(<ChatStarterSuggestions onSend={onSend} />);

    for (const preset of PRESET_PROMPTS) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(preset.title) }));
    }

    expect(onSend.mock.calls.map(([prompt]) => prompt)).toEqual(
      PRESET_PROMPTS.map((preset) => preset.prompt),
    );
  });

  it('blocks sending while the chat cannot accept a message', () => {
    const onSend = vi.fn();
    renderWithTheme(<ChatStarterSuggestions onSend={onSend} disabled />);

    for (const preset of PRESET_PROMPTS) {
      expect(screen.getByRole('button', { name: new RegExp(preset.title) })).toBeDisabled();
    }

    fireEvent.click(screen.getByRole('button', { name: /完整 GEO 优化/ }));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('keeps the deterministic direct-intent routing of the preset prompts unchanged', () => {
    // Natural language naming a stage still goes through direct intent; the
    // classifier sees the exact same texts the launch cards used to send.
    for (const preset of PRESET_PROMPTS) {
      if (!preset.intent) continue;
      expect(classifyGeoIntent(preset.prompt)).toBe(preset.intent);
    }
  });

  it('routes the material starter to a material request, not an operation intent', () => {
    // ADR 0005：材料引导语必须落在 request_brand_material（标准④），
    // 不得被决策表误判为任何 GEO 操作意图。
    expect(classifyGeoIntent('我想先补充品牌材料，请帮我发起材料导入。')).toBeNull();
  });
});

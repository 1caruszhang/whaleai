import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithTheme as render } from '@/test/renderWithTheme';
import { XiaojingThemeRuntime } from '@/theme';
import {
  buildKnowledgeCandidatesCardData,
  KNOWLEDGE_CARD_MAX_CANDIDATES,
  toKnowledgeCardCandidate,
  type KnowledgeCardCandidateSource,
} from '../../../shared/geo/knowledgeCard';

const mocks = vi.hoisted(() => ({ apiPost: vi.fn() }));

vi.mock('@/context/TabContext', () => ({
  useTabApi: () => ({ apiPost: mocks.apiPost }),
  useTabState: () => ({}),
}));

import KnowledgeBatchCard, { KNOWLEDGE_DECIDED_EVENT } from './KnowledgeBatchCard';
import ToolUse from '../ToolUse';
import type { ToolUseSimple } from '@/types/chat';

/** 顶层 `predicate` 便捷覆盖会同步进 `key.predicate`（字段行分组按它归组）。 */
function candidateSource(
  overrides: Partial<KnowledgeCardCandidateSource> & { predicate?: string } = {},
): KnowledgeCardCandidateSource {
  const { predicate = 'enterprise-profile.coreAdvantages', ...rest } = overrides;
  const defaults: KnowledgeCardCandidateSource = {
    id: 'candidate-1',
    workspaceId: 'brand-1',
    sessionId: 'session-1',
    key: {
      subject: '鲸跃科技',
      predicate,
      scopeJson: '{"entityScope":"brand"}',
      effectiveFrom: null,
      effectiveTo: null,
    },
    valueJson: '["技术领先"]',
    normalizedValueJson: '["技术领先"]',
    unit: null,
    status: 'awaiting-confirmation',
    baseVersion: 0,
    origin: 'model-inferred',
    source: {
      materialId: 'material-1',
      excerpt: '核心技术行业领先',
      confidence: 0.9,
      profileProvenance: 'extracted',
    },
    current: null,
  };
  return {
    ...defaults,
    ...rest,
    key: { ...defaults.key, ...(rest.key ?? {}) },
  };
}

function cardData(
  sources: KnowledgeCardCandidateSource[],
  material: { id: string; displayName: string } | null = { id: 'material-1', displayName: '资料.md' },
) {
  const built = buildKnowledgeCandidatesCardData(
    material,
    sources.map(toKnowledgeCardCandidate),
  );
  if (!built) throw new Error('card required');
  return built;
}

function rowFields(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-field-row]'))
    .map((row) => row.getAttribute('data-field-row') ?? '');
}

/** 展开某字段行详情：行头按钮的可访问名以字段标签开头（区别于冲突选择按钮）。 */
function expandRow(label: string) {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${label}`) }));
}

describe('KnowledgeBatchCard（字段行复核卡）', () => {
  beforeEach(() => {
    mocks.apiPost.mockReset();
    // 默认：水合返回全部待确认；decide-batch 逐条成功。
    mocks.apiPost.mockImplementation(async (path: string, body?: {
      candidateIds?: string[];
      decisions?: Array<{ candidateId: string; decision: string }>;
    }) => {
      if (path === '/api/xiaojing/knowledge/candidates') {
        return { success: true, candidates: (body?.candidateIds ?? []).map(() => null) };
      }
      return {
        success: true,
        results: (body?.decisions ?? []).map((decision) => ({
          candidateId: decision.candidateId,
          ok: true,
          status: decision.decision === 'keep-current' ? 'kept-current' : 'adopted',
        })),
      };
    });
  });

  it('默认展开并按固定字段序分行合并：无勾选框、批量开关、置信分组或卡级溢出总数', () => {
    const { container } = render(<KnowledgeBatchCard data={cardData([
      candidateSource({ id: 'c-products', predicate: 'enterprise-profile.products', valueJson: '["电动车"]', normalizedValueJson: '["电动车"]' }),
      candidateSource({ id: 'c-fullname', predicate: 'enterprise-profile.fullName', valueJson: '"鲸跃科技"', normalizedValueJson: '"鲸跃科技"' }),
      // 同字段不同 scope 的多值合并进同一行。
      candidateSource({
        id: 'c-products-line',
        predicate: 'enterprise-profile.products',
        key: {
          subject: '鲸跃科技/电动车',
          predicate: 'enterprise-profile.products',
          scopeJson: '{"entityScope":"product-line","productLine":"电动车"}',
          effectiveFrom: null,
          effectiveTo: null,
        },
        valueJson: '["充电桩"]',
        normalizedValueJson: '["充电桩"]',
      }),
      candidateSource({ id: 'c-advantage' }),
    ])} />);

    // 默认展开：字段行直接可见，固定字段序 fullName → products → coreAdvantages。
    expect(rowFields(container)).toEqual(['fullName', 'products', 'coreAdvantages']);
    // 值在行内直接可扫读；同字段多值合并展示。
    expect(screen.getByText('鲸跃科技')).toBeInTheDocument();
    expect(screen.getByText('电动车；充电桩')).toBeInTheDocument();

    // 不再出现逐条勾选与批量采用交互，也没有高/低置信分组。
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '全部采用' })).not.toBeInTheDocument();
    expect(screen.queryByText(/高置信/)).not.toBeInTheDocument();
    expect(screen.queryByText(/超出卡片上限/)).not.toBeInTheDocument();
  });

  it('材料原文行零控件、徽章已就绪；整卡全原文零冲突也必须点一次确认才提交', async () => {
    render(<KnowledgeBatchCard data={cardData([
      candidateSource({ id: 'c-fullname', predicate: 'enterprise-profile.fullName', valueJson: '"鲸跃科技"', normalizedValueJson: '"鲸跃科技"' }),
    ])} />);

    const fullNameRow = screen.getByText('品牌全称').closest('article');
    expect(fullNameRow).toHaveAttribute('data-row-tier', 'ready');
    expect(screen.getByText('已就绪')).toBeInTheDocument();
    expect(within(fullNameRow!).queryByRole('button', { name: /确认|采用新值|保留当前值/ })).not.toBeInTheDocument();

    // 不自动采纳：水合完成后也没有 decide-batch 请求。
    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith(
      '/api/xiaojing/knowledge/candidates',
      expect.anything(),
    ));
    expect(mocks.apiPost.mock.calls.every(([path]) => path !== '/api/xiaojing/knowledge/decide-batch')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '确认（采纳全部 1 条）' }));
    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith(
      '/api/xiaojing/knowledge/decide-batch',
      expect.objectContaining({
        decisions: [expect.objectContaining({ candidateId: 'c-fullname', decision: 'adopt-new' })],
      }),
    ));
  });

  it('AI 补全行徽章待确认，一键确认是纯视觉糖：不产生独立提交', () => {
    render(<KnowledgeBatchCard data={cardData([
      candidateSource({
        id: 'c-advantage',
        source: { materialId: 'material-1', excerpt: '推断优势', confidence: 0.4, profileProvenance: 'inferred' },
      }),
    ])} />);

    const row = screen.getByText('核心优势').closest('article');
    expect(row).toHaveAttribute('data-row-tier', 'pending');
    expect(screen.getByText('待确认')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '确认核心优势' }));
    // 点完变绿：行徽章翻成已就绪，确认按钮消失。
    expect(screen.getByText('已就绪')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '确认核心优势' })).not.toBeInTheDocument();

    // 纯视觉糖：没有任何 decide-batch 提交。
    expect(mocks.apiPost.mock.calls.every(([path]) => path !== '/api/xiaojing/knowledge/decide-batch')).toBe(true);
  });

  it('行内不显示摘录与置信度，展开详情才可见依据', () => {
    render(<KnowledgeBatchCard data={cardData([
      candidateSource({ id: 'c-advantage', source: { materialId: 'material-1', excerpt: '核心技术行业领先', confidence: 0.9, profileProvenance: 'extracted' } }),
    ])} />);

    expect(screen.queryByText(/核心技术行业领先/)).not.toBeInTheDocument();
    expect(screen.queryByText('90%')).not.toBeInTheDocument();

    expandRow('核心优势');
    expect(screen.getByText('依据：核心技术行业领先')).toBeInTheDocument();
    expect(screen.getByText('90%')).toBeInTheDocument();
    expect(screen.getByText('材料原文')).toBeInTheDocument();
  });

  it('冲突行必须内联二选一，未解决前整卡确认禁用', async () => {
    render(<KnowledgeBatchCard data={cardData([
      candidateSource({
        id: 'c-conflict',
        status: 'conflict',
        baseVersion: 2,
        current: {
          normalizedValueJson: '["口碑服务"]',
          unit: null,
          version: 2,
          confirmedBy: 'user-1',
          confirmedAt: '2026-08-15T00:00:00Z',
        },
      }),
    ])} />);

    const confirmButton = screen.getByRole('button', { name: '确认（采纳全部 1 条）' });
    expect(confirmButton).toBeDisabled();
    expect(screen.getByText('还有 1 条冲突待选择')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '采用新值：核心优势' }));
    expect(screen.getByRole('button', { name: '采用新值：核心优势' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(confirmButton).toBeEnabled());
    expect(screen.queryByText('还有 1 条冲突待选择')).not.toBeInTheDocument();

    // 冲突的当前权威值也收进展开详情。
    expect(screen.queryByText(/当前权威值/)).not.toBeInTheDocument();
    expandRow('核心优势');
    expect(screen.getByText(/当前权威值 v2/)).toBeInTheDocument();
  });

  it('一次确认整卡全量采纳：未碰过的补全行也 adopt-new，冲突行按内联选择提交', async () => {
    const listener = vi.fn();
    window.addEventListener(KNOWLEDGE_DECIDED_EVENT, listener);
    render(<KnowledgeBatchCard data={cardData([
      candidateSource({ id: 'c-fullname', predicate: 'enterprise-profile.fullName', valueJson: '"鲸跃科技"', normalizedValueJson: '"鲸跃科技"' }),
      // 从未被用户碰过的 AI 补全行。
      candidateSource({
        id: 'c-competitors',
        predicate: 'enterprise-profile.competitors',
        valueJson: '["友商A"]',
        normalizedValueJson: '["友商A"]',
        source: { materialId: 'material-1', excerpt: '推断竞品', confidence: 0.4, profileProvenance: 'inferred' },
      }),
      candidateSource({
        id: 'c-conflict',
        status: 'conflict',
        baseVersion: 2,
        current: {
          normalizedValueJson: '["口碑服务"]',
          unit: null,
          version: 2,
          confirmedBy: 'user-1',
          confirmedAt: '2026-08-15T00:00:00Z',
        },
      }),
    ])} />);

    fireEvent.click(screen.getByRole('button', { name: '保留当前值：核心优势' }));
    fireEvent.click(screen.getByRole('button', { name: '确认（采纳全部 3 条）' }));

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith(
      '/api/xiaojing/knowledge/decide-batch',
      expect.objectContaining({
        workspaceId: 'brand-1',
        sessionId: 'session-1',
        decisions: [
          expect.objectContaining({ candidateId: 'c-fullname', decision: 'adopt-new' }),
          expect.objectContaining({ candidateId: 'c-competitors', decision: 'adopt-new' }),
          expect.objectContaining({ candidateId: 'c-conflict', decision: 'keep-current', expectedCurrentVersion: 2 }),
        ],
      }),
    ));

    // 成功后卡片变暗只读、逐行呈现结果。
    expect(await screen.findByText(/全部候选已裁决/)).toBeInTheDocument();
    const section = screen.getByText('品牌知识待确认').closest('section');
    expect(section).toHaveAttribute('data-settled', 'true');
    expect(screen.getByText('已裁决 · 只读')).toBeInTheDocument();
    // 两条 adopt-new 行各呈现一个「已采用」；keep-current 冲突行呈现「保留当前值」。
    expect(screen.getAllByText('已采用')).toHaveLength(2);
    expect(screen.getAllByText('保留当前值')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /确认（采纳全部/ })).not.toBeInTheDocument();
    await waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    window.removeEventListener(KNOWLEDGE_DECIDED_EVENT, listener);
  });

  it('部分失败：失败行保留操作，可单独重试', async () => {
    let submitCalls = 0;
    mocks.apiPost.mockImplementation(async (path: string, body?: {
      candidateIds?: string[];
      decisions?: Array<{ candidateId: string }>;
    }) => {
      if (path === '/api/xiaojing/knowledge/candidates') {
        return { success: true, candidates: (body?.candidateIds ?? []).map(() => null) };
      }
      submitCalls += 1;
      return {
        success: false,
        results: (body?.decisions ?? []).map((decision) => ({
          candidateId: decision.candidateId,
          ok: submitCalls === 1 ? decision.candidateId !== 'c-advantage' : true,
          status: 'adopted',
          ...(submitCalls === 1 && decision.candidateId === 'c-advantage'
            ? { error: 'knowledge_version_conflict' }
            : {}),
        })),
      };
    });
    render(<KnowledgeBatchCard data={cardData([
      candidateSource({ id: 'c-fullname', predicate: 'enterprise-profile.fullName', valueJson: '"鲸跃科技"', normalizedValueJson: '"鲸跃科技"' }),
      candidateSource({ id: 'c-advantage' }),
    ])} />);

    fireEvent.click(screen.getByRole('button', { name: '确认（采纳全部 2 条）' }));
    // 部分失败横幅 + 卡级按钮转为重试；失败行的徽章与重试在收起状态直接可见。
    expect(await screen.findByText(/部分候选裁决失败/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试失败的 1 条' })).toBeInTheDocument();
    const advantageRow = screen.getByText('核心优势').closest('article');
    expect(advantageRow).toHaveAttribute('data-row-tier', 'failed');
    expect(within(advantageRow as HTMLElement).getByText('失败')).toBeInTheDocument();

    // 失败原因收在展开详情；行内重试只提交失败的那条。
    expandRow('核心优势');
    expect(screen.getByText(/knowledge_version_conflict/)).toBeInTheDocument();
    fireEvent.click(within(advantageRow as HTMLElement).getByRole('button', { name: '重试：核心优势' }));

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledTimes(3));
    const retryCall = mocks.apiPost.mock.calls[2];
    expect(retryCall[0]).toBe('/api/xiaojing/knowledge/decide-batch');
    expect(retryCall[1]).toEqual(expect.objectContaining({
      decisions: [expect.objectContaining({ candidateId: 'c-advantage', decision: 'adopt-new' })],
    }));
    expect(await screen.findByText(/全部候选已裁决/)).toBeInTheDocument();
  });

  it('被截断字段在行内提示未展示条数，不再给卡级溢出总数', () => {
    const sources = [
      ...Array.from({ length: 2 }, (_, index) =>
        candidateSource({
          id: `c-fullname-${index}`,
          predicate: 'enterprise-profile.fullName',
          valueJson: `"鲸跃科技${index}`,
          normalizedValueJson: `"鲸跃科技${index}`,
        })),
      ...Array.from({ length: KNOWLEDGE_CARD_MAX_CANDIDATES + 5 }, (_, index) =>
        candidateSource({ id: `c-products-${index}`, predicate: 'enterprise-profile.products' })),
    ];
    const { container } = render(<KnowledgeBatchCard data={cardData(sources)} />);

    expect(screen.getByText(/共 50 条候选/)).toBeInTheDocument();
    expect(screen.queryByText(/超出卡片上限/)).not.toBeInTheDocument();
    const productsRow = container.querySelector('[data-field-row="products"]');
    expect(within(productsRow as HTMLElement).getByText('该字段另有 7 条未展示')).toBeInTheDocument();
    const fullNameRow = container.querySelector('[data-field-row="fullName"]');
    expect(within(fullNameRow as HTMLElement).queryByText(/另有/)).not.toBeInTheDocument();
  });

  it('逐行确认与冲突选择按候选 id 键控，轮询投影重建后不丢失', () => {
    const sources = [
      candidateSource({
        id: 'c-industry',
        predicate: 'enterprise-profile.industry',
        valueJson: '"汽车后市场"',
        normalizedValueJson: '"汽车后市场"',
        source: { materialId: 'material-1', excerpt: '推断行业', confidence: 0.4, profileProvenance: 'inferred' },
      }),
      candidateSource({
        id: 'c-conflict',
        status: 'conflict',
        baseVersion: 3,
        current: {
          normalizedValueJson: '["口碑服务"]',
          unit: null,
          version: 3,
          confirmedBy: 'user-1',
          confirmedAt: '2026-08-15T00:00:00Z',
        },
      }),
    ];
    const view = render(<KnowledgeBatchCard data={cardData(sources)} />);
    fireEvent.click(screen.getByRole('button', { name: '确认行业' }));
    fireEvent.click(screen.getByRole('button', { name: '采用新值：核心优势' }));

    // 模拟 3s 轮询：服务端返回全新构建的 data 投影对象（同包装、同挂载点，不重挂载卡片）。
    view.rerender(
      <XiaojingThemeRuntime>
        <KnowledgeBatchCard data={cardData(sources)} />
      </XiaojingThemeRuntime>,
    );

    expect(screen.getByText('行业').closest('article')).toHaveAttribute('data-row-tier', 'ready');
    expect(screen.getByRole('button', { name: '采用新值：核心优势' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('会话重载后水合已裁决候选，行内直接呈现结果且无操作', async () => {
    mocks.apiPost.mockImplementation(async (path: string) => {
      if (path === '/api/xiaojing/knowledge/candidates') {
        return {
          success: true,
          candidates: [{
            ...toKnowledgeCardCandidate(candidateSource({ id: 'c-advantage' })),
            status: 'adopted',
          }],
        };
      }
      throw new Error('unexpected call');
    });
    render(<KnowledgeBatchCard data={cardData([candidateSource({ id: 'c-advantage' })])} />);

    expect(await screen.findByText('已采用')).toBeInTheDocument();
    expect(screen.getByText(/全部候选已裁决/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /确认（采纳全部/ })).not.toBeInTheDocument();
    expect(mocks.apiPost).toHaveBeenCalledTimes(1);
  });

  it('materials/status 重建的卡片按 payload 权威状态直接渲染已裁决行', () => {
    // 导入区卡片来自服务端权威候选重建：payload 状态即真实状态，无需等水合。
    render(<KnowledgeBatchCard data={cardData([
      candidateSource({ id: 'c-advantage', status: 'adopted' }),
    ])} />);

    expect(screen.getByText('已采用')).toBeInTheDocument();
    expect(screen.getByText(/全部候选已裁决/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /确认（采纳全部/ })).not.toBeInTheDocument();
  });

  it('ToolUse 从生产投影的 MCP 包装结果渲染字段行复核卡（端到端回归）', () => {
    const tool: ToolUseSimple = {
      id: 'call_00_regression',
      name: 'mcp__xiaojing-geo__import_pasted_material',
      inputJson: '{}',
      isLoading: false,
      result: JSON.stringify([
        { type: 'text', text: JSON.stringify(cardData([candidateSource()])) },
      ]),
    };
    render(<ToolUse tool={tool} />);
    expect(screen.getByText('品牌知识待确认')).toBeInTheDocument();
    // 默认展开：字段行与值直接可见。
    expect(screen.getByText('核心优势')).toBeInTheDocument();
    expect(screen.getByText('技术领先')).toBeInTheDocument();
  });
});

describe('KnowledgeBatchCard（行内「更改」暂存与轮询存活）', () => {
  beforeEach(() => {
    mocks.apiPost.mockReset();
    mocks.apiPost.mockImplementation(async (path: string, body?: {
      candidateIds?: string[];
      decisions?: Array<{ candidateId: string; decision: string }>;
    }) => {
      if (path === '/api/xiaojing/knowledge/candidates') {
        return { success: true, candidates: (body?.candidateIds ?? []).map(() => null) };
      }
      return {
        success: true,
        results: (body?.decisions ?? []).map((decision) => ({
          candidateId: decision.candidateId,
          ok: true,
          status: decision.decision === 'keep-current' ? 'kept-current' : 'adopted',
        })),
      };
    });
  });

  it('材料原文、AI 补全、冲突行都有「更改」入口；已裁决行没有', () => {
    render(<KnowledgeBatchCard data={cardData([
      candidateSource({ id: 'c-fullname', predicate: 'enterprise-profile.fullName', valueJson: '"鲸跃科技"', normalizedValueJson: '"鲸跃科技"' }),
      candidateSource({
        id: 'c-advantage',
        source: { materialId: 'material-1', excerpt: '推断优势', confidence: 0.4, profileProvenance: 'inferred' },
      }),
      candidateSource({
        id: 'c-industry-conflict',
        predicate: 'enterprise-profile.industry',
        valueJson: '"汽车后市场装具"',
        normalizedValueJson: '"汽车后市场装具"',
        status: 'conflict',
        baseVersion: 2,
        current: {
          normalizedValueJson: '"汽车零售"',
          unit: null,
          version: 2,
          confirmedBy: 'user-1',
          confirmedAt: '2026-08-15T00:00:00Z',
        },
      }),
    ])} />);

    expect(screen.getByRole('button', { name: '更改：品牌全称' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '更改：核心优势' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '更改：行业' })).toBeInTheDocument();
  });

  it('已裁决行不提供「更改」入口', () => {
    render(<KnowledgeBatchCard data={cardData([
      candidateSource({ id: 'c-advantage', status: 'adopted' }),
    ])} />);

    expect(screen.queryByRole('button', { name: '更改：核心优势' })).not.toBeInTheDocument();
  });

  it('更改数组行：顿号分隔多值输入，保存后行变「用户补充 · 已就绪」且确认控件消失，暂存不落库', () => {
    render(<KnowledgeBatchCard data={cardData([
      candidateSource({
        id: 'c-advantage',
        valueJson: '["技术领先","响应快"]',
        normalizedValueJson: '["技术领先","响应快"]',
        source: { materialId: 'material-1', excerpt: '推断优势', confidence: 0.4, profileProvenance: 'inferred' },
      }),
    ])} />);

    fireEvent.click(screen.getByRole('button', { name: '更改：核心优势' }));
    const input = screen.getByRole('textbox', { name: '核心优势' });
    // 数组值预填为顿号连接文本，并提示多值输入格式。
    expect(input).toHaveValue('技术领先、响应快');
    expect(screen.getByText('多个值用顿号（、）分隔')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: '技术领先、响应快、本地服务' } });
    fireEvent.click(screen.getByRole('button', { name: '保存：核心优势' }));

    const row = screen.getByText('核心优势').closest('article');
    expect(row).toHaveAttribute('data-row-tier', 'user-edited');
    expect(screen.getByText('用户补充 · 已就绪')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '确认核心优势' })).not.toBeInTheDocument();
    // 行摘要立即显示编辑后的值。
    expect(screen.getByText('技术领先、响应快、本地服务')).toBeInTheDocument();
    // 更改只暂存：保存后没有任何 decide-batch 请求。
    expect(mocks.apiPost.mock.calls.every(([path]) => path !== '/api/xiaojing/knowledge/decide-batch')).toBe(true);
  });

  it('整卡确认时编辑行按 adopt-edited 提交编辑值，未编辑行照常 adopt-new', async () => {
    render(<KnowledgeBatchCard data={cardData([
      candidateSource({ id: 'c-fullname', predicate: 'enterprise-profile.fullName', valueJson: '"鲸跃科技"', normalizedValueJson: '"鲸跃科技"' }),
      candidateSource({
        id: 'c-industry',
        predicate: 'enterprise-profile.industry',
        valueJson: '"汽车后市场"',
        normalizedValueJson: '"汽车后市场"',
        source: { materialId: 'material-1', excerpt: '推断行业', confidence: 0.4, profileProvenance: 'inferred' },
      }),
    ])} />);

    fireEvent.click(screen.getByRole('button', { name: '更改：行业' }));
    fireEvent.change(screen.getByRole('textbox', { name: '行业' }), { target: { value: '汽车后市场装具' } });
    fireEvent.click(screen.getByRole('button', { name: '保存：行业' }));
    fireEvent.click(screen.getByRole('button', { name: '确认（采纳全部 2 条）' }));

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith(
      '/api/xiaojing/knowledge/decide-batch',
      expect.objectContaining({
        decisions: [
          expect.objectContaining({ candidateId: 'c-fullname', decision: 'adopt-new' }),
          // 标量字段保持字符串提交，不切成数组。
          expect.objectContaining({ candidateId: 'c-industry', decision: 'adopt-edited', editedValue: '汽车后市场装具' }),
        ],
      }),
    ));
  });

  it('冲突行更改保存后无需二选一即可确认，提交 adopt-edited', async () => {
    render(<KnowledgeBatchCard data={cardData([
      candidateSource({
        id: 'c-conflict',
        status: 'conflict',
        baseVersion: 2,
        current: {
          normalizedValueJson: '["口碑服务"]',
          unit: null,
          version: 2,
          confirmedBy: 'user-1',
          confirmedAt: '2026-08-15T00:00:00Z',
        },
      }),
    ])} />);

    const confirmAll = screen.getByRole('button', { name: '确认（采纳全部 1 条）' });
    expect(confirmAll).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '更改：核心优势' }));
    fireEvent.change(screen.getByRole('textbox', { name: '核心优势' }), { target: { value: '技术领先、口碑服务' } });
    fireEvent.click(screen.getByRole('button', { name: '保存：核心优势' }));

    // 编辑替代二选一：选择控件与未解决提示消失，整卡确认解锁。
    expect(screen.queryByRole('button', { name: '采用新值：核心优势' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '保留当前值：核心优势' })).not.toBeInTheDocument();
    expect(screen.queryByText('还有 1 条冲突待选择')).not.toBeInTheDocument();
    expect(screen.getByText('用户补充 · 已就绪')).toBeInTheDocument();
    await waitFor(() => expect(confirmAll).toBeEnabled());

    fireEvent.click(confirmAll);
    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith(
      '/api/xiaojing/knowledge/decide-batch',
      expect.objectContaining({
        decisions: [expect.objectContaining({
          candidateId: 'c-conflict',
          decision: 'adopt-edited',
          editedValue: ['技术领先', '口碑服务'],
          expectedCurrentVersion: 2,
        })],
      }),
    ));
  });

  it('暂存编辑按候选 id 键控，3 秒轮询重建后徽章、编辑值与冲突选择原样保留', () => {
    const sources = [
      candidateSource({
        id: 'c-industry',
        predicate: 'enterprise-profile.industry',
        valueJson: '"汽车后市场"',
        normalizedValueJson: '"汽车后市场"',
        source: { materialId: 'material-1', excerpt: '推断行业', confidence: 0.4, profileProvenance: 'inferred' },
      }),
      candidateSource({
        id: 'c-conflict',
        status: 'conflict',
        baseVersion: 3,
        current: {
          normalizedValueJson: '["口碑服务"]',
          unit: null,
          version: 3,
          confirmedBy: 'user-1',
          confirmedAt: '2026-08-15T00:00:00Z',
        },
      }),
    ];
    const view = render(<KnowledgeBatchCard data={cardData(sources)} />);

    fireEvent.click(screen.getByRole('button', { name: '更改：行业' }));
    fireEvent.change(screen.getByRole('textbox', { name: '行业' }), { target: { value: '汽车后市场装具' } });
    fireEvent.click(screen.getByRole('button', { name: '保存：行业' }));
    fireEvent.click(screen.getByRole('button', { name: '采用新值：核心优势' }));

    // 模拟 3s 轮询：服务端返回全新构建的 data 投影对象（同包装、同挂载点，不重挂载卡片）。
    view.rerender(
      <XiaojingThemeRuntime>
        <KnowledgeBatchCard data={cardData(sources)} />
      </XiaojingThemeRuntime>,
    );

    expect(screen.getByText('行业').closest('article')).toHaveAttribute('data-row-tier', 'user-edited');
    expect(screen.getByText('用户补充 · 已就绪')).toBeInTheDocument();
    expect(screen.getByText('汽车后市场装具')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '采用新值：核心优势' })).toHaveAttribute('aria-pressed', 'true');

    // 重新打开编辑器：预填暂存值而非原始候选值。
    fireEvent.click(screen.getByRole('button', { name: '更改：行业' }));
    expect(screen.getByRole('textbox', { name: '行业' })).toHaveValue('汽车后市场装具');
  });

  it('同字段多候选行的更改逐候选编辑：未改动的输入不暂存、不误标用户补充', async () => {
    const { container } = render(<KnowledgeBatchCard data={cardData([
      candidateSource({
        id: 'c-products',
        predicate: 'enterprise-profile.products',
        valueJson: '["电动车"]',
        normalizedValueJson: '["电动车"]',
      }),
      candidateSource({
        id: 'c-products-line',
        predicate: 'enterprise-profile.products',
        key: {
          subject: '鲸跃科技/电动车',
          predicate: 'enterprise-profile.products',
          scopeJson: '{"entityScope":"product-line","productLine":"电动车"}',
          effectiveFrom: null,
          effectiveTo: null,
        },
        valueJson: '["充电桩"]',
        normalizedValueJson: '["充电桩"]',
      }),
    ])} />);

    fireEvent.click(screen.getByRole('button', { name: '更改：核心产品' }));
    const brandInput = container.querySelector('[data-candidate-edit="c-products"] input') as HTMLInputElement | null;
    const lineInput = container.querySelector('[data-candidate-edit="c-products-line"] input') as HTMLInputElement | null;
    expect(brandInput).toHaveValue('电动车');
    expect(lineInput).toHaveValue('充电桩');
    // 多候选时用 subject 区分 scope。
    expect(screen.getByText('鲸跃科技/电动车')).toBeInTheDocument();

    // 只改品牌 scope 的值；product-line 输入保持原值。
    fireEvent.change(brandInput!, { target: { value: '电动车、换电站' } });
    fireEvent.click(screen.getByRole('button', { name: '保存：核心产品' }));

    // 部分编辑的合并行：已编辑候选逐条呈现「用户补充」徽章，未编辑候选维持原状。
    expect(screen.getAllByText('用户补充 · 已就绪')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '确认（采纳全部 2 条）' }));

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith(
      '/api/xiaojing/knowledge/decide-batch',
      expect.objectContaining({
        decisions: [
          expect.objectContaining({ candidateId: 'c-products', decision: 'adopt-edited', editedValue: ['电动车', '换电站'] }),
          // 未改动的输入不被暂存，仍走整卡默认的 adopt-new，不误标用户补充来源。
          expect.objectContaining({ candidateId: 'c-products-line', decision: 'adopt-new' }),
        ],
      }),
    ));
    const lineDecision = mocks.apiPost.mock.calls.at(-1)?.[1]?.decisions?.find(
      (decision: { candidateId: string }) => decision.candidateId === 'c-products-line',
    );
    expect(lineDecision.editedValue).toBeUndefined();
  });
});

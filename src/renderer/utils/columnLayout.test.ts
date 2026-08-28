import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetColumnWidthsForTest,
  clampSidebarWidth,
  clampWorkbenchWidth,
  COLUMN_WIDTHS_STORAGE_KEY,
  effectiveSidebarMax,
  effectiveWorkbenchMax,
  getColumnWidths,
  resetColumnWidths,
  saveColumnWidths,
  subscribeColumnWidths,
} from './columnLayout';

function makeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: () => null,
    length: map.size,
  };
}

describe('columnLayout store', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', makeStorage());
    __resetColumnWidthsForTest();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts from the 248/320 defaults and clamps persisted values on load', () => {
    expect(getColumnWidths()).toEqual({ sidebar: 248, workbench: 360 });

    localStorage.setItem(
      COLUMN_WIDTHS_STORAGE_KEY,
      '{"sidebar":9999,"workbench":10}',
    );
    __resetColumnWidthsForTest();
    expect(getColumnWidths()).toEqual({ sidebar: 400, workbench: 280 });

    localStorage.setItem(COLUMN_WIDTHS_STORAGE_KEY, 'not json');
    __resetColumnWidthsForTest();
    expect(getColumnWidths()).toEqual({ sidebar: 248, workbench: 360 });
  });

  it('clamps non-finite input to defaults', () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(248);
    // 非有限值（NaN/Infinity）一律回退默认，不参与区间计算。
    expect(clampWorkbenchWidth(Number.POSITIVE_INFINITY)).toBe(360);
    expect(clampWorkbenchWidth(299.6)).toBe(300);
  });

  it('persists partial patches and notifies subscribers until they unsubscribe', () => {
    const seen: Array<{ sidebar: number; workbench: number }> = [];
    const unsubscribe = subscribeColumnWidths((widths) => seen.push({ ...widths }));

    saveColumnWidths({ sidebar: 300 });
    expect(getColumnWidths()).toEqual({ sidebar: 300, workbench: 360 });
    expect(JSON.parse(localStorage.getItem(COLUMN_WIDTHS_STORAGE_KEY) ?? '{}')).toEqual(
      { sidebar: 300, workbench: 360 },
    );
    expect(seen).toEqual([{ sidebar: 300, workbench: 360 }]);

    unsubscribe();
    saveColumnWidths({ workbench: 500 });
    expect(seen).toHaveLength(1);
  });

  it('double-click reset restores only the requested column default', () => {
    saveColumnWidths({ sidebar: 380, workbench: 520 });
    resetColumnWidths({ sidebar: 248 });
    expect(getColumnWidths()).toEqual({ sidebar: 248, workbench: 520 });
    resetColumnWidths({ workbench: 360 });
    expect(getColumnWidths()).toEqual({ sidebar: 248, workbench: 360 });
  });

  it('keeps the chat floor before letting the two columns hit their mins', () => {
    // 宽视口：聊天保底后仍有富余，两栏回到各自硬上限。
    expect(effectiveSidebarMax(320, 1600)).toBe(400);
    expect(effectiveWorkbenchMax(248, 1600)).toBe(720);
    // 中等视口：聊天恰好保底，上限被压到 200。
    expect(effectiveSidebarMax(320, 1000)).toBe(200);
    // 视口不足以同时容纳两栏与聊天保底：聊天让位，两栏各自下限优先。
    expect(effectiveSidebarMax(560, 950)).toBe(200);
    expect(effectiveWorkbenchMax(400, 950)).toBe(280);
    // <900px 工作台浮层不占文档流：侧栏上限不再扣工作台宽度。
    expect(effectiveSidebarMax(560, 899)).toBe(400);
  });
});

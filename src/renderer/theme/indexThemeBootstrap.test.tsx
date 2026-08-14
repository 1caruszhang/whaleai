import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const html = readFileSync(resolve(import.meta.dirname, '../index.html'), 'utf8');
const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';

function runBootstrap(): void {
  Function(inlineScript)();
}

describe('pre-React Theme bootstrap', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    delete document.documentElement.dataset.themeId;
    delete document.documentElement.dataset.colorScheme;
    document.documentElement.style.colorScheme = '';
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('establishes the fixed Xiaojing dark root state even when the legacy snapshot is malformed', () => {
    localStorage.setItem('myagents:theme-bootstrap', '{');
    runBootstrap();

    expect(document.documentElement.dataset.themeId).toBe('xiaojing');
    expect(document.documentElement.dataset.colorScheme).toBe('dark');
    expect(document.documentElement).toHaveClass('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  it('establishes the same fixed root state without depending on storage access', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    runBootstrap();

    expect(document.documentElement.dataset.themeId).toBe('xiaojing');
    expect(document.documentElement.dataset.colorScheme).toBe('dark');
    expect(document.documentElement).toHaveClass('dark');
  });

  it('ignores a legacy future Theme ID for the fixed Xiaojing product shell', () => {
    localStorage.setItem('myagents:theme-bootstrap', JSON.stringify({
      version: 1,
      themeId: 'future-partner-theme',
      appearanceMode: 'light',
    }));
    runBootstrap();

    expect(document.documentElement.dataset.themeId).toBe('xiaojing');
    expect(document.documentElement.dataset.colorScheme).toBe('dark');
    expect(document.documentElement).toHaveClass('dark');
  });

  it('ignores a legacy non-explicit default selection', () => {
    localStorage.setItem('myagents:theme-bootstrap', JSON.stringify({
      version: 2,
      themeId: 'myagents-default',
      appearanceMode: 'light',
      themeSelectionExplicit: false,
    }));
    runBootstrap();

    expect(document.documentElement.dataset.themeId).toBe('xiaojing');
    expect(document.documentElement.dataset.colorScheme).toBe('dark');
    expect(document.documentElement).toHaveClass('dark');
  });
});

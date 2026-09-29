import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ThemeToggle } from '@/components/theme-toggle';
import { ThemeProvider, useTheme } from '@/lib/theme';

/**
 * 深浅色主题（票 46）：默认跟随系统（prefers-color-scheme），可手动切换
 * 浅色/深色并持久化 localStorage；生效形态是 <html class="dark">。
 */
interface TestWindow extends Window {
  __setPrefersDark(value: boolean): void;
}

const testWindow = window as unknown as TestWindow;
const THEME_KEY = 'xiaojing-admin-theme';

function ResolvedProbe() {
  const { resolvedTheme } = useTheme();
  return <span data-testid="resolved">{resolvedTheme}</span>;
}

function renderTheme() {
  render(
    <ThemeProvider>
      <ThemeToggle />
      <ResolvedProbe />
    </ThemeProvider>,
  );
}

async function pickTheme(label: string): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '切换主题' }));
  await user.click(await screen.findByRole('menuitem', { name: label }));
}

describe('深浅色主题（票 46）', () => {
  it('默认跟随系统：系统深色 → <html class=dark>；系统浅色 → 不挂 dark', () => {
    testWindow.__setPrefersDark(true);
    const { unmount } = render(
      <ThemeProvider>
        <ResolvedProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
    expect(document.documentElement).toHaveClass('dark');
    expect(window.localStorage.getItem(THEME_KEY)).toBeNull(); // 跟随系统不落盘
    unmount();

    testWindow.__setPrefersDark(false);
    render(
      <ThemeProvider>
        <ResolvedProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('resolved')).toHaveTextContent('light');
    expect(document.documentElement).not.toHaveClass('dark');
  });

  it('手动切换深色/浅色生效并持久化 localStorage', async () => {
    testWindow.__setPrefersDark(false);
    renderTheme();

    await pickTheme('深色');
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
    expect(document.documentElement).toHaveClass('dark');
    expect(window.localStorage.getItem(THEME_KEY)).toBe('dark');

    await pickTheme('浅色');
    expect(screen.getByTestId('resolved')).toHaveTextContent('light');
    expect(document.documentElement).not.toHaveClass('dark');
    expect(window.localStorage.getItem(THEME_KEY)).toBe('light');
  });

  it('可切回跟随系统（重新按系统偏好解析）', async () => {
    testWindow.__setPrefersDark(true);
    window.localStorage.setItem(THEME_KEY, 'light');
    renderTheme();
    expect(document.documentElement).not.toHaveClass('dark');

    await pickTheme('跟随系统');
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
    expect(document.documentElement).toHaveClass('dark');
    expect(window.localStorage.getItem(THEME_KEY)).toBe('system');
  });

  it('已持久化的选择在挂载时恢复（dark 落盘 → 直接深色）', () => {
    window.localStorage.setItem(THEME_KEY, 'dark');
    testWindow.__setPrefersDark(false); // 手动选择优先于系统
    render(
      <ThemeProvider>
        <ResolvedProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
    expect(document.documentElement).toHaveClass('dark');
  });
});

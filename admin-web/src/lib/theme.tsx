import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * 深浅色主题（票 46）：默认跟随系统（prefers-color-scheme），可手动切换
 * 浅色/深色并持久化 localStorage；选择挂在 <html class="dark">（Tailwind v4
 * @custom-variant）。index.html 内有首屏防闪脚本，此 Provider 负责 hydration
 * 后的一致性（含系统偏好变化监听）。票 #60 T-A 起：除首次挂载外的每次
 * 生效主题切换给 <html> 补一个短暂的 theme-transition 类，让颜色平滑过渡
 * 而不是瞬时翻转（样式在 index.css）。
 */
export type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'xiaojing-admin-theme';

/** 主题切换过渡类的存活时长（与 index.css 的过渡时长一致）。 */
const THEME_TRANSITION_MS = 400;

interface ThemeContextValue {
  /** 用户选择（可能为 system）。 */
  theme: Theme;
  /** 实际生效主题（system 已解析）。 */
  resolvedTheme: 'light' | 'dark';
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);
  const [systemDark, setSystemDark] = useState<boolean>(systemPrefersDark);
  // 首次落类不挂过渡类：index.html 防闪脚本已保证首屏一致，避免入场动画。
  const isFirstResolve = useRef(true);

  // 跟随系统时，监听系统偏好变化（其它模式无需监听，避免多余订阅）。
  useEffect(() => {
    if (theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent): void => setSystemDark(event.matches);
    media.addEventListener('change', onChange);
    setSystemDark(media.matches);
    return () => media.removeEventListener('change', onChange);
  }, [theme]);

  const resolvedTheme = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;

  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolvedTheme === 'dark');
    if (isFirstResolve.current) {
      isFirstResolve.current = false;
      return;
    }
    document.documentElement.classList.add('theme-transition');
    const timer = window.setTimeout(() => {
      document.documentElement.classList.remove('theme-transition');
    }, THEME_TRANSITION_MS);
    return () => {
      window.clearTimeout(timer);
      document.documentElement.classList.remove('theme-transition');
    };
  }, [resolvedTheme]);

  const setTheme = useCallback((next: Theme) => {
    localStorage.setItem(STORAGE_KEY, next);
    setThemeState(next);
  }, []);

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
  );

  return <ThemeContext value={value}>{children}</ThemeContext>;
}

export function useTheme(): ThemeContextValue {
  const context = use(ThemeContext);
  if (!context) throw new Error('useTheme 必须在 <ThemeProvider> 内使用。');
  return context;
}

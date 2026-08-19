import { createContext, useContext, useMemo, type ReactNode } from 'react';

import './themes/xiaojing.css';

export type SyntaxStyle = Record<string, Record<string, string | undefined>>;

export interface ResolvedTheme {
  themeId: 'xiaojing';
  key: 'xiaojing-dark';
  hero: {
    productName: string;
    slogans: Record<'zh-CN' | 'en-US', string>;
  };
  adapters: {
    prism: SyntaxStyle;
    monaco: {
      name: string;
      fontFamily: string;
      fontSize: number;
      lineHeight: number;
      data: {
        base: 'vs-dark';
        inherit: boolean;
        rules: Array<{ token: string; foreground?: string; fontStyle?: string }>;
        colors: Record<string, string>;
      };
    };
    mermaid: {
      theme: 'dark';
      fontFamily: string;
      themeVariables: Record<string, string>;
    };
  };
}

export type MermaidThemeAdapter = ResolvedTheme['adapters']['mermaid'];

const XIAOJING_THEME: ResolvedTheme = {
  themeId: 'xiaojing',
  key: 'xiaojing-dark',
  hero: {
    productName: '鲸杉geo',
    slogans: {
      'zh-CN': '让品牌成为 AI 的答案',
      'en-US': 'Make your brand the AI answer',
    },
  },
  adapters: {
    prism: {
      'code[class*="language-"]': { color: '#d8e8f5', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
      'pre[class*="language-"]': { color: '#d8e8f5', background: '#071522' },
      comment: { color: '#7391a8' },
      keyword: { color: '#7dd3fc' },
      string: { color: '#86efac' },
      number: { color: '#fda4af' },
      function: { color: '#c4b5fd' },
    },
    monaco: {
      name: 'xiaojing-dark',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      lineHeight: 20,
      data: {
        base: 'vs-dark',
        inherit: true,
        rules: [],
        colors: {
          'editor.background': '#071522',
          'editor.foreground': '#d8e8f5',
          'editorLineNumber.foreground': '#567188',
        },
      },
    },
    mermaid: {
      theme: 'dark',
      fontFamily: 'Inter, system-ui, sans-serif',
      themeVariables: {
        primaryColor: '#0f3650',
        primaryTextColor: '#e8f4fb',
        primaryBorderColor: '#2aa8d8',
        lineColor: '#74c5e6',
        secondaryColor: '#10283a',
        tertiaryColor: '#081b29',
        background: '#071522',
        mainBkg: '#0f3650',
        textColor: '#e8f4fb',
      },
    },
  },
};

const ThemeContext = createContext<ResolvedTheme>(XIAOJING_THEME);

export function primeXiaojingThemeRuntime(): void {
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = 'xiaojing';
}

export function XiaojingThemeRuntime({ children }: { children: ReactNode; ownsMainWindowBridge?: boolean }) {
  const value = useMemo(() => XIAOJING_THEME, []);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useResolvedTheme(): ResolvedTheme {
  return useContext(ThemeContext);
}

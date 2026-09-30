import { ChevronRightIcon, PanelLeftIcon, SearchIcon } from 'lucide-react';
import { Link, useLocation } from 'react-router';
import { ThemeToggle } from '@/components/theme-toggle';
import { UserNav } from '@/components/user-nav';
import { Button } from '@/components/ui/button';

/**
 * 页头（票 #60 T-A，样式对齐 shadcn-admin 布局页头）：左侧折叠按钮 +
 * 面包屑（当前页标题），右侧搜索框（点击唤起既有 Cmd+K 面板，不引 cmdk）
 * + 主题开关（日/月双图标 scale/rotate 交叉淡入）+ 用户菜单。功能与信息
 * 架构不变——只是把原侧栏底部的主题开关与用户菜单挪进页头右端。
 */

/** 面包屑层级：路径前缀 → 层级标签（与路由表 routes.tsx 的路径一致）。 */
const BREADCRUMB_LEVELS: { path: string; label: string }[] = [
  { path: '/accounts/:accountId', label: '账号详情' },
  { path: '/accounts', label: '账号' },
  { path: '/', label: '仪表盘' },
];

const CRUMB_LINK_CLASS =
  'text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded-sm transition-colors outline-none focus-visible:ring-2';

/** 当前路径 → 面包屑（根层级是「运营台」链接，末尾是当前页，中间层可点击）。 */
function Breadcrumbs() {
  const { pathname } = useLocation();

  const crumbs: { label: string; to?: string }[] = [];
  if (/^\/accounts\/[^/]+$/.test(pathname)) {
    crumbs.push({ label: '账号', to: '/accounts' }, { label: '账号详情' });
  } else {
    const level = BREADCRUMB_LEVELS.find(entry => pathname === entry.path);
    if (level) crumbs.push({ label: level.label });
  }

  return (
    <nav aria-label="面包屑" className="flex min-w-0 items-center gap-1 text-sm">
      <Link to="/" className={CRUMB_LINK_CLASS}>
        运营台
      </Link>
      {crumbs.map(crumb => (
        <span key={crumb.label} className="flex min-w-0 items-center gap-1">
          <ChevronRightIcon aria-hidden="true" className="text-muted-foreground size-3.5 shrink-0" />
          {crumb.to !== undefined ? (
            <Link to={crumb.to} className={CRUMB_LINK_CLASS}>
              {crumb.label}
            </Link>
          ) : (
            <span aria-current="page" className="truncate font-medium">
              {crumb.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}

/** 页头搜索框：样式对齐 shadcn-admin 搜索按钮，点击唤起 Cmd+K 面板。 */
function SearchButton({ onSearchClick }: { onSearchClick: () => void }) {
  return (
    <Button
      variant="outline"
      onClick={onSearchClick}
      aria-label="打开全局搜索"
      aria-keyshortcuts="Meta+K Control+K"
      className="bg-muted/25 hover:bg-accent relative size-9 justify-start gap-2 p-0 text-sm font-normal shadow-none sm:w-40 sm:px-3 sm:pe-12 lg:w-52 xl:w-64"
    >
      <SearchIcon aria-hidden="true" className="size-4 shrink-0" />
      <span className="text-muted-foreground hidden font-normal sm:inline">搜索账号…</span>
      <kbd className="bg-muted pointer-events-none absolute inset-e-[0.3rem] top-[0.3rem] hidden h-5 items-center gap-1 rounded border px-1.5 font-mono text-[10px] font-medium select-none sm:flex">
        <span className="text-xs">⌘</span>K
      </kbd>
    </Button>
  );
}

export function Header({
  collapsed,
  onToggleSidebar,
  onSearchClick,
}: {
  collapsed: boolean;
  onToggleSidebar: () => void;
  onSearchClick: () => void;
}) {
  return (
    <header className="bg-background/95 supports-[backdrop-filter]:bg-background/60 border-b backdrop-blur sticky top-0 z-40 flex h-14 shrink-0 items-center gap-2 px-4 lg:px-6">
      <Button
        variant="ghost"
        size="icon"
        onClick={onToggleSidebar}
        aria-label={collapsed ? '展开侧栏' : '折叠侧栏'}
        aria-expanded={!collapsed}
        aria-controls="app-sidebar"
        title={collapsed ? '展开侧栏' : '折叠侧栏'}
      >
        <PanelLeftIcon className="size-4" />
      </Button>
      <div aria-hidden="true" className="bg-border h-6 w-px shrink-0" />
      <Breadcrumbs />
      <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
        <SearchButton onSearchClick={onSearchClick} />
        <ThemeToggle />
        <UserNav />
      </div>
    </header>
  );
}

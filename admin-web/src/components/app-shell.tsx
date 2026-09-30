import { LayoutDashboardIcon, ListChecksIcon, UsersIcon, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { BrandLogo } from '@/components/brand-logo';
import { CommandSearch } from '@/components/command-search';
import { Header } from '@/components/header';
import { RouteProgress } from '@/components/route-progress';
import { cn } from '@/lib/utils';

/** SPA 内路由条目（react-router NavLink）与后端 SSR 页条目（普通 <a>）的并集。 */
type NavItem =
  | { to: string; label: string; icon: LucideIcon; end: boolean }
  | { href: string; label: string; icon: LucideIcon };

const NAV_ITEMS: NavItem[] = [
  { to: '/', label: '仪表盘', icon: LayoutDashboardIcon, end: true },
  { to: '/accounts', label: '账号', icon: UsersIcon, end: false },
  // 票 #58：偏好名单页是保留的后端 SSR 页（非 SPA 路由）——href 带 /admin
  // basename 前缀的整页跳转（SSR 页复用 SPA 登录写下的同一会话 cookie）。
  { href: '/admin/preference-channels', label: '偏好名单', icon: ListChecksIcon },
];

const NAV_ITEM_CLASS =
  'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors';

/** 侧栏折叠态持久化键（与主题同口径的 localStorage 持久化）。 */
const SIDEBAR_COLLAPSED_KEY = 'xiaojing-admin-sidebar-collapsed';

function readSidebarCollapsed(): boolean {
  return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
}

/**
 * 单个导航项：折叠态只渲染图标（icon-only），文字进 sr-only 保留可访问
 * 名称、title 提供悬停/聚焦 tooltip——不引 Radix Tooltip 依赖。
 */
function NavItemLink({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const icon = <item.icon className="size-4 shrink-0" />;
  const label = <span className={collapsed ? 'sr-only' : undefined}>{item.label}</span>;
  const title = collapsed ? item.label : undefined;

  if ('href' in item) {
    return (
      <a
        href={item.href}
        title={title}
        className={cn(NAV_ITEM_CLASS, collapsed && 'justify-center px-0')}
      >
        {icon}
        {label}
      </a>
    );
  }
  return (
    <NavLink
      to={item.to}
      end={item.end}
      title={title}
      className={({ isActive }) =>
        cn(
          NAV_ITEM_CLASS,
          collapsed && 'justify-center px-0',
          isActive && 'bg-sidebar-accent text-sidebar-accent-foreground font-semibold',
        )
      }
    >
      {icon}
      {label}
    </NavLink>
  );
}

/**
 * 受保护壳（票 46）：左侧边栏（品牌 + 仪表盘/账号/偏好名单导航），右侧
 * 页头 + 内容区承接子路由。票 51 起挂载 Cmd+K 全局搜索面板（快捷键在受
 * 保护区内生效，登录页不响应）。票 #58 起「偏好名单」是整页跳转到保留的
 * 后端 SSR 页的普通链接（非 SPA 路由）。
 *
 * 票 #60 T-A：侧栏可折叠（icon-only + tooltip + transition-[width] 过渡，
 * 折叠态持久化 localStorage）；页头（面包屑 + 搜索框唤起 Cmd+K + 主题开关
 * + 用户菜单）与路由顶部进度条（location.key 驱动）上壳。
 */
export function AppShell() {
  const [collapsed, setCollapsed] = useState<boolean>(readSidebarCollapsed);
  const [searchOpen, setSearchOpen] = useState(false);
  const location = useLocation();

  const toggleSidebar = (): void => {
    setCollapsed(previous => {
      const next = !previous;
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0');
      return next;
    });
  };

  return (
    <div className="flex h-svh w-full overflow-hidden">
      <RouteProgress locationKey={location.key} />
      <aside
        id="app-sidebar"
        className={cn(
          'bg-sidebar text-sidebar-foreground border-sidebar-border flex shrink-0 flex-col gap-2 border-r p-3 transition-[width] duration-200 ease-linear',
          collapsed ? 'w-14' : 'w-60',
        )}
      >
        <div className={cn('flex h-12 items-center', collapsed ? 'justify-center' : 'px-2')}>
          <BrandLogo collapsed={collapsed} />
        </div>
        <nav className="flex flex-1 flex-col gap-1" aria-label="主导航">
          {NAV_ITEMS.map(item => (
            <NavItemLink
              key={'href' in item ? item.href : item.to}
              item={item}
              collapsed={collapsed}
            />
          ))}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <Header
          collapsed={collapsed}
          onToggleSidebar={toggleSidebar}
          onSearchClick={() => setSearchOpen(true)}
        />
        <main className="min-w-0 flex-1 p-6 lg:p-8">
          <Outlet />
        </main>
      </div>
      <CommandSearch open={searchOpen} onOpenChange={setSearchOpen} />
    </div>
  );
}

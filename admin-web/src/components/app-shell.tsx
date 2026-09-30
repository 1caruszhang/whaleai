import { LayoutDashboardIcon, ListChecksIcon, UsersIcon, type LucideIcon } from 'lucide-react';
import { NavLink, Outlet } from 'react-router';
import { BrandLogo } from '@/components/brand-logo';
import { CommandSearch } from '@/components/command-search';
import { ThemeToggle } from '@/components/theme-toggle';
import { UserNav } from '@/components/user-nav';
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

/**
 * 受保护壳（票 46）：左侧边栏（品牌 + 仪表盘/账号/偏好名单导航 + 主题切换
 * + 退出登录），右侧内容区承接子路由。票 51 起挂载 Cmd+K 全局搜索面板
 * （快捷键在受保护区内生效，登录页不响应）。票 #58 起「偏好名单」是整页
 * 跳转到保留的后端 SSR 页的普通链接（非 SPA 路由）。
 */
export function AppShell() {
  return (
    <div className="flex min-h-svh w-full">
      <aside className="bg-sidebar text-sidebar-foreground border-sidebar-border flex w-60 shrink-0 flex-col gap-2 border-r p-3">
        <div className="flex h-12 items-center px-2">
          <BrandLogo />
        </div>
        <nav className="flex flex-1 flex-col gap-1" aria-label="主导航">
          {NAV_ITEMS.map(item =>
            'href' in item ? (
              <a key={item.href} href={item.href} className={NAV_ITEM_CLASS}>
                <item.icon className="size-4" />
                <span>{item.label}</span>
              </a>
            ) : (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    NAV_ITEM_CLASS,
                    isActive &&
                      'bg-sidebar-accent text-sidebar-accent-foreground font-semibold',
                  )
                }
              >
                <item.icon className="size-4" />
                <span>{item.label}</span>
              </NavLink>
            ),
          )}
        </nav>
        <div className="border-sidebar-border flex items-center gap-1 border-t pt-2">
          <ThemeToggle />
          <UserNav />
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto p-6 lg:p-8">
        <Outlet />
      </main>
      <CommandSearch />
    </div>
  );
}

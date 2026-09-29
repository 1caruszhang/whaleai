import { LayoutDashboardIcon, UsersIcon } from 'lucide-react';
import { NavLink, Outlet } from 'react-router';
import { BrandLogo } from '@/components/brand-logo';
import { ThemeToggle } from '@/components/theme-toggle';
import { UserNav } from '@/components/user-nav';
import { cn } from '@/lib/utils';

const NAV_ITEMS = [
  { to: '/', label: '仪表盘', icon: LayoutDashboardIcon, end: true },
  { to: '/accounts', label: '账号', icon: UsersIcon, end: false },
];

/**
 * 受保护壳（票 46）：左侧边栏（品牌 + 仪表盘/账号导航 + 主题切换 + 退出
 * 登录），右侧内容区承接子路由。
 */
export function AppShell() {
  return (
    <div className="flex min-h-svh w-full">
      <aside className="bg-sidebar text-sidebar-foreground border-sidebar-border flex w-60 shrink-0 flex-col gap-2 border-r p-3">
        <div className="flex h-12 items-center px-2">
          <BrandLogo />
        </div>
        <nav className="flex flex-1 flex-col gap-1" aria-label="主导航">
          {NAV_ITEMS.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  isActive &&
                    'bg-sidebar-accent text-sidebar-accent-foreground font-semibold',
                )
              }
            >
              <item.icon className="size-4" />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="border-sidebar-border flex items-center gap-1 border-t pt-2">
          <ThemeToggle />
          <UserNav />
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto p-6 lg:p-8">
        <Outlet />
      </main>
    </div>
  );
}

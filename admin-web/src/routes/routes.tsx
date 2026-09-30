import { Navigate, useRoutes, type RouteObject } from 'react-router';
import { AppShell } from '@/components/app-shell';
import { AccountDetailPage } from '@/routes/account-detail-page';
import { AccountsPage } from '@/routes/accounts-page';
import { Auth401Bridge } from '@/routes/auth-401-bridge';
import { DashboardPage } from '@/routes/dashboard-page';
import { LoginPage } from '@/routes/login-page';
import { ProtectedRoute } from '@/routes/protected-route';

/**
 * 路由表（票 46）：basename=/admin（与后端静态托管同前缀）。声明式路由
 * （BrowserRouter + useRoutes）——测试用同一张表挂 MemoryRouter，路由模式
 * 与生产一致；未登录访问任意受保护路由 → /login。
 * 票 47 起新增 accounts/:accountId（账号详情，票 49 接入八数据块视图）。
 */
export const appRoutes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: (
      <ProtectedRoute>
        <AppShell />
      </ProtectedRoute>
    ),
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'accounts', element: <AccountsPage /> },
      { path: 'accounts/:accountId', element: <AccountDetailPage /> },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
];

/** 401 桥 + 路由树：挂在 BrowserRouter/MemoryRouter 内部。 */
export function AppRoutes() {
  const routes = useRoutes(appRoutes);
  return (
    <>
      <Auth401Bridge />
      {routes}
    </>
  );
}

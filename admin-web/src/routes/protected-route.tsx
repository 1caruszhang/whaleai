import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { getAdminToken } from '@/lib/auth';

/** 把 basename 前缀剥掉，产出路由内部路径（basename=/admin）。 */
export function routePathFrom(pathname: string): string {
  if (pathname === '/admin' || pathname === '/admin/') return '/';
  return pathname.startsWith('/admin/') ? pathname.slice('/admin'.length) : pathname;
}

/**
 * 受保护路由门（票 46）：未登录访问任意 /admin 路由一律回登录页；登录页
 * 成功后经 state.from 回到原目标路径。
 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const location = useLocation();
  if (!getAdminToken()) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }
  return children;
}

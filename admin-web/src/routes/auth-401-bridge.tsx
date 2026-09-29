import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { setUnauthorizedHandler } from '@/lib/api';

/**
 * 认证闭环桥（票 46）：注册全局 401 处理器——任一 API 401（登录接口自身
 * 除外，见 lib/api.ts）→ 清凭证 → 清查询缓存 → 回登录页。挂在整个路由
 * 树根部（BrowserRouter 内、Routes 外），无论当前在哪一页都生效。
 */
export function Auth401Bridge() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  useEffect(() => {
    setUnauthorizedHandler(() => {
      queryClient.clear();
      navigate('/login', { replace: true });
    });
    return () => setUnauthorizedHandler(null);
  }, [navigate, queryClient]);

  return null;
}

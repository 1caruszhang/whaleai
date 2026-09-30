import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { EyeIcon, EyeOffIcon, Loader2Icon, LogInIcon, TriangleAlertIcon } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router';
import { BrandLogo } from '@/components/brand-logo';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, loginAdmin } from '@/lib/api';
import { setAdminToken } from '@/lib/auth';
import { routePathFrom } from '@/routes/protected-route';

/**
 * 登录页（票 46）：视觉参照 shadcn-admin auth 风格；调既有
 * POST /admin/login 换运营 JWT 存 localStorage；错误密码展示错误提示
 * （401 走 ApiError，不触发全局清证跳转，见 lib/api.ts）。
 *
 * 票 #61 T-B：对齐 shadcn-admin sign-in 页——品牌 logo 图 + 标题 + 描述
 * 居中入卡、密码可见性切换、错误提示保留 role=alert 语义、提交按钮
 * loading 态（LogIn 图标换转圈）、卡片入场淡入。
 */
export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const from = routePathFrom(
    (location.state as { from?: string } | null)?.from ?? '/',
  );
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const login = useMutation({
    mutationFn: loginAdmin,
    onSuccess: result => {
      setAdminToken(result.adminToken);
      navigate(from, { replace: true });
    },
  });

  const errorMessage =
    login.error instanceof ApiError ? login.error.message : '登录失败，请稍后重试。';

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (password.length === 0 || login.isPending) return;
    login.mutate(password);
  };

  return (
    <div className="from-muted/60 to-background flex min-h-svh flex-col items-center justify-center gap-6 bg-linear-to-b p-6">
      <Card className="animate-in fade-in-0 slide-in-from-bottom-4 fill-mode-both duration-500 w-full max-w-sm">
        <CardHeader className="items-center gap-2 text-center">
          <BrandLogo className="justify-center" />
          <h1 className="text-lg font-semibold tracking-tight">运营登录</h1>
          <CardDescription>请输入运营密码以进入运营台</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            {login.isError && (
              <div
                role="alert"
                className="text-destructive flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm"
              >
                <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
                <span>{errorMessage}</span>
              </div>
            )}
            <div className="flex flex-col gap-2">
              <Label htmlFor="admin-password">运营密码</Label>
              <div className="relative">
                <Input
                  id="admin-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  placeholder="请输入运营密码"
                  value={password}
                  onChange={event => setPassword(event.target.value)}
                  disabled={login.isPending}
                  aria-invalid={login.isError}
                  required
                  className="pe-9"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(show => !show)}
                  className="text-muted-foreground hover:text-foreground absolute inset-y-0 right-0 flex items-center px-3"
                  aria-label={showPassword ? '隐藏密码' : '显示密码'}
                >
                  {showPassword ? (
                    <EyeOffIcon className="size-4" />
                  ) : (
                    <EyeIcon className="size-4" />
                  )}
                </button>
              </div>
            </div>
            <Button type="submit" className="w-full" disabled={login.isPending || password.length === 0}>
              {login.isPending ? <Loader2Icon className="animate-spin" /> : <LogInIcon />}
              登录
            </Button>
          </form>
        </CardContent>
      </Card>
      <p className="text-muted-foreground text-center text-xs">账号开通、充值对账与点数管理</p>
    </div>
  );
}

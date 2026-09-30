import { useQueryClient } from '@tanstack/react-query';
import { LogOutIcon, UserRoundIcon } from 'lucide-react';
import { useNavigate } from 'react-router';
import { clearAdminToken } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * 用户菜单（票 46 起，票 #60 T-A 挪入页头右端）：运营身份 + 退出登录
 * （清 token 回登录页）。
 */
export function UserNav() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const logout = (): void => {
    clearAdminToken();
    queryClient.clear();
    navigate('/login', { replace: true });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="账户菜单">
          <UserRoundIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        <DropdownMenuLabel>运营</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={logout} aria-label="退出登录">
          <LogOutIcon className="size-4" />
          <span>退出登录</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

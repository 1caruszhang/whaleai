import { useQuery } from '@tanstack/react-query';
import { SearchIcon } from 'lucide-react';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { listAdminAccounts, type AdminAccount } from '@/lib/accounts';
import { cn } from '@/lib/utils';

const SEARCH_PAGE_SIZE = 10;

/** 加载态骨架行数（结果区占位，票 #60 T-A）。 */
const SEARCH_SKELETON_ROWS = 3;

interface CommandSearchProps {
  /** 面板开关由 AppShell 拥有：⌘K 快捷键与页头搜索框共用同一入口。 */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Cmd+K 全局搜索（票 51）：快捷键面板——⌘K / Ctrl+K 切换、Esc 关闭
 * （Radix Dialog 原生处理）。查询走既有 GET /admin/accounts?q=（票 47 搜索
 * 接口，手机号/用户名包含匹配），命中列表展示手机号 + 用户名 + 状态徽章；
 * ↑/↓ 移动高亮、Enter 或点击跳转到 /admin/accounts/:accountId（票 49 详情
 * 页）。挂载在受保护壳 AppShell 内，登录页不响应快捷键。不引新依赖，复用
 * shadcn/ui Dialog。票 #60 T-A 起：开关状态上提到 AppShell（页头搜索框可
 * 直接唤起），加载态换成骨架屏，结果区挂 faded-bottom 渐变遮罩工具类。
 */
export function CommandSearch({ open, onOpenChange }: CommandSearchProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const navigate = useNavigate();

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (open) {
          setQuery('');
          setActiveIndex(0);
          onOpenChange(false);
        } else {
          onOpenChange(true);
        }
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onOpenChange]);

  const trimmed = query.trim();
  const searchQuery = useQuery({
    queryKey: ['admin-command-search', trimmed],
    queryFn: () =>
      listAdminAccounts({ q: trimmed, page: 1, pageSize: SEARCH_PAGE_SIZE, sort: 'created' }),
    enabled: open && trimmed !== '',
  });

  const accounts = searchQuery.data?.accounts ?? [];

  // 结果集变化（换词/新数据）时高亮回到第一项。
  useEffect(() => {
    setActiveIndex(0);
  }, [trimmed, accounts.length]);

  function close() {
    setQuery('');
    setActiveIndex(0);
    onOpenChange(false);
  }

  function go(account: AdminAccount) {
    navigate(`/accounts/${account.id}`);
    close();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex(index => Math.min(index + 1, accounts.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex(index => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const account = accounts[activeIndex];
      if (account) go(account);
    }
  }

  return (
    <Dialog open={open} onOpenChange={isOpen => (isOpen ? onOpenChange(true) : close())}>
      <DialogContent className="top-[20%] translate-y-0 gap-0 p-0 sm:max-w-xl" showCloseButton={false}>
        <DialogHeader className="sr-only">
          <DialogTitle>搜索账号</DialogTitle>
          <DialogDescription>按手机号或用户名搜索账号并跳转详情</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 border-b px-4">
          <SearchIcon className="text-muted-foreground size-4 shrink-0" />
          <Input
            autoFocus
            className="border-0 shadow-none focus-visible:ring-0"
            placeholder="按手机号或用户名搜索账号…"
            aria-label="全局搜索账号"
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        <div className="faded-bottom max-h-80 overflow-y-auto p-2" role="listbox" aria-label="搜索结果">
          {trimmed === '' && (
            <p className="text-muted-foreground px-3 py-6 text-center text-sm">
              输入手机号或用户名开始搜索
            </p>
          )}
          {trimmed !== '' && searchQuery.isLoading && (
            <div role="status" className="flex flex-col gap-2 p-1">
              <span className="sr-only">搜索中…</span>
              {Array.from({ length: SEARCH_SKELETON_ROWS }, (_, index) => (
                <Skeleton key={index} className="h-9 w-full" />
              ))}
            </div>
          )}
          {trimmed !== '' && !searchQuery.isLoading && accounts.length === 0 && (
            <p className="text-muted-foreground px-3 py-6 text-center text-sm">无匹配账号</p>
          )}
          {accounts.map((account, index) => (
            <button
              key={account.id}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              aria-label={`跳转 ${account.phone}${account.displayName !== '' ? ` ${account.displayName}` : ''}`}
              className={cn(
                'hover:bg-accent flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm',
                index === activeIndex && 'bg-accent',
              )}
              onClick={() => go(account)}
            >
              <span className="font-medium">{account.phone}</span>
              <span className="text-muted-foreground truncate">
                {account.displayName === '' ? '—' : account.displayName}
              </span>
              <span className="ml-auto shrink-0">
                {account.status === 'active' ? (
                  <Badge variant="success">正常</Badge>
                ) : (
                  <Badge variant="destructive">已停用</Badge>
                )}
              </span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

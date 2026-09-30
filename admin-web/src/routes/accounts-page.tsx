import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SearchIcon,
} from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError } from '@/lib/api';
import {
  chatQuotaRemainingPoints,
  listAdminAccounts,
  setAdminAccountStatus,
  type AdminAccount,
  type AdminAccountSort,
} from '@/lib/accounts';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { AdjustDialog, CreateAccountDialog, TopupDialog } from '@/routes/account-dialogs';

/**
 * 账号列表页（票 47）：9 列（手机号+待改密小标、用户名、状态徽章、余额
 * 可用/冻结、对话额度、品牌集 chips、最近活跃、建号时间、操作下拉）。
 * 搜索/分页/排序全部落在 URL 查询参数上（useSearchParams），react-query
 * 按参数组合缓存与重取——刷新/深链可回放同一视图。行操作下拉：
 * 详情（跳详情页，T3 接入）、充值/调点（对话框，接既有 ledger 端点）、
 * 停用·启用（即时生效，停用吊销账号全部会话）。
 *
 * 票 #62 T-C 视觉对齐 shadcn-admin Users 页：页头（标题 + 描述 + 开通账号
 * 按钮）；工具栏（搜索框 + 排序下拉 + 每页条数下拉）；卡片式表格（圆角
 * border 容器、行 hover、操作下拉）；分页补页码按钮与首尾图标按钮；加载态
 * 换 ui/skeleton 表格骨架（替代「加载中…」文字）；页头与内容入场淡入错峰。
 * 9 列内容与品牌 chips 只读展示、查询参数与 react-query 数据流零改动。
 */

const SORT_OPTIONS: { value: AdminAccountSort; label: string }[] = [
  { value: 'created', label: '建号时间' },
  { value: 'balance', label: '余额' },
  { value: 'active', label: '最近活跃' },
];

const PAGE_SIZE_OPTIONS = [25, 50, 100];

/** 列表骨架行数：填满首屏高度的占位行。 */
const SKELETON_ROWS = 6;

/** 页头/内容入场动画：淡入 + 上浮（与 T-B 卡片同款手法），内容错峰 60ms。 */
const PAGE_ENTRANCE = 'animate-in fade-in-0 slide-in-from-bottom-2 fill-mode-both duration-500';

function sortFrom(raw: string | null): AdminAccountSort {
  return raw === 'balance' || raw === 'active' ? raw : 'created';
}

function pageSizeFrom(raw: string | null): number {
  const value = Number(raw);
  return PAGE_SIZE_OPTIONS.includes(value) ? value : 25;
}

function pageFrom(raw: string | null): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : 1;
}

/** 页码序列：总页数 ≤7 全列；否则首尾恒在 + 当前页 ±1，间隔补省略号。 */
function getPageNumbers(current: number, total: number): (number | '...')[] {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  const pages: (number | '...')[] = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  if (start > 2) pages.push('...');
  for (let pageNumber = start; pageNumber <= end; pageNumber += 1) pages.push(pageNumber);
  if (end < total - 1) pages.push('...');
  pages.push(total);
  return pages;
}

/** 表格加载骨架：表头 + 占位行，替代「加载中…」文字。 */
function AccountsTableSkeleton() {
  return (
    <div data-testid="accounts-skeleton" className="overflow-hidden rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            {Array.from({ length: 9 }, (_, index) => (
              <TableHead key={index}>
                <Skeleton className="h-4 w-16" />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: SKELETON_ROWS }, (_, row) => (
            <TableRow key={row}>
              {Array.from({ length: 9 }, (_, col) => (
                <TableCell key={col}>
                  <Skeleton className="h-4 w-20" />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function AccountsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get('q') ?? '';
  const page = pageFrom(searchParams.get('page'));
  const pageSize = pageSizeFrom(searchParams.get('pageSize'));
  const sort = sortFrom(searchParams.get('sort'));

  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchInput, setSearchInput] = useState(q);
  const [createOpen, setCreateOpen] = useState(false);
  const [topupAccount, setTopupAccount] = useState<AdminAccount | null>(null);
  const [adjustAccount, setAdjustAccount] = useState<AdminAccount | null>(null);

  const listQuery = useQuery({
    queryKey: ['admin-accounts', q, page, pageSize, sort],
    queryFn: () => listAdminAccounts({ q, page, pageSize, sort }),
    placeholderData: keepPreviousData,
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'active' | 'disabled' }) =>
      setAdminAccountStatus(id, status),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-accounts'] });
    },
  });

  function refreshList() {
    void queryClient.invalidateQueries({ queryKey: ['admin-accounts'] });
  }

  /** 写 URL 查询参数：筛选/排序/页大小变更回第 1 页；分页只动 page。 */
  function updateParams(patch: { q?: string; page?: number; pageSize?: number; sort?: AdminAccountSort }) {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (patch.q !== undefined) {
        if (patch.q === '') next.delete('q');
        else next.set('q', patch.q);
        next.delete('page');
      }
      if (patch.pageSize !== undefined) {
        next.set('pageSize', String(patch.pageSize));
        next.delete('page');
      }
      if (patch.sort !== undefined) {
        next.set('sort', patch.sort);
        next.delete('page');
      }
      if (patch.page !== undefined) {
        if (patch.page <= 1) next.delete('page');
        else next.set('page', String(patch.page));
      }
      return next;
    });
  }

  function onSearchSubmit(event: FormEvent) {
    event.preventDefault();
    updateParams({ q: searchInput.trim() });
  }

  const accounts = listQuery.data?.accounts ?? [];
  const total = listQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const sortLabel = SORT_OPTIONS.find(option => option.value === sort)?.label ?? '建号时间';
  const pageNumbers = getPageNumbers(page, totalPages);

  return (
    <div className="flex flex-col gap-6">
      <div className={cn(PAGE_ENTRANCE, 'flex flex-wrap items-end justify-between gap-4')}>
        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight">账号</h1>
          <p className="text-muted-foreground text-sm">开通、停用与对账管理</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <PlusIcon /> 开通账号
        </Button>
      </div>

      <div className={cn(PAGE_ENTRANCE, 'flex flex-col gap-4')} style={{ animationDelay: '60ms' }}>
        <div className="flex flex-wrap items-center gap-2">
          <form onSubmit={onSearchSubmit} className="flex items-center gap-2">
            <Input
              className="h-8 w-64"
              placeholder="按手机号或用户名搜索"
              aria-label="搜索账号"
              value={searchInput}
              onChange={event => setSearchInput(event.target.value)}
            />
            <Button type="submit" variant="outline" size="sm">
              <SearchIcon /> 搜索
            </Button>
          </form>
          <div className="ml-auto flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  排序：{sortLabel} <ChevronsUpDownIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuRadioGroup
                  value={sort}
                  onValueChange={value => updateParams({ sort: value as AdminAccountSort })}
                >
                  {SORT_OPTIONS.map(option => (
                    <DropdownMenuRadioItem key={option.value} value={option.value}>
                      {option.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  每页 {pageSize} 条 <ChevronsUpDownIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuRadioGroup
                  value={String(pageSize)}
                  onValueChange={value => updateParams({ pageSize: Number(value) })}
                >
                  {PAGE_SIZE_OPTIONS.map(size => (
                    <DropdownMenuRadioItem key={size} value={String(size)}>
                      {size} 条/页
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {statusMutation.isError && (
          <p role="alert" className="text-destructive text-sm">
            {statusMutation.error instanceof ApiError
              ? statusMutation.error.message
              : '账号状态操作失败，请稍后重试。'}
          </p>
        )}

        {listQuery.isLoading && <AccountsTableSkeleton />}
        {listQuery.isError && !listQuery.isLoading && (
          <p role="alert" className="text-destructive py-12 text-center text-sm">
            {listQuery.error instanceof ApiError
              ? listQuery.error.message
              : '账号列表加载失败，请稍后重试。'}
          </p>
        )}
        {!listQuery.isLoading && !listQuery.isError && (
          <>
            <div data-testid="accounts-table-card" className="overflow-hidden rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>手机号</TableHead>
                    <TableHead>用户名</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>余额（可用/冻结）</TableHead>
                    <TableHead>对话额度</TableHead>
                    <TableHead>品牌集</TableHead>
                    <TableHead>最近活跃</TableHead>
                    <TableHead>建号时间</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {accounts.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={9} className="text-muted-foreground h-24 text-center">
                        暂无账号
                      </TableCell>
                    </TableRow>
                  )}
                  {accounts.map(account => (
                    <AccountRow
                      key={account.id}
                      account={account}
                      onNavigate={() => navigate(`/accounts/${account.id}`)}
                      onTopup={() => setTopupAccount(account)}
                      onAdjust={() => setAdjustAccount(account)}
                      onToggleStatus={() =>
                        statusMutation.mutate({
                          id: account.id,
                          status: account.status === 'active' ? 'disabled' : 'active',
                        })
                      }
                    />
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-muted-foreground text-sm">
                共 {total} 条 · 第 {page} / {totalPages} 页
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  className="size-8"
                  disabled={page <= 1}
                  onClick={() => updateParams({ page: page - 1 })}
                >
                  <span className="sr-only">上一页</span>
                  <ChevronLeftIcon />
                </Button>
                {pageNumbers.map((pageNumber, index) =>
                  pageNumber === '...' ? (
                    <span key={`ellipsis-${index}`} className="text-muted-foreground px-1 text-sm">
                      …
                    </span>
                  ) : (
                    <Button
                      key={pageNumber}
                      variant={page === pageNumber ? 'default' : 'outline'}
                      className="h-8 min-w-8 px-2"
                      aria-label={`第 ${pageNumber} 页`}
                      onClick={() => updateParams({ page: pageNumber })}
                    >
                      {pageNumber}
                    </Button>
                  ),
                )}
                <Button
                  variant="outline"
                  size="icon"
                  className="size-8"
                  disabled={page >= totalPages}
                  onClick={() => updateParams({ page: page + 1 })}
                >
                  <span className="sr-only">下一页</span>
                  <ChevronRightIcon />
                </Button>
              </div>
            </div>
          </>
        )}
      </div>

      <CreateAccountDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          refreshList();
          setCreateOpen(false);
        }}
      />
      {topupAccount !== null && (
        <TopupDialog
          account={topupAccount}
          open
          onOpenChange={open => {
            if (!open) setTopupAccount(null);
          }}
          onDone={() => {
            refreshList();
            setTopupAccount(null);
          }}
        />
      )}
      {adjustAccount !== null && (
        <AdjustDialog
          account={adjustAccount}
          open
          onOpenChange={open => {
            if (!open) setAdjustAccount(null);
          }}
          onDone={() => {
            refreshList();
            setAdjustAccount(null);
          }}
        />
      )}
    </div>
  );
}

interface AccountRowProps {
  account: AdminAccount;
  onNavigate: () => void;
  onTopup: () => void;
  onAdjust: () => void;
  onToggleStatus: () => void;
}

function AccountRow({
  account,
  onNavigate,
  onTopup,
  onAdjust,
  onToggleStatus,
}: AccountRowProps) {
  const remaining = chatQuotaRemainingPoints(account.chatQuota);
  return (
    <TableRow>
      <TableCell>
        <span className="flex items-center gap-1.5">
          {account.phone}
          {account.mustChangePassword && <Badge variant="warning">待改密</Badge>}
        </span>
      </TableCell>
      {/* 旧账号无用户名显示「—」；「—」也用于品牌集/最近活跃空态，
          测试用 data-testid 收窄到本列。 */}
      <TableCell data-testid="display-name">
        {account.displayName === '' ? '—' : account.displayName}
      </TableCell>
      <TableCell>
        {account.status === 'active' ? (
          <Badge variant="success">正常</Badge>
        ) : (
          <Badge variant="destructive">已停用</Badge>
        )}
      </TableCell>
      <TableCell>
        {account.balance.available} / {account.balance.frozen}
      </TableCell>
      <TableCell>
        {remaining <= 0 ? <Badge variant="destructive">已用尽</Badge> : `${remaining.toFixed(1)} 点`}
      </TableCell>
      <TableCell>
        {account.brands.length === 0 ? (
          '—'
        ) : (
          <span className="flex flex-wrap gap-1">
            {account.brands.map(brand => (
              <Badge key={brand.workspaceId} variant="outline">
                {brand.name}
              </Badge>
            ))}
          </span>
        )}
      </TableCell>
      <TableCell>{account.lastActiveAt === null ? '—' : formatDateTime(account.lastActiveAt)}</TableCell>
      <TableCell>{formatDateTime(account.createdAt)}</TableCell>
      <TableCell className="text-right">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={`操作 ${account.phone}`}>
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onNavigate}>详情</DropdownMenuItem>
            <DropdownMenuItem onSelect={onTopup}>充值</DropdownMenuItem>
            <DropdownMenuItem onSelect={onAdjust}>调点</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onToggleStatus}>
              {account.status === 'active' ? '停用' : '启用'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}

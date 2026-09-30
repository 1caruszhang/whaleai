import { cn } from '@/lib/utils';

/** 骨架屏（票 #60 T-A）：加载占位块，对齐 shadcn-admin 的 animate-pulse 骨架。 */
function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      className={cn('bg-accent animate-pulse rounded-md', className)}
      {...props}
    />
  );
}

export { Skeleton };

import type { BackendDeps } from '../deps';
import { DistributionUpstream } from '../gateway/distribution-upstream';
import {
  poolSnapshotStats,
  refreshDistributionPoolSnapshot,
  type PoolKind,
  type PoolSnapshotStats,
} from './distribution-pool-snapshot';

/**
 * 池快照定时刷新（偏好名单 P3.3，用户裁决 2026-09-08：进程内定时，不引入
 * cron 依赖、不开管理端点鉴权口子）：
 *
 * - 每日一次，凌晨 04:00（服务器本地时区低峰）；
 * - 启动时补刷：快照为空或距最近成功刷新超 24h → 立即刷一次；
 * - 复用 refreshDistributionPoolSnapshot 编排（两类全部拉完才落库，失败
 *   零写入），定时侧失败只打脱敏日志、不重试不告警（第二天照常再试）；
 * - 与管理页手动「刷新池快照」共享进程内互斥：任一方在跑，另一方立即
 *   忙信号返回，绝不并发重入（整类替换的两路并发会互相覆盖）。
 *
 * 定时器 unref：不阻塞进程正常退出（SIGINT/SIGTERM 关服无需等下一班）。
 */

/** 每日定时刷新时点（服务器本地时区）。 */
const DAILY_REFRESH_HOUR = 4;

/** 启动补刷阈值：快照为空或超 24h 视为过期。 */
const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const SNAPSHOT_PAGE_SIZE = 200;
const SNAPSHOT_PAGE_DELAY_MS = 120;

/** 全量刷新互斥的进行中任务（模块级单例：定时与手动同进程共享）。 */
let refreshInFlight: Promise<unknown> | null = null;

/**
 * 下一次每日刷新的时刻（epoch 毫秒）：当日 04:00，已过（含恰好等于）则
 * 取明日。纯函数——时区按宿主本地（服务器时区），跨夏令时偏移由 Date
 * 本地构造自然处理。
 */
export function nextDailyRefreshAt(now: Date): number {
  const next = new Date(now);
  next.setHours(DAILY_REFRESH_HOUR, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime();
}

/** 启动补刷判定：无行/无时间戳/超 24h 视为过期。纯函数。 */
export function isSnapshotStale(stats: PoolSnapshotStats, nowMs: number): boolean {
  if (stats.rows === 0 || stats.fetchedAt === null) return true;
  return nowMs - Date.parse(stats.fetchedAt) > SNAPSHOT_MAX_AGE_MS;
}

export interface PoolRefreshOutcome {
  /** false = 互斥忙（已在跑），本次未启动。 */
  ran: boolean;
  fetchedAtIso?: string;
  counts?: Record<PoolKind, number>;
}

/**
 * 全量刷新互斥执行（手动按钮与定时任务共用出口）：构造与 admin 路由一致
 * 的 fetchPage（上游签名客户端、单页失败重试在编排内），AppError 向调用方
 * 透传（手动侧渲染报错页，定时侧打日志）。
 */
export async function runDistributionPoolRefreshOnce(
  deps: BackendDeps,
): Promise<PoolRefreshOutcome> {
  if (refreshInFlight !== null) return { ran: false };
  const upstream = new DistributionUpstream(deps, deps.fetchImpl ?? fetch);
  const fetchPage = async (kind: PoolKind, page: number) => {
    const result = await upstream.listResources(kind, page, SNAPSHOT_PAGE_SIZE);
    return result.ok
      ? {
          total: result.data.total,
          items: result.data.items.map(item => ({
            resourceId: item.id,
            name: item.name,
            domain: item.entranceDomain,
            priceCents: item.priceCents,
            status: item.status,
            geoCount: item.geoCount,
            categoryCode: item.categoryCode,
            platform: item.platform,
            fansNumber: item.fansNumber,
          })),
        }
      : null;
  };
  const task = refreshDistributionPoolSnapshot(
    deps,
    fetchPage,
    ms => new Promise(resolve => setTimeout(resolve, ms)),
    SNAPSHOT_PAGE_DELAY_MS,
  );
  refreshInFlight = task;
  try {
    const { fetchedAtIso, counts } = await task;
    return { ran: true, fetchedAtIso, counts };
  } finally {
    refreshInFlight = null;
  }
}

/** 定时侧统一脱敏日志：AppError 用其文案（带类别/页号、无内部信息），其余只记类型。 */
function logScheduledFailure(error: unknown): void {
  const message =
    error instanceof Error && error.message ? error.message : 'unknown error';
  console.warn(`[pool-snapshot] scheduled refresh failed: ${message}`);
}

async function runScheduledRefresh(deps: BackendDeps): Promise<void> {
  try {
    const outcome = await runDistributionPoolRefreshOnce(deps);
    if (outcome.ran) {
      console.log(
        `[pool-snapshot] scheduled refresh ok: media ${outcome.counts?.media ?? 0}, we-media ${outcome.counts?.['we-media'] ?? 0}`,
      );
    }
  } catch (error) {
    logScheduledFailure(error);
  }
}

/**
 * 定时器抽象（测试注入手动时钟；Node/DOM setTimeout 重载形状不同，不直接
 * 引用其类型）：schedule 返回可清除句柄；生产实现 unref 不阻塞进程退出
 * （SIGINT/SIGTERM 关服无需等下一班）。
 */
export interface PoolSchedulerTimers {
  schedule(callback: () => void, delayMs: number): { clear(): void };
}

const realTimers: PoolSchedulerTimers = {
  schedule: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs) as unknown as {
      unref?: () => void;
    };
    handle.unref?.();
    return { clear: () => clearTimeout(handle as unknown as Parameters<typeof clearTimeout>[0]) };
  },
};

/**
 * 启动定时器（生产组合根调用；测试经 createBackendApp 起服不经此处）：
 * 先按需补刷，再排下一个 04:00；每班跑完重排下一班。返回句柄仅供测试
 * 提前停表，生产无需持有。
 */
export function startDistributionPoolScheduler(
  deps: BackendDeps,
  timers: PoolSchedulerTimers = realTimers,
): { stop: () => void } {
  // 启动补刷：异步进行，不阻塞监听端口的启动路径。
  if (isSnapshotStale(poolSnapshotStats(deps.db), deps.now())) {
    void runScheduledRefresh(deps);
  }
  let stopped = false;
  let handle: { clear(): void } | undefined;
  const scheduleNext = (): void => {
    if (stopped) return;
    handle = timers.schedule(
      () => {
        void runScheduledRefresh(deps).finally(scheduleNext);
      },
      Math.max(0, nextDailyRefreshAt(new Date(deps.now())) - deps.now()),
    );
  };
  scheduleNext();
  return {
    stop: () => {
      stopped = true;
      handle?.clear();
    },
  };
}

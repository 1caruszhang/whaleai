import type { BackendDeps } from '../deps';
import type { SqlClient } from '../db/client';
import { AppError } from '../errors';
import { mediaChannelTypeCodesFor } from './pool-industry-match';

/**
 * 资源池快照（偏好名单匹配挑选流程 0011）：上游 /media|we-media/resource
 * 只有 page/size 分页、没有名称搜索，「点击匹配」必须自建快照——管理页
 * 手动触发全量刷新（每类串行分页、页间限速），此后搜索只打本地表；勾选
 * 确认也从本表取挂牌名与 entrance 域名（运营写入的每个字段都来自上游
 * 快照，不来自表单回传）。status 用上游资源状态词表（附录：资源状态，
 * 2=已通过，其余均未上架）。
 */

export type PoolKind = 'media' | 'we-media';

export const POOL_KINDS: readonly PoolKind[] = ['media', 'we-media'];

export function isPoolKind(value: string): value is PoolKind {
  return value === 'media' || value === 'we-media';
}

export interface PoolSnapshotRow {
  kind: string;
  resource_id: number;
  name: string;
  domain: string;
  status: number | null;
  price_cents: number;
  geo_count: number;
  /** 结构化类目码，按形态解释（媒体=channel_type，自媒体=industry_category）；null=未分类/缺省。 */
  category_code: number | null;
  /** 1=官方 GEO 标记（geo_platforms 非空），行业无关。 */
  geo: number;
  fetched_at: string;
}

/** 单条上游资源（列表接口解析后的最小投影，price 为展示口径非计价权威）。 */
export interface PoolSnapshotItem {
  resourceId: number;
  name: string;
  domain: string;
  priceCents: number;
  status: number | null;
  geoCount: number;
  categoryCode: number | null;
}

const SNAPSHOT_COLUMNS =
  'kind, resource_id, name, domain, status, price_cents, geo_count, category_code, geo, fetched_at';

/**
 * 整类替换：全量刷新的写入侧——先删该类全部行再批量插入（同一事务），
 * 快照始终等于「最近一次成功刷新时上游列表的样子」，列表不再返回的资源
 * 不会以陈旧行残留。批量插入按 500 行/条语句分块（16k 行 ≈ 32 条）。
 */
export function replacePoolSnapshot(
  db: SqlClient,
  kind: PoolKind,
  items: readonly PoolSnapshotItem[],
  fetchedAtIso: string,
): void {
  db.transaction(() => {
    db.run('DELETE FROM distribution_pool_snapshot WHERE kind = ?', [kind]);
    const chunkSize = 500;
    for (let start = 0; start < items.length; start += chunkSize) {
      const chunk = items.slice(start, start + chunkSize);
      const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      const params: unknown[] = [];
      for (const item of chunk) {
        params.push(
          kind,
          item.resourceId,
          item.name,
          item.domain,
          item.status,
          item.priceCents,
          item.geoCount,
          item.categoryCode,
          item.geoCount > 0 ? 1 : 0,
          fetchedAtIso,
        );
      }
      db.run(
        `INSERT INTO distribution_pool_snapshot (${SNAPSHOT_COLUMNS}) VALUES ${placeholders}`,
        params,
      );
    }
  });
}

/** LIKE 通配符转义（contains 语义：用户输入的 %/_ 按字面匹配）。 */
function escapeLikePattern(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

/**
 * 行业过滤 SQL 片（规则见 pool-industry-match.ts）：自媒体按
 * industry_category 码相等 ∪ 媒体按 channel_type 映射码集；无映射码的
 * 行业（历史/三农等）媒体子句自然消失，只剩自媒体。GEO 标记**不入选**
 * （仅结果表展示）——它是召回质量信号不是行业归属，混入会让行业视图
 * 候选被无关渠道占据。industry 缺省/0 = 不过滤（全池）。
 */
function industryFilterSql(industry: number | undefined): { clause: string; params: unknown[] } | null {
  if (industry === undefined || industry === 0) return null;
  const mediaCodes = [...mediaChannelTypeCodesFor(industry)].sort((a, b) => a - b);
  const parts: string[] = ["(kind = 'we-media' AND category_code = ?)"];
  const params: unknown[] = [industry];
  if (mediaCodes.length > 0) {
    parts.push(`(kind = 'media' AND category_code IN (${mediaCodes.map(() => '?').join(', ')}))`);
    params.push(...mediaCodes);
  }
  return { clause: `(${parts.join(' OR ')})`, params };
}

/**
 * 名称包含匹配（两类合并）：LIMIT 截断在调用方。排序 kind/resource_id
 * 全序确定，同快照同词的搜索结果稳定。SQLite LIKE 对 ASCII 不区分大小写、
 * 对中文按码位比较——「包含」语义对两者都成立。industry 见 industryFilterSql。
 */
export function searchPoolSnapshot(
  db: SqlClient,
  query: string,
  limit: number,
  industry?: number,
): PoolSnapshotRow[] {
  const filter = industryFilterSql(industry);
  return db.all<PoolSnapshotRow>(
    `SELECT ${SNAPSHOT_COLUMNS} FROM distribution_pool_snapshot
     WHERE name LIKE ? ESCAPE '\\' ${filter ? `AND ${filter.clause}` : ''}
     ORDER BY kind ASC, resource_id ASC LIMIT ?`,
    [`%${escapeLikePattern(query)}%`, ...(filter?.params ?? []), limit],
  );
}

export interface PoolSnapshotStats {
  rows: number;
  /** 最近一次成功刷新时间（全部行同一时间戳，取 MAX 兜底）。 */
  fetchedAt: string | null;
}

export function poolSnapshotStats(db: SqlClient): PoolSnapshotStats {
  const row = db.get<{ rows: number; fetched_at: string | null }>(
    'SELECT COUNT(*) AS rows, MAX(fetched_at) AS fetched_at FROM distribution_pool_snapshot',
    [],
  );
  return { rows: row?.rows ?? 0, fetchedAt: row?.fetched_at ?? null };
}

export function poolRefKey(kind: string, resourceId: number): string {
  return `${kind}:${resourceId}`;
}

/**
 * 快照名称候选头部（搜索框 datalist 预渲染用）：按（kind, resource_id）
 * 全序取前 limit 个不重名，industry 过滤同 searchPoolSnapshot。JS 侧去重
 * 而非 SQL DISTINCT——DISTINCT 与子查询 ORDER BY 的组合跨 SQLite/PG 无
 * 确定性语义保证，全序扫描 2.5 万行在管理页量级可忽略。上限之外的名字靠
 * 「当前搜索结果」并入（见 admin-pages），输入提示是辅助不是完整检索。
 */
export function listPoolSnapshotNames(
  db: SqlClient,
  limit: number,
  industry?: number,
): string[] {
  const filter = industryFilterSql(industry);
  const rows = db.all<{ name: string }>(
    `SELECT name FROM distribution_pool_snapshot
     ${filter ? `WHERE ${filter.clause}` : ''}
     ORDER BY kind ASC, resource_id ASC`,
    filter?.params ?? [],
  );
  const names: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.name === '' || seen.has(row.name)) continue;
    seen.add(row.name);
    names.push(row.name);
    if (names.length >= limit) break;
  }
  return names;
}

/** 按（kind, resource_id）引用集合取快照行（勾选确认与名单状态展示用）。 */
export function poolSnapshotByRefs(
  db: SqlClient,
  refs: readonly { kind: string; resourceId: number }[],
): Map<string, PoolSnapshotRow> {
  const map = new Map<string, PoolSnapshotRow>();
  for (const ref of refs) {
    const key = poolRefKey(ref.kind, ref.resourceId);
    if (map.has(key)) continue;
    const row = db.get<PoolSnapshotRow>(
      `SELECT ${SNAPSHOT_COLUMNS} FROM distribution_pool_snapshot WHERE kind = ? AND resource_id = ?`,
      [ref.kind, ref.resourceId],
    );
    if (row) map.set(key, row);
  }
  return map;
}

export interface PoolPageResult {
  total: number;
  items: PoolSnapshotItem[];
}

/** 分页护栏：全池约 2.5 万条 / 200 一页 ≈ 125 页； runaway 上游（total 异常膨胀）直接失败。 */
const MAX_REFRESH_PAGES_PER_KIND = 1000;

/** 单页重试次数：串行 125 页的长跑中单页瞬态失败（5xx/限流）重试两次再放弃。 */
const MAX_PAGE_ATTEMPTS = 3;

/**
 * 全量刷新编排：两类全部拉完才落库（任一页重试耗尽仍失败则零写入，旧快照
 * 保持可用），页间 sleep 限速。fetchPage 返回 null 表示该页上游失败（HTTP/
 * 业务码/形态不符由适配层归一），单页先重试两次（间隔 5×页延迟）再翻成带
 * 类别与页号的 502 AppError——运营侧能直接看出卡在哪一页。终止条件二选一：
 * 收满 total（正常拉完）或上游返回空页（上游自身宣告取尽，total 允许偏大）；
 * 两者都不满足而翻满页护栏（runaway 上游：total 异常膨胀/翻页永不结束）则
 * 整次失败零写入——绝不把残缺快照静默替换掉完整旧快照。fetched_at 取刷新
 * 开始时刻——页面上「池快照：时间」由此而来。maxPages 仅供测试注入护栏。
 */
export async function refreshDistributionPoolSnapshot(
  deps: BackendDeps,
  fetchPage: (kind: PoolKind, page: number) => Promise<PoolPageResult | null>,
  sleep: (ms: number) => Promise<void>,
  pageDelayMs: number,
  maxPages: number = MAX_REFRESH_PAGES_PER_KIND,
): Promise<{ fetchedAtIso: string; counts: Record<PoolKind, number> }> {
  const fetchedAtIso = new Date(deps.now()).toISOString();
  const collected: Record<PoolKind, PoolSnapshotItem[]> = { media: [], 'we-media': [] };
  for (const kind of POOL_KINDS) {
    let total = 0;
    const seen = new Set<number>();
    let complete = false;
    for (let page = 1; page <= maxPages; page += 1) {
      if (page > 1) await sleep(pageDelayMs);
      let result: PoolPageResult | null = null;
      for (let attempt = 1; attempt <= MAX_PAGE_ATTEMPTS; attempt += 1) {
        result = await fetchPage(kind, page);
        if (result !== null) break;
        if (attempt < MAX_PAGE_ATTEMPTS) await sleep(pageDelayMs * 5);
      }
      if (result === null) {
        throw new AppError(
          'upstream_unavailable',
          `上游资源列表拉取失败（${kind} 第 ${page} 页），池快照未更新。`,
          502,
        );
      }
      if (page === 1) total = result.total;
      for (const item of result.items) {
        if (seen.has(item.resourceId)) continue;
        seen.add(item.resourceId);
        collected[kind].push(item);
      }
      if (collected[kind].length >= total || result.items.length === 0) {
        complete = true;
        break;
      }
    }
    if (!complete) {
      throw new AppError(
        'upstream_unavailable',
        `上游资源列表分页超出护栏（${kind}：已拉 ${maxPages} 页共 ${collected[kind].length} 条，上游声称共 ${total} 条），池快照未更新。`,
        502,
      );
    }
  }
  const counts: Record<PoolKind, number> = {
    media: collected.media.length,
    'we-media': collected['we-media'].length,
  };
  for (const kind of POOL_KINDS) {
    replacePoolSnapshot(deps.db, kind, collected[kind], fetchedAtIso);
  }
  return { fetchedAtIso, counts };
}

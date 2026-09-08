import { randomUUID } from 'node:crypto';
import type { BackendDeps } from '../deps';
import type { SqlClient } from '../db/client';
import { AppError } from '../errors';
import type { PoolKind } from './distribution-pool-snapshot';

/**
 * 偏好召回名单（js_ai preferenceChannels 契约）的服务端权威存储。
 * 行业键是「品牌所属行业」选择器，不是渠道形态分类——它只回答「哪个
 * 行业的计划能看到这条偏好」；条目命中按名称/域名对整个资源池（媒体 +
 * 自媒体）匹配，与形态无关。词表 = 两张官方附录的行业并集：1-25 与桌面端
 * WE_MEDIA_INDUSTRY_NAMES 逐条一致（行业分类附录；两张官方码表码值冲突——
 * 媒体 channel_type 13=套餐系列 vs 自媒体 industry_category 13=美食——故
 * 打标只用本词表，不与媒体码表混用）；26=工业贸易为媒体附录独有类目的
 * 补位码（自媒体附录无工业类目，工业/制造/化工/能源/物流线品牌靠它才能
 * 走行业隔离，否则只能落通用）。100「其他」被桌面 industryCodesFor 的
 * NON_INDUSTRY 集排除、永不出现在请求码集，不入白名单。桌面端经
 * /config/preference-channels?codes=… 按码拉取（整数等值，无任何模糊
 * 行业逻辑）。
 */
export const PREFERENCE_CATEGORY_NAMES: Readonly<Record<number, string>> = {
  0: '通用',
  1: '文化',
  2: '历史',
  3: '三农',
  4: '财经',
  5: '科技',
  6: '体育',
  7: '汽车',
  8: '娱乐',
  9: '时尚',
  10: '健康',
  11: '教育',
  12: '母婴',
  13: '美食',
  14: '旅游',
  15: '公益',
  16: '游戏',
  17: '动漫',
  18: '社会',
  19: '房产',
  20: '职场',
  21: '情感',
  22: '搞笑',
  23: '新闻',
  24: '家居',
  25: '生活',
  26: '工业贸易',
};

/**
 * 下发投影条目（桌面 preferenceEntryMatches 契约形状）。resourceId 在场
 * （勾选绑定的行）时桌面按 id 相等命中——形态与挂牌名天然正确，名称漂移
 * 不再断裂；不在场时走既有名称匹配。kind 仅绑定行下发（media/we-media）。
 */
export interface PreferenceChannelEntry {
  name: string;
  domain?: string;
  exact: boolean;
  kind?: string;
  resourceId?: number;
}

export interface PreferenceChannelRow {
  id: string;
  category: number;
  name: string;
  domain: string;
  exact: number;
  /** ''=名称条目（种子/手输），media/we-media=池内资源绑定行。 */
  kind: string;
  /** 绑定行的池内资源 id；名称条目为 null。 */
  resource_id: number | null;
  created_at: string;
  updated_at: string;
}

const SELECT_COLUMNS =
  'id, category, name, domain, exact, kind, resource_id, created_at, updated_at';

export function listPreferenceChannels(db: SqlClient): PreferenceChannelRow[] {
  return db.all<PreferenceChannelRow>(
    `SELECT ${SELECT_COLUMNS} FROM preference_channels ORDER BY category ASC, created_at ASC, id ASC`,
    [],
  );
}

export function addPreferenceChannel(
  deps: BackendDeps,
  input: { category: number; name: string; domain: string; exact: boolean },
): PreferenceChannelRow {
  const name = input.name.trim().replace(/\s+/g, ' ');
  if (name.length === 0 || Array.from(name).length > 200) {
    throw new AppError('validation_error', '渠道名不能为空且最长 200 字。', 400);
  }
  const domain = input.domain.trim();
  if (Array.from(domain).length > 200) {
    throw new AppError('validation_error', '域名最长 200 字。', 400);
  }
  if (!(input.category in PREFERENCE_CATEGORY_NAMES)) {
    throw new AppError('validation_error', '行业类目不在官方行业分类码表内。', 400);
  }
  const nowIso = new Date(deps.now()).toISOString();
  const row: PreferenceChannelRow = {
    id: randomUUID(),
    category: input.category,
    name,
    domain,
    exact: input.exact ? 1 : 0,
    kind: '',
    resource_id: null,
    created_at: nowIso,
    updated_at: nowIso,
  };
  deps.db.run(
    'INSERT INTO preference_channels (id, category, name, domain, exact, kind, resource_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [row.id, row.category, row.name, row.domain, row.exact, row.kind, row.resource_id, row.created_at, row.updated_at],
  );
  return row;
}

/** 池快照勾选确认的单条输入：name/domain 由调用方取自快照行（上游权威）。 */
export interface PreferenceChannelBindingPick {
  kind: PoolKind;
  resourceId: number;
  name: string;
  domain: string;
}

/**
 * 批量落绑定行（勾选确认）：每勾一行一条，exact=1（id 相等命中即精确，
 * 名称匹配分支不参与）。同（category, kind, resource_id）已存在则静默跳过
 * （重复提交/重复勾选不产生重复行）；任一条目非法整批拒绝零写入。
 */
export function addPreferenceChannelBindings(
  deps: BackendDeps,
  input: { category: number; picks: readonly PreferenceChannelBindingPick[] },
): number {
  if (!(input.category in PREFERENCE_CATEGORY_NAMES)) {
    throw new AppError('validation_error', '行业类目不在官方行业分类码表内。', 400);
  }
  if (input.picks.length === 0) {
    throw new AppError('validation_error', '未勾选任何渠道。', 400);
  }
  for (const pick of input.picks) {
    const name = pick.name.trim().replace(/\s+/g, ' ');
    if (name.length === 0 || Array.from(name).length > 200) {
      throw new AppError('validation_error', '渠道挂牌名不能为空且最长 200 字。', 400);
    }
    if (Array.from(pick.domain.trim()).length > 200) {
      throw new AppError('validation_error', '域名最长 200 字。', 400);
    }
    if (!Number.isInteger(pick.resourceId) || pick.resourceId <= 0) {
      throw new AppError('validation_error', '资源 id 无效。', 400);
    }
  }
  const nowIso = new Date(deps.now()).toISOString();
  return deps.db.transaction(() => {
    let added = 0;
    for (const pick of input.picks) {
      const duplicate = deps.db.get<{ id: string }>(
        'SELECT id FROM preference_channels WHERE category = ? AND kind = ? AND resource_id = ?',
        [input.category, pick.kind, pick.resourceId],
      );
      if (duplicate) continue;
      deps.db.run(
        'INSERT INTO preference_channels (id, category, name, domain, exact, kind, resource_id, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)',
        [
          randomUUID(),
          input.category,
          pick.name.trim().replace(/\s+/g, ' '),
          pick.domain.trim(),
          pick.kind,
          pick.resourceId,
          nowIso,
          nowIso,
        ],
      );
      added += 1;
    }
    return added;
  });
}

/** 行内编辑：只改行业（名称/资源不可改，要改就删了重选）。 */
export function updatePreferenceChannelCategory(
  deps: BackendDeps,
  id: string,
  category: number,
): void {
  if (!(category in PREFERENCE_CATEGORY_NAMES)) {
    throw new AppError('validation_error', '行业类目不在官方行业分类码表内。', 400);
  }
  const nowIso = new Date(deps.now()).toISOString();
  const changes = deps.db.run(
    'UPDATE preference_channels SET category = ?, updated_at = ? WHERE id = ?',
    [category, nowIso, id],
  ).changes;
  if (changes === 0) {
    throw new AppError('preference_channel_not_found', '该偏好名单条目不存在。', 404);
  }
}

export function deletePreferenceChannel(db: SqlClient, id: string): void {
  const changes = db.run('DELETE FROM preference_channels WHERE id = ?', [id]).changes;
  if (changes === 0) {
    throw new AppError('preference_channel_not_found', '该偏好名单条目不存在。', 404);
  }
}

/**
 * 名单核心名归一（桌面 channelNameCoreAll 的最小移植）：反复剥尾部（）/
 * 【】尾块后 lowercase。转售商挂牌名会漂移后缀（列举网 7 变体），下发前
 * 按核心名去重防止桌面面板出现两行命中同一家族（种子「博客园（GEO 优化
 * 首选…）」vs 运营手加「博客园」型）。
 */
function preferenceNameCore(name: string): string {
  let core = name.trim().toLowerCase();
  for (;;) {
    const stripped = core
      .replace(/[（(][^（）()]*[）)]\s*$/, '')
      .replace(/【[^【】]*】\s*$/, '')
      .trim();
    if (stripped === core || stripped.length === 0) break;
    core = stripped;
  }
  return core;
}

function preferenceChannelEntryOf(row: PreferenceChannelRow): PreferenceChannelEntry {
  return {
    name: row.name,
    ...(row.domain === '' ? {} : { domain: row.domain }),
    exact: row.exact === 1,
    ...(row.kind === '' || row.resource_id === null
      ? {}
      : { kind: row.kind, resourceId: row.resource_id }),
  };
}

/** 单次拉取的码集上限（官方词表 25 项 + 余量，防滥用面）。 */
export const MAX_PREFERENCE_CODES = 32;

/**
 * 按码集下发（回落语义，用户裁决 2026-09-08：行业名单是完整名单不是
 * 增量）：码集命中行业行 → 只发行业行（通用不并集）；码集无命中或空码集
 * → 回落只发通用行（category=0）。行业隔离在调用端点处完成——桌面端只
 * 传自己计划行业的码集，收不到其他行业行。
 *
 * 去重两遍收集：绑定行（kind/resource_id 在场）整体在前且互不去重——
 * 同核心名的两条绑定行是不同资源（媒体+自媒体同名号各算一家），但同名
 * 家族的**名称行**让位给绑定行（id 绑定更精确，且勾选落库却被名称行静默
 * 吞掉正是去重要防的无效写入；种子/手输名称行按原规则继续按核心名去重，
 * 前者优先）。名称行间顺序仍按 category 升序 → created_at。
 */
export function resolvePreferenceChannelsForCodes(
  db: SqlClient,
  codes: readonly number[],
): PreferenceChannelEntry[] {
  const unique = [...new Set(codes)].filter(code => Number.isInteger(code) && code > 0);
  if (unique.length > 0) {
    const industryRows = db.all<PreferenceChannelRow>(
      `SELECT ${SELECT_COLUMNS} FROM preference_channels WHERE category IN (${unique.map(() => '?').join(', ')}) ORDER BY category ASC, created_at ASC, id ASC`,
      unique,
    );
    if (industryRows.length > 0) return dedupePreferenceRows(industryRows);
  }
  const universalRows = db.all<PreferenceChannelRow>(
    `SELECT ${SELECT_COLUMNS} FROM preference_channels WHERE category = 0 ORDER BY category ASC, created_at ASC, id ASC`,
    [],
  );
  return dedupePreferenceRows(universalRows);
}

function dedupePreferenceRows(rows: readonly PreferenceChannelRow[]): PreferenceChannelEntry[] {
  const channels: PreferenceChannelEntry[] = [];
  const seenBoundRefs = new Set<string>();
  const boundCores = new Set<string>();
  const seenNameCores = new Set<string>();
  for (const row of rows) {
    if (row.kind === '' || row.resource_id === null) continue;
    const ref = `${row.kind}:${row.resource_id}`;
    if (seenBoundRefs.has(ref)) continue;
    seenBoundRefs.add(ref);
    channels.push(preferenceChannelEntryOf(row));
    const core = preferenceNameCore(row.name);
    if (core !== '') boundCores.add(core);
  }
  for (const row of rows) {
    if (row.kind !== '' && row.resource_id !== null) continue;
    const core = preferenceNameCore(row.name);
    if (core !== '' && (seenNameCores.has(core) || boundCores.has(core))) continue;
    if (core !== '') seenNameCores.add(core);
    channels.push(preferenceChannelEntryOf(row));
  }
  return channels;
}

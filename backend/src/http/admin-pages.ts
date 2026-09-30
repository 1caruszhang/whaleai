import { Hono } from 'hono';
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { BackendDeps } from '../deps';
import { verifyAdminToken } from '../auth/tokens';
import {
  addPreferenceChannel,
  addPreferenceChannelBindings,
  deletePreferenceChannel,
  listPreferenceChannels,
  updatePreferenceChannelCategory,
  PREFERENCE_CATEGORY_NAMES,
  type PreferenceChannelBindingPick,
  type PreferenceChannelRow,
} from '../domain/preference-channels';
import {
  listPoolSnapshotNames,
  poolRefKey,
  poolSnapshotByRefs,
  poolSnapshotStats,
  searchPoolSnapshot,
  verifyPoolSnapshotRefs,
  type PoolKind,
  type PoolSnapshotRow,
  type PoolSnapshotStats,
} from '../domain/distribution-pool-snapshot';
import { runDistributionPoolRefreshOnce } from '../domain/distribution-pool-scheduler';
import { DistributionUpstream } from '../gateway/distribution-upstream';
import {
  FANS_NUMBER_NAMES,
  MEDIA_CHANNEL_TYPE_NAMES,
  WE_MEDIA_PLATFORM_NAMES,
} from '../domain/pool-industry-match';
import { AppError } from '../errors';

/**
 * /admin 运营台 SSR 页（票 10 建、票 51 收敛）：账号运营台 SSR 面
 * （GET /admin 登录页/列表、GET /admin/accounts/:accountId 详情、
 * POST /admin/ui/accounts* 表单、POST /admin/session、POST /admin/logout）
 * 已于票 #51 整体退役，由 admin-web SPA + JSON API 承接（见 admin-spa.ts /
 * admin-routes.ts）。本文件现只保留偏好召回名单管理页（P3.x 生产功能，
 * spec #45 退役清单未点名、SPA 无对应页替代）：
 *
 * - GET /admin/preference-channels：单行业视图名单页（唯一例外保留内联
 *   onchange 即时提交，用户裁决 2026-09-08，见 preferenceChannelsHtml）；
 * - POST /admin/ui/preference-channels/*：校验名单、snapshot refresh/verify、
 *   pick/category/delete 生产表单，表单 POST + PRG 303。
 *
 * 会话凭证仍是 signAdminToken 的运营 JWT（audience=xiaojing-admin）进
 * HttpOnly;SameSite=Lax cookie——/admin/session 退役后，唯一入口是
 * POST /admin/login（JSON）：登录响应经 setAdminSessionCookie 直接写入该
 * cookie（SPA 登录与 SSR 页共用同一 cookie，见 admin-routes.ts）。页面门
 * requireAdminPage 无效/缺失即 303 直达 /admin/login（SPA 登录页），不裸
 * 401、不自渲染旧登录面。
 */

export const ADMIN_SESSION_COOKIE = 'xiaojing_admin';

/** 快照搜索结果上限（勾选确认同上限：表单一次最多 50 个勾）。 */
const POOL_SEARCH_RESULT_LIMIT = 50;

/**
 * 搜索框 datalist 预渲染候选上限（零客户端 JS 的输入提示）：头部候选
 * 之外的名字由「当前搜索结果」并入兜底——输入提示是辅助，完整检索仍靠
 * 回车/搜索按钮。
 */
const POOL_SUGGESTION_LIMIT = 500;

const POOL_KIND_LABELS: Record<string, string> = {
  media: '媒体',
  'we-media': '自媒体',
};

/** 表单/表格渲染统一转义：所有用户与运营输入回显必经此处（防 XSS）。 */
function esc(value: string | number | null | undefined): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function yuan(cents: number): string {
  return (cents / 100).toFixed(2);
}

const PAGE_STYLE = `
body{font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:0;background:#f4f6f8;color:#1c2733}
main{max-width:1080px;margin:0 auto;padding:24px}
.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}
h1{font-size:20px;margin:0}
h2{font-size:15px;margin:0 0 12px}
.card{background:#fff;border:1px solid #e3e8ee;border-radius:10px;padding:16px 20px;margin-bottom:20px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:6px 8px;border-bottom:1px solid #edf1f5;text-align:left;vertical-align:top;white-space:nowrap}
th{color:#5b6b7b;font-weight:600;background:#fafbfc}
td.wrap{white-space:normal;max-width:360px;word-break:break-all}
.pos{color:#0a7d33}.neg{color:#c0392b}
.warn{background:#fff7e6;border:1px solid #f5c26b;color:#8a5a00;border-radius:8px;padding:10px 14px;margin:0 0 12px}
.error{background:#fdecea;border:1px solid #f2b8b5;color:#8f1d17;border-radius:8px;padding:10px 14px;margin:0 0 12px}
.muted{color:#7b8a99;font-size:12px}
form.inline{display:inline;margin:0}
form.inline select{width:auto;margin-right:6px}
details{margin:0 0 8px}
summary{cursor:pointer;font-weight:600}
label{display:block;margin:10px 0 2px;font-size:13px;color:#3d4c5a}
input,select{width:240px;max-width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #cbd5e0;border-radius:6px;font:inherit}
input[type=checkbox]{width:auto;padding:0;margin-right:6px}
button{padding:6px 14px;border:0;border-radius:6px;background:#1f6feb;color:#fff;font:inherit;cursor:pointer;margin-top:10px}
button.secondary{background:#5b6b7b;margin-top:0}
a{color:#1f6feb}
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
${body}
</body>
</html>`;
}

function errorPageHtml(message: string, backHref: string): string {
  return page(
    '操作未完成',
    `<main>
  <div class="card" style="max-width:560px;margin:60px auto">
    <h1>操作未完成</h1>
    <p class="error">${esc(message)}</p>
    <p><a href="${esc(backHref)}">返回运营台</a></p>
  </div>
</main>`,
  );
}

/**
 * 页头（票 51）：/admin/logout 已随账号运营台 SSR 面退役，头里不再有
 * 退出表单——登出由 SPA 清 localStorage 凭证完成，本页 cookie 按 TTL
 * 自然过期。「账号」链接指向 /admin（SPA 登录页/仪表盘）。
 */
function headerHtml(): string {
  return `<header class="top">
  <h1>鲸杉geo · 运营台</h1>
  <div>
    <a href="/admin">账号</a> · <a href="/admin/preference-channels">偏好名单</a>
  </div>
</header>`;
}

/**
 * 偏好召回名单管理页（单行业视图）：顶部行业下拉即切换（GET ?industry=），
 * 名单常驻两张区——通用名单（恒展开，兜底）+ 各行业专属名单（原生
 * <details> 按类别折叠，当前查看的行业自动展开）；行业没有专属条目时明示
 * 该行业计划回落通用（下发语义，用户裁决 2026-09-08：码集命中行业行只发
 * 行业行，通用不并集）。
 * 添加只有一个动作：输入渠道名（datalist 候选与结果按当前行业过滤，规则
 * 与保底召回垂类匹配同一语义；可勾选「包含未分类」（u=1）把快照缺行业
 * 类目的渠道并入候选，消除回落语义下未分类资源进不了行业专属名单的操作
 * 死角，缺省不勾 = 现状行为）→ 精确命中预勾选 → 「确认添加到本行业」
 * （行业由当前视图以隐藏字段定死，不再出现第二个行业下拉）。行内可改
 * 行业/删除。除行业下拉的一个内联 onchange 即时提交（用户裁决
 * 2026-09-08：切行业立即联动候选，纯 HTML 无此机制，记为运营台零 JS
 * 纪律的唯一例外）外零客户端 JS：搜索 GET 渲染结果区，写操作
 * POST+PRG 303。
 */
function preferenceChannelsHtml(
  rows: PreferenceChannelRow[],
  stats: PoolSnapshotStats,
  snapshotByRef: Map<string, PoolSnapshotRow>,
  searchQuery: string,
  searchResults: PoolSnapshotRow[] | null,
  suggestions: readonly string[],
  industry: number,
  includeUnclassified: boolean,
): string {
  const industryLabel = `${industry} · ${PREFERENCE_CATEGORY_NAMES[industry] ?? ''}`;
  const addToLabel = industry === 0 ? '到通用名单' : `到 ${industryLabel}`;
  const industryRows = rows.filter(row => row.category === industry);
  const universalRows = rows.filter(row => row.category === 0);

  const listTable = (listRows: readonly PreferenceChannelRow[], emptyHint: string): string =>
    listRows.length === 0
      ? `<p class="muted">${esc(emptyHint)}</p>`
      : `<table>
    <thead><tr><th>渠道名</th><th>域名</th><th>形态</th><th>匹配方式</th><th>快照状态</th><th>添加时间</th><th>操作</th></tr></thead>
    <tbody>
${listRows.map(row => preferenceRowHtml(row, snapshotByRef, industry)).join('\n')}
    </tbody>
  </table>`;

  // 全部行业的名单常驻页面（用户裁决 2026-09-08）：通用名单恒展开；各行业
  // 专属名单用原生 <details> 按类别默认折叠、点击展开——零 JS 的折叠机制，
  // 当前查看的行业自动展开（切换行业后视线直接落在自家名单上）。
  const industryDetails = Object.entries(PREFERENCE_CATEGORY_NAMES)
    .filter(([rawCode]) => Number(rawCode) !== 0)
    .map(([rawCode, label]) => {
      const code = Number(rawCode);
      const sectionRows = rows.filter(row => row.category === code);
      if (sectionRows.length === 0) return null;
      return `<details${industry === code ? ' open' : ''}>
    <summary>${esc(code)} · ${esc(label)} 专属名单（${sectionRows.length} 条）</summary>
${listTable(sectionRows, '')}
  </details>`;
    })
    .filter(section => section !== null)
    .join('\n');
  const industrySectionCount = rows.filter(row => row.category !== 0).length;
  const listCards = `<section class="card">
  <h2>通用名单（${universalRows.length} 条，兜底：行业无专属名单的计划使用）</h2>
  ${listTable(universalRows, '通用名单为空：没有行业专属名单的计划将没有任何偏好渠道。')}
</section>
<section class="card">
  <h2>行业专属名单（${industrySectionCount} 条，点击行业展开）</h2>
  ${industryDetails || '<p class="muted">还没有任何行业专属名单——各行业的计划当前都只用通用名单（兜底）；给行业添加渠道后这里按行业折叠展示。</p>'}
</section>`;

  const snapshotTime =
    stats.fetchedAt === null
      ? '尚未拉取'
      : `${stats.fetchedAt.slice(0, 16).replace('T', ' ')}（媒体+自媒体共 ${esc(stats.rows)} 条）`;
  let searchArea = '';
  if (searchResults !== null) {
    if (stats.rows === 0) {
      searchArea = `  <p class="warn">池快照为空：请先点上方「刷新池快照」再搜索。</p>`;
    } else if (searchResults.length === 0) {
      const unclassifiedHint =
        industry !== 0 && !includeUnclassified ? '，或勾选「包含未分类」' : '';
      searchArea = `  <p class="muted">该行业候选内没有名称包含「${esc(searchQuery)}」的渠道；换个关键词${unclassifiedHint}，或把行业切到「0 · 通用」搜全池。</p>`;
    } else {
      // 名称与关键词完全一致的行预勾选：从 datalist 选中精确名回车后，
      // 意中的行已处于待确认状态，直接点确认（零 JS 下「下拉选中」无事件
      // 可挂，预勾选是最短的等价交互）。
      const exactHint =
        searchResults.some(result => result.name === searchQuery)
          ? `    <p class="muted">名称与关键词完全一致的行已预勾选。</p>\n`
          : '';
      const resultRows = searchResults
        .map(
          result => `    <tr>
      <td><input type="checkbox" name="pick:${esc(result.kind)}:${esc(result.resource_id)}"${result.name === searchQuery ? ' checked' : ''}></td>
      <td class="wrap">${esc(result.name)}</td>
      <td class="wrap">${poolIdentityHtml(result)}</td>
      <td>¥${esc(yuan(result.price_cents))}</td>
      <td>${poolStatusHtml(result)}</td>
      <td>${result.geo_count > 0 ? `GEO ×${esc(result.geo_count)}` : '<span class="muted">-</span>'}</td>
    </tr>`,
        )
        .join('\n');
      const industryHint =
        industry !== 0
          ? `  <p class="muted">候选已按「${esc(industry)} · ${esc(
              PREFERENCE_CATEGORY_NAMES[industry] ?? '',
            )}」过滤（自媒体按行业分类、媒体按频道类型映射；GEO 标记仅展示不入选${
              includeUnclassified ? '；已并入未分类渠道' : ''
            }）。</p>\n`
          : '';
      searchArea = `${industryHint}  <form method="post" action="/admin/ui/preference-channels/pick">
    <input type="hidden" name="category" value="${esc(industry)}">
    <input type="hidden" name="viewIndustry" value="${esc(industry)}">
${exactHint}    <table>
      <thead><tr><th>勾选</th><th>渠道名</th><th>形态</th><th>价格</th><th>在售状态</th><th>GEO</th></tr></thead>
      <tbody>
${resultRows}
      </tbody>
    </table>
    <button type="submit">确认添加${esc(addToLabel)}</button>
    <p class="muted">每勾一行落一条绑定条目（按资源 id 命中，挂牌名/域名取自快照）；结果最多显示 ${esc(POOL_SEARCH_RESULT_LIMIT)} 条。</p>
  </form>`;
    }
  }
  const suggestionOptions = suggestions
    .map(name => `    <option value="${esc(name)}"></option>`)
    .join('\n');
  return page(
    '偏好名单',
    `<main>
${headerHtml()}
<p><a href="/admin">返回账号列表</a></p>
<p class="muted">每个行业一份偏好名单：行业有专属名单时，该行业的计划只用专属名单；行业没有时才回落通用名单（品牌未填行业同）。改动即时生效（下次计划发现即用新名单）。绑定条目按资源 id 命中。</p>
<section class="card">
  <h2>资源池快照</h2>
  <p>池快照：${esc(snapshotTime)}</p>
  <form class="inline" method="post" action="/admin/ui/preference-channels/snapshot/refresh">
    <input type="hidden" name="viewIndustry" value="${esc(industry)}">
    <button type="submit">刷新池快照</button>
  </form>
  <form class="inline" method="post" action="/admin/ui/preference-channels/snapshot/verify">
    <input type="hidden" name="viewIndustry" value="${esc(industry)}">
    <button type="submit">校验名单</button>
  </form>
  <p class="muted">「刷新池快照」从上游全量拉取媒体+自媒体资源（约 2.5 万条，约 1 分钟，期间请勿关闭页面）；「校验名单」只回源批查名单绑定行（200 条/批，几秒），刷新其名称/价格/在售状态，上游已除名的行从快照删除（名单页显示「快照缺失」）。搜索与勾选都只打本地快照。</p>
</section>
<section class="card">
  <h2>添加渠道${esc(addToLabel)}</h2>${industry !== 0 && industryRows.length === 0 ? `\n  <p class="muted">该行业还没有专属条目——此行业的计划当前使用通用名单（兜底）。</p>` : ''}
  <datalist id="poolNameSuggestions">
${suggestionOptions}
  </datalist>
  <form method="get" action="/admin/preference-channels">
    <label for="qIndustry">当前行业（切换视图与候选过滤；0·通用 = 通用名单与全池候选）</label>
    <select id="qIndustry" name="industry" onchange="this.form.submit()">
${categoryOptionsHtml(industry)}
    </select>
    <label for="q">渠道名（输入时有候选提示；候选与结果按当前行业过滤）</label>
    <input id="q" name="q" maxlength="100" list="poolNameSuggestions" value="${esc(searchQuery)}" placeholder="如：蓝色河畔">
    <label><input type="checkbox" name="u" value="1"${includeUnclassified ? ' checked' : ''}>包含未分类（快照缺行业类目的渠道也进候选）</label>
    <button type="submit">搜索</button>
  </form>
  <p class="muted">切换行业后页面立即刷新，输入提示与搜索结果随之切换到该行业；从候选中选中完整名称后回车，命中的行已预勾选，点「确认添加」即完成。候选只含本行业渠道（自媒体按行业分类、媒体按频道类型映射；GEO 标记仅展示不入选），无行业类目的渠道默认不在候选内——勾选「包含未分类」可并入（营销专区套餐类仍排除）；要全池挑选请把行业切到「0 · 通用」。</p>
${searchArea}
</section>
${listCards}
</main>`,
  );
}

function preferenceRowHtml(
  row: PreferenceChannelRow,
  snapshotByRef: Map<string, PoolSnapshotRow>,
  viewIndustry: number,
): string {
  const snapshot =
    row.kind === '' || row.resource_id === null
      ? undefined
      : snapshotByRef.get(poolRefKey(row.kind, row.resource_id));
  const kindLabel = row.kind === '' ? '名称条目' : (POOL_KIND_LABELS[row.kind] ?? row.kind);
  const matchLabel = row.kind === '' ? (row.exact === 1 ? '精确' : '严格/模糊') : '按 id 绑定';
  const statusCell = row.kind === '' ? '<span class="muted">-</span>' : poolStatusHtml(snapshot);
  // 同名跨平台的绑定行加平台后缀（灰显，仅展示——下发名仍是快照挂牌名）。
  const platformSuffix =
    snapshot?.platform != null && snapshot.platform in WE_MEDIA_PLATFORM_NAMES
      ? ` <span class="muted">（${esc(WE_MEDIA_PLATFORM_NAMES[snapshot.platform]!)}）</span>`
      : '';
  return `    <tr>
      <td class="wrap">${esc(row.name)}${platformSuffix}</td>
      <td class="wrap">${row.domain === '' ? '<span class="muted">-</span>' : esc(row.domain)}</td>
      <td>${esc(kindLabel)}</td>
      <td>${esc(matchLabel)}</td>
      <td>${statusCell}</td>
      <td>${esc(row.created_at)}</td>
      <td>
        <form class="inline" method="post" action="/admin/ui/preference-channels/${encodeURIComponent(row.id)}/category">
          <select name="category" aria-label="改行业">
${categoryOptionsHtml(row.category)}
          </select>
          <button class="secondary" type="submit">改行业</button>
        </form>
        <form class="inline" method="post" action="/admin/ui/preference-channels/${encodeURIComponent(row.id)}/delete">
          <input type="hidden" name="viewIndustry" value="${esc(viewIndustry)}">
          <button class="secondary" type="submit">删除</button>
        </form>
      </td>
    </tr>`;
}

/** 池快照在售状态格：2=已通过（在售）；其余状态按未上架标红；无快照行灰提示。 */
function poolStatusHtml(snapshot: PoolSnapshotRow | undefined): string {
  if (!snapshot) return '<span class="muted">快照缺失</span>';
  if (snapshot.status === 2) return '在售';
  if (snapshot.status === null) return '<span class="muted">状态未知</span>';
  return '<span class="neg">已下架</span>';
}

/**
 * 搜索结果行的辨识信息：形态 + 平台·粉丝档（自媒体）或频道类型（媒体）。
 * 同名号跨平台是不同资源（转售商把同一名字按头条号/百家号/搜狐号分别
 * 挂牌），只显示名称无法分辨勾的是哪一条。
 */
function poolIdentityHtml(row: PoolSnapshotRow): string {
  const kind = POOL_KIND_LABELS[row.kind] ?? row.kind;
  if (row.kind === 'we-media') {
    const parts = [kind];
    if (row.platform !== null && row.platform in WE_MEDIA_PLATFORM_NAMES) {
      parts.push(WE_MEDIA_PLATFORM_NAMES[row.platform]!);
    }
    if (row.fans_number !== null && row.fans_number in FANS_NUMBER_NAMES) {
      parts.push(FANS_NUMBER_NAMES[row.fans_number]!);
    }
    return esc(parts.join(' · '));
  }
  if (row.category_code !== null && row.category_code in MEDIA_CHANNEL_TYPE_NAMES) {
    return esc(`${kind} · ${MEDIA_CHANNEL_TYPE_NAMES[row.category_code]!}`);
  }
  return esc(kind);
}

function categoryOptionsHtml(selected: number): string {
  return Object.entries(PREFERENCE_CATEGORY_NAMES)
    .map(
      ([code, label]) =>
        `      <option value="${esc(code)}"${Number(code) === selected ? ' selected' : ''}>${esc(code)} · ${esc(label)}</option>`,
    )
    .join('\n');
}

// ── 表单校验（字符串入参）───────────────────────────────────────────

/** 偏好名单条目：category 走码白名单（domain 层再校验），checkbox 缺省=未勾选。 */
const preferenceChannelFormSchema = z.object({
  category: z.string().trim().regex(/^\d{1,3}$/, '行业类目无效。'),
  name: z.string().trim().min(1, '渠道名不能为空。').max(200, '渠道名最长 200 字。'),
  domain: z.string().trim().max(200, '域名最长 200 字。'),
  exact: z.string().optional(),
});

const preferenceChannelIdParamSchema = z.string().min(1, '条目 id 不能为空').max(64);

/** 行内改行业表单（只允许改 category，名称/资源不可改）。 */
const preferenceChannelCategoryFormSchema = z.object({
  category: z.string().trim().regex(/^\d{1,3}$/, '行业类目无效。'),
});

/** 勾选确认表单：category 走码白名单；pick:* 勾选键单独解析（zod 默认剥未知键）。 */
const preferencePickFormSchema = z.object({
  category: z.string().trim().regex(/^\d{1,3}$/, '行业类目无效。'),
});

/** 勾选键形态：pick:<kind>:<resource_id>，checkbox 勾选值恒为 'on'。 */
const PREFERENCE_PICK_KEY_PATTERN = /^pick:(media|we-media):(\d{1,10})$/;

function parsePreferencePicks(form: Record<string, string>): { kind: PoolKind; resourceId: number }[] {
  const picks: { kind: PoolKind; resourceId: number }[] = [];
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(form)) {
    if (!key.startsWith('pick:')) continue;
    const match = PREFERENCE_PICK_KEY_PATTERN.exec(key);
    if (!match || value !== 'on') {
      throw new AppError('validation_error', '勾选项无效。', 400);
    }
    const kind = match[1] as PoolKind;
    const resourceId = Number.parseInt(match[2], 10);
    const ref = poolRefKey(kind, resourceId);
    if (seen.has(ref)) continue;
    seen.add(ref);
    picks.push({ kind, resourceId });
  }
  return picks;
}

/** 表单解析：application/x-www-form-urlencoded 的纯文本字段（文件字段拒绝）。 */
async function parseFormBody(c: {
  req: { parseBody(): Promise<Record<string, string | File>> };
}): Promise<Record<string, string>> {
  let raw: Record<string, string | File>;
  try {
    raw = await c.req.parseBody();
  } catch {
    throw new AppError('invalid_form', '表单正文无效。', 400);
  }
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') {
      throw new AppError('validation_error', `表单字段 ${key} 必须是文本。`, 400);
    }
    fields[key] = value;
  }
  return fields;
}

/** PRG 回跳目标：指向行业视图（0=默认通用视图）。 */
function preferenceViewHref(industry: number): string {
  return industry === 0
    ? '/admin/preference-channels'
    : `/admin/preference-channels?industry=${industry}`;
}

/** 表单携带的当前视图行业（改行业/删除/确认/刷新后跳回原视图）；非法值回落 0。 */
function parseViewIndustry(form: Record<string, string>): number {
  const raw = form.viewIndustry;
  if (raw === undefined || !/^\d{1,3}$/.test(raw)) return 0;
  const value = Number.parseInt(raw, 10);
  return value in PREFERENCE_CATEGORY_NAMES ? value : 0;
}

/**
 * 会话 cookie 下发（票 51 桥接）：/admin/session 退役后，运营 JWT 进 SSR
 * 会话 cookie 的唯一入口是 POST /admin/login（JSON）——登录响应直接写入
 * 该 cookie。SPA 登录即获得 cookie，随后访问偏好名单页（唯一保留的 SSR
 * 面）页面门即通过；cookie 有效期与 adminToken 相同、自然过期（SPA 登出
 * 只清 localStorage，SSR cookie 按 TTL 失效）。选项与票 10 的 /admin/session
 * 完全一致：HttpOnly;SameSite=Lax 挡跨站表单 POST（CSRF 主要面）；反代
 * TLS 终止后内网 hop 是 http，仅当本 hop 即 https 时加 Secure。
 */
export function setAdminSessionCookie(c: Context, token: string, ttlSeconds: number): void {
  setCookie(c, ADMIN_SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: ttlSeconds,
    secure: c.req.url.startsWith('https:'),
  });
}

export function createAdminPageRoutes(deps: BackendDeps) {
  const routes = new Hono();
  const config = deps.config;
  const upstream = new DistributionUpstream(deps, deps.fetchImpl ?? fetch);

  const hasValidSession = async (c: Context): Promise<boolean> => {
    const token = getCookie(c, ADMIN_SESSION_COOKIE);
    if (!token) return false;
    return (await verifyAdminToken(config.authSecret, token, deps.now())).ok;
  };

  /** 页面会话门：无效/缺失即 303 直达 SPA 登录页（覆盖 GET 页面与全部表单 POST）。 */
  const requireAdminPage = createMiddleware(async (c, next) => {
    if (!(await hasValidSession(c))) {
      return c.redirect('/admin/login', 303);
    }
    await next();
  });

  const htmlError = (
    c: Context,
    message: string,
    backHref: string,
    status: number,
  ): Response | Promise<Response> =>
    c.html(errorPageHtml(message, backHref), status as ContentfulStatusCode);

  routes.get('/admin/preference-channels', requireAdminPage, c => {
    const backHref = '/admin/preference-channels';
    const searchQuery = (c.req.query('q') ?? '').trim();
    if (Array.from(searchQuery).length > 100) {
      return htmlError(c, '搜索关键词最长 100 字。', backHref, 400);
    }
    const industryRaw = (c.req.query('industry') ?? '0').trim();
    if (!/^\d{1,3}$/.test(industryRaw) || !(Number(industryRaw) in PREFERENCE_CATEGORY_NAMES)) {
      return htmlError(c, '行业类目无效。', backHref, 400);
    }
    const industry = Number.parseInt(industryRaw, 10);
    // 「包含未分类」开关（u=1）：勾选时行业候选并入无类目渠道，消除
    // 回落语义下未分类资源进不了行业专属名单的操作死角；缺省 = 现状行为。
    const includeUnclassified = (c.req.query('u') ?? '') === '1';
    const rows = listPreferenceChannels(deps.db);
    const boundRefs = rows
      .filter(row => row.kind !== '' && row.resource_id !== null)
      .map(row => ({ kind: row.kind, resourceId: row.resource_id as number }));
    const snapshotByRef = poolSnapshotByRefs(deps.db, boundRefs);
    const stats = poolSnapshotStats(deps.db);
    const searchResults =
      searchQuery === ''
        ? null
        : searchPoolSnapshot(deps.db, searchQuery, POOL_SEARCH_RESULT_LIMIT, industry, includeUnclassified);
    // datalist 候选：头部不重名候选 + 当前搜索结果名（覆盖头部之外命中）。
    const suggestions = listPoolSnapshotNames(deps.db, POOL_SUGGESTION_LIMIT, industry, includeUnclassified);
    if (searchResults !== null) {
      const seen = new Set(suggestions);
      for (const result of searchResults) {
        if (result.name === '' || seen.has(result.name)) continue;
        seen.add(result.name);
        suggestions.push(result.name);
      }
    }
    return c.html(
      preferenceChannelsHtml(
        rows,
        stats,
        snapshotByRef,
        searchQuery,
        searchResults,
        suggestions,
        industry,
        includeUnclassified,
      ),
    );
  });

  routes.post('/admin/ui/preference-channels', requireAdminPage, async c => {
    const backHref = '/admin/preference-channels';
    try {
      const form = await parseFormBody(c);
      const parsed = preferenceChannelFormSchema.safeParse(form);
      if (!parsed.success) {
        return htmlError(c, parsed.error.issues[0]?.message ?? '表单参数无效。', backHref, 400);
      }
      addPreferenceChannel(deps, {
        category: Number.parseInt(parsed.data.category, 10),
        name: parsed.data.name,
        domain: parsed.data.domain,
        exact: parsed.data.exact === 'on',
      });
      return c.redirect(backHref, 303);
    } catch (error) {
      if (error instanceof AppError) return htmlError(c, error.message, backHref, error.status);
      throw error;
    }
  });

  routes.post('/admin/ui/preference-channels/pick', requireAdminPage, async c => {
    const backHref = '/admin/preference-channels';
    try {
      const form = await parseFormBody(c);
      const parsed = preferencePickFormSchema.safeParse(form);
      if (!parsed.success) {
        return htmlError(c, parsed.error.issues[0]?.message ?? '表单参数无效。', backHref, 400);
      }
      const picks = parsePreferencePicks(form);
      if (picks.length === 0) {
        return htmlError(c, '请先勾选要添加的渠道。', backHref, 400);
      }
      if (picks.length > POOL_SEARCH_RESULT_LIMIT) {
        return htmlError(c, `一次最多添加 ${POOL_SEARCH_RESULT_LIMIT} 条勾选。`, backHref, 400);
      }
      // 勾选引用必须全部落在当前快照内（name/domain 取快照上游权威值，
      // 不取表单回传）；快照已刷新导致引用失效则整批拒绝零写入。
      const snapshotByRef = poolSnapshotByRefs(deps.db, picks);
      const resolved: PreferenceChannelBindingPick[] = [];
      for (const pick of picks) {
        const snapshot = snapshotByRef.get(poolRefKey(pick.kind, pick.resourceId));
        if (!snapshot) {
          return htmlError(
            c,
            '勾选的渠道不在池快照内（快照可能已刷新），请返回重新搜索勾选。',
            backHref,
            400,
          );
        }
        resolved.push({
          kind: pick.kind,
          resourceId: pick.resourceId,
          name: snapshot.name,
          domain: snapshot.domain,
        });
      }
      addPreferenceChannelBindings(deps, {
        category: Number.parseInt(parsed.data.category, 10),
        picks: resolved,
      });
      return c.redirect(preferenceViewHref(parseViewIndustry(form)), 303);
    } catch (error) {
      if (error instanceof AppError) return htmlError(c, error.message, backHref, error.status);
      throw error;
    }
  });

  routes.post('/admin/ui/preference-channels/:id/category', requireAdminPage, async c => {
    const backHref = '/admin/preference-channels';
    try {
      const id = preferenceChannelIdParamSchema.safeParse(c.req.param('id'));
      if (!id.success) {
        return htmlError(c, '条目 id 无效。', backHref, 404);
      }
      const form = await parseFormBody(c);
      const parsed = preferenceChannelCategoryFormSchema.safeParse(form);
      if (!parsed.success) {
        return htmlError(c, parsed.error.issues[0]?.message ?? '表单参数无效。', backHref, 400);
      }
      const newCategory = Number.parseInt(parsed.data.category, 10);
      updatePreferenceChannelCategory(deps, id.data, newCategory);
      // 改行业后落到目标行业视图——行出现在哪里，操作者就看到哪里。
      return c.redirect(preferenceViewHref(newCategory), 303);
    } catch (error) {
      if (error instanceof AppError) return htmlError(c, error.message, backHref, error.status);
      throw error;
    }
  });

  routes.post('/admin/ui/preference-channels/snapshot/refresh', requireAdminPage, async c => {
    const backHref = '/admin/preference-channels';
    try {
      const form = await parseFormBody(c);
      // 互斥出口（与 P3.3 定时刷新共享）：任一方在跑，本次立即忙返回。
      const outcome = await runDistributionPoolRefreshOnce(deps);
      if (!outcome.ran) {
        return htmlError(c, '池快照刷新正在进行中（定时任务或另一窗口），请稍后再试。', backHref, 409);
      }
      return c.redirect(preferenceViewHref(parseViewIndustry(form)), 303);
    } catch (error) {
      if (error instanceof AppError) return htmlError(c, error.message, backHref, error.status);
      throw error;
    }
  });

  routes.post('/admin/ui/preference-channels/snapshot/verify', requireAdminPage, async c => {
    const backHref = '/admin/preference-channels';
    try {
      const form = await parseFormBody(c);
      // 全表绑定行 (kind,id) 去重后分批批查（名称条目无引用，天然不参与）。
      const refs = listPreferenceChannels(deps.db)
        .filter(
          (row): row is PreferenceChannelRow & { kind: PoolKind; resource_id: number } =>
            (row.kind === 'media' || row.kind === 'we-media') &&
            row.resource_id !== null &&
            Number.isInteger(row.resource_id),
        )
        .map(row => ({ kind: row.kind, resourceId: row.resource_id }));
      await verifyPoolSnapshotRefs(deps, refs, async (kind, ids) => {
        const result = await upstream.queryResources(kind, ids);
        return result.ok
          ? result.data.map(item => ({
              resourceId: item.id,
              name: item.name,
              priceCents: item.priceCents,
              status: item.status,
            }))
          : null;
      });
      return c.redirect(preferenceViewHref(parseViewIndustry(form)), 303);
    } catch (error) {
      if (error instanceof AppError) return htmlError(c, error.message, backHref, error.status);
      throw error;
    }
  });

  routes.post('/admin/ui/preference-channels/:id/delete', requireAdminPage, async c => {
    const backHref = '/admin/preference-channels';
    try {
      const id = preferenceChannelIdParamSchema.safeParse(c.req.param('id'));
      if (!id.success) {
        return htmlError(c, '条目 id 无效。', backHref, 404);
      }
      const form = await parseFormBody(c);
      deletePreferenceChannel(deps.db, id.data);
      return c.redirect(preferenceViewHref(parseViewIndustry(form)), 303);
    } catch (error) {
      if (error instanceof AppError) return htmlError(c, error.message, backHref, error.status);
      throw error;
    }
  });

  return routes;
}

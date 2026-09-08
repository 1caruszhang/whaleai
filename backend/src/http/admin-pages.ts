import { Hono } from 'hono';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { BackendDeps } from '../deps';
import type { AdminLoginThrottle } from '../auth/admin-login-throttle';
import { timingSafeStringEqual } from '../auth/passwords';
import { signAdminToken, verifyAdminToken } from '../auth/tokens';
import {
  adminResetAccountPassword,
  createAccountWithGrant,
  findAccountById,
  listAccounts,
  setAccountNote,
  setAccountStatus,
} from '../domain/accounts';
import { applyAccountLedgerDelta, balanceSnapshot, listLedgerEntries } from '../domain/ledger';
import { listPermitHistory } from '../domain/permits';
import { listPublishOrdersForAccount } from '../domain/publish-orders';
import { listChatUsageRecords } from '../domain/chat-usage';
import { listProviderUsageRecords } from '../domain/provider-usage';
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
  refreshDistributionPoolSnapshot,
  searchPoolSnapshot,
  type PoolKind,
  type PoolSnapshotRow,
  type PoolSnapshotStats,
} from '../domain/distribution-pool-snapshot';
import { DistributionUpstream } from '../gateway/distribution-upstream';
import type { UpstreamCallResult } from '../gateway/distribution-upstream';
import { AppError } from '../errors';
import { phoneSchema } from './schemas';

/**
 * /admin 运营台 SSR 页面（票 10）：与既有 JSON API（admin-routes.ts，Bearer
 * token + /admin/login、/admin/accounts、/admin/ledger/*）并存——页面 GET 挂
 * /admin 与 /admin/accounts/:accountId，表单动作统一挂 /admin/ui/*，路径与
 * JSON API 不重合、边界清晰（现状最小扰动）。
 *
 * 形态取舍：纯服务端渲染（模板字符串 + esc() 转义 helper，零新依赖、
 * 不引入前端构建链）；写操作走表单 POST + 303 See Other（PRG），
 * 刷新/回退不重放。客户端 JS 仅一处内联例外：偏好名单页行业下拉的
 * onchange 即时提交（用户裁决 2026-09-08，详见 preferenceChannelsHtml
 * 注释）。会话凭证复用 signAdminToken 的运营 JWT（audience=
 * xiaojing-admin）放 HttpOnly;SameSite=Lax cookie——无服务端会话表、天然
 * 过期；SameSite=Lax 挡住跨站表单 POST（CSRF 主要面）。运营密码错误经共享
 * AdminLoginThrottle 递增延时（与 JSON 登录同一实例）。
 */

const ADMIN_SESSION_COOKIE = 'xiaojing_admin';

/** 池快照拉取：上游单页上限 200；页间 sleep 限速（全池 ~125 页/两类）。 */
const POOL_SNAPSHOT_PAGE_SIZE = 200;
const POOL_SNAPSHOT_PAGE_DELAY_MS = 120;

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

function loginPageHtml(errorMessage?: string): string {
  return page(
    '运营登录',
    `<main>
  <div class="card" style="max-width:420px;margin:60px auto">
    <h1>鲸杉geo · 运营台</h1>
    ${errorMessage ? `<p class="error">${esc(errorMessage)}</p>` : ''}
    <form method="post" action="/admin/session">
      <label for="password">运营密码</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button type="submit">登录</button>
    </form>
  </div>
</main>`,
  );
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

function headerHtml(): string {
  return `<header class="top">
  <h1>鲸杉geo · 运营台</h1>
  <div>
    <a href="/admin">账号</a> · <a href="/admin/preference-channels">偏好名单</a>
    <form class="inline" method="post" action="/admin/logout" style="margin-left:12px">
      <button class="secondary" type="submit">退出登录</button>
    </form>
  </div>
</header>`;
}

/** 媒介池余额卡：实测值 / 低余额提醒 / 上游失败降级，阈值比较纯服务端。 */
function mediaPoolCardHtml(
  profile: UpstreamCallResult<{ balanceCents: number }>,
  lowBalanceCents: number,
): string {
  if (!profile.ok) {
    return `<section class="card">
  <h2>超级媒介资金池</h2>
  <p class="muted">余额获取失败：上游暂不可用，请稍后刷新重试；账号管理不受影响。</p>
</section>`;
  }
  const low = profile.data.balanceCents < lowBalanceCents;
  return `<section class="card">
  <h2>超级媒介资金池</h2>
  <p>当前余额：<strong>¥${esc(yuan(profile.data.balanceCents))}</strong></p>
  ${low ? `<p class="warn">媒介池余额低于 ¥${esc(yuan(lowBalanceCents))}，请及时预存资金池。</p>` : ''}
</section>`;
}

const LEDGER_KIND_LABELS: Record<string, string> = {
  grant: '开通赠送',
  topup: '充值',
  adjust: '调整',
  consume: '扣点',
  refund: '退款',
};

function ledgerKindLabel(kind: string): string {
  return LEDGER_KIND_LABELS[kind] ?? kind;
}

function deltaHtml(delta: number): string {
  const sign = delta > 0 ? '+' : '';
  return `<span class="${delta >= 0 ? 'pos' : 'neg'}">${sign}${esc(delta)}</span>`;
}

function dashboardHtml(
  accounts: ReturnType<typeof listAccounts>,
  poolCard: string,
  signupGrantPoints: number,
): string {
  const rows = accounts
    .map(account => {
      const actionLabel = account.status === 'active' ? '停用' : '启用';
      const nextStatus = account.status === 'active' ? 'disabled' : 'active';
      return `    <tr>
      <td>${esc(account.phone)}</td>
      <td class="wrap">${
        account.adminNote === '' ? '<span class="muted">-</span>' : esc(account.adminNote)
      }</td>
      <td>${account.status === 'active' ? '正常' : '<span class="neg">已停用</span>'}</td>
      <td>${esc(account.balance)}</td>
      <td>${account.mustChangePassword ? '是' : '否'}</td>
      <td>${esc(account.createdAt)}</td>
      <td><a href="/admin/accounts/${encodeURIComponent(account.id)}">流水 / 操作</a></td>
      <td>
        <form class="inline" method="post" action="/admin/ui/accounts/${encodeURIComponent(account.id)}/status">
          <input type="hidden" name="status" value="${esc(nextStatus)}">
          <button class="secondary" type="submit">${actionLabel}</button>
        </form>
      </td>
    </tr>`;
    })
    .join('\n');
  const table =
    accounts.length === 0
      ? '<p class="muted">还没有账号，用下方表单开通第一个。</p>'
      : `<table>
  <thead><tr><th>手机号</th><th>备注</th><th>状态</th><th>余额（点）</th><th>待改密</th><th>建号时间</th><th>流水</th><th>操作</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>`;
  return page(
    '运营台',
    `<main>
${headerHtml()}
${poolCard}
<section class="card">
  <h2>账号</h2>
  ${table}
</section>
<section class="card">
  <h2>建号（开通即赠 ${esc(signupGrantPoints)} 点）</h2>
  <form method="post" action="/admin/ui/accounts">
    <label for="phone">手机号</label>
    <input id="phone" name="phone" inputmode="numeric" required>
    <label for="initialPassword">初始密码（至少 8 位，首登强制改密）</label>
    <input id="initialPassword" name="initialPassword" type="password" autocomplete="new-password" minlength="8" required>
    <button type="submit">开通账号</button>
  </form>
</section>
</main>`,
  );
}

function accountDetailHtml(deps: BackendDeps, accountId: string): string {
  const account = findAccountById(deps.db, accountId);
  if (!account) throw new AppError('account_not_found', '账号不存在。', 404);
  const balance = balanceSnapshot(deps.db, account);
  const ledger = listLedgerEntries(deps.db, accountId, 200);
  const permits = listPermitHistory(deps, accountId, 50);
  const orders = listPublishOrdersForAccount(deps.db, accountId, 50);
  const providerUsage = listProviderUsageRecords(deps.db, accountId, 50);
  const chatUsage = listChatUsageRecords(deps.db, accountId, 50);

  const ledgerRows = ledger
    .map(
      entry => `    <tr>
      <td>${esc(entry.created_at)}</td>
      <td>${esc(ledgerKindLabel(entry.kind))}</td>
      <td>${deltaHtml(entry.delta)}</td>
      <td>${esc(entry.balance_after)}</td>
      <td class="wrap">${esc(entry.note)}</td>
    </tr>`,
    )
    .join('\n');
  const permitRows = permits
    .map(
      permit => `    <tr>
      <td>${esc(permit.createdAt)}</td>
      <td>${esc(permit.operation)}</td>
      <td>${esc(permit.units)}</td>
      <td>${esc(permit.unitPrice)}${permit.basePrice > 0 ? ` + 基础 ${esc(permit.basePrice)}` : ''}</td>
      <td>${esc(permit.totalPoints)}</td>
      <td>${permit.status === 'open' ? '进行中' : '已结清'}</td>
      <td>${esc(permit.consumedPoints)} / ${esc(permit.refundedPoints)}</td>
    </tr>`,
    )
    .join('\n');
  const orderRows = orders
    .map(
      order => `    <tr>
      <td>${esc(order.sn)}</td>
      <td>${esc(order.kind)}</td>
      <td>${esc(order.points)}</td>
      <td>${esc(order.placement_status)}</td>
      <td>${esc(order.ledger_status)}</td>
      <td>${order.upstream_status === null ? '-' : esc(order.upstream_status)}</td>
      <td>${order.url === null ? '-' : `<a href="${esc(order.url)}" rel="noreferrer noopener">链接</a>`}</td>
      <td>${esc(order.created_at)}</td>
    </tr>`,
    )
    .join('\n');
  const providerRows = providerUsage
    .map(
      record => `    <tr>
      <td>${esc(record.created_at)}</td>
      <td>${esc(record.provider)}</td>
      <td>${esc(record.route)}</td>
      <td>${esc(record.input_tokens)}</td>
      <td>${esc(record.output_tokens)}</td>
    </tr>`,
    )
    .join('\n');
  const chatRows = chatUsage
    .map(
      record => `    <tr>
      <td>${esc(record.createdAt)}</td>
      <td>${esc(record.model)}</td>
      <td>${esc(record.inputTokens)}</td>
      <td>${esc(record.cacheReadTokens)}</td>
      <td>${esc(record.outputTokens)}</td>
      <td>${esc(record.pointsMilli)}</td>
    </tr>`,
    )
    .join('\n');
  const emptyRow = (columns: number, hint: string) =>
    `    <tr><td colspan="${columns}" class="muted">${esc(hint)}</td></tr>`;

  return page(
    `账号 ${account.phone}`,
    `<main>
${headerHtml()}
<p><a href="/admin">返回账号列表</a></p>
<section class="card">
  <h2>账号 ${esc(account.phone)}（${account.status === 'active' ? '正常' : '已停用'}）</h2>
  <p>总余额 <strong>${esc(balance.total)}</strong> 点 · 可用 ${esc(balance.available)} 点 · 冻结 ${esc(balance.frozen)} 点（1 元 = 10 点）</p>
</section>
<section class="card">
  <h2>充值对账确认</h2>
  <form method="post" action="/admin/ui/accounts/${encodeURIComponent(account.id)}/topup">
    <label for="amountYuan">充值金额（元，1 元 = 10 点）</label>
    <input id="amountYuan" name="amountYuan" inputmode="decimal" placeholder="如 200" required>
    <label for="topupNote">来源备注（对公转账截图 / 流水说明）</label>
    <input id="topupNote" name="note" maxlength="500" required>
    <button type="submit">确认入账</button>
  </form>
</section>
<section class="card">
  <h2>调整点数</h2>
  <form method="post" action="/admin/ui/accounts/${encodeURIComponent(account.id)}/adjust">
    <label for="delta">调整点数（正负整数，负数只动可用余额）</label>
    <input id="delta" name="delta" placeholder="如 50 或 -50" required>
    <label for="adjustNote">备注（必填，落流水）</label>
    <input id="adjustNote" name="note" maxlength="500" required>
    <button type="submit">确认调整</button>
  </form>
</section>
<section class="card">
  <h2>账号备注</h2>
  <form method="post" action="/admin/ui/accounts/${encodeURIComponent(account.id)}/note">
    <label for="adminNote">运营内部标识（这是谁的号，最长 500 字；留空保存即清除）</label>
    <input id="adminNote" name="note" maxlength="500" value="${esc(account.admin_note)}">
    <button type="submit">保存备注</button>
  </form>
</section>
<section class="card">
  <h2>重置密码</h2>
  <form method="post" action="/admin/ui/accounts/${encodeURIComponent(account.id)}/reset-password">
    <label for="newPassword">新密码（至少 8 位）</label>
    <input id="newPassword" name="newPassword" type="password" autocomplete="new-password" minlength="8" required>
    <label for="confirmPassword">确认新密码</label>
    <input id="confirmPassword" name="confirmPassword" type="password" autocomplete="new-password" minlength="8" required>
    <button type="submit">重置密码</button>
  </form>
  <p class="muted">重置后该账号全部登录立即失效，用户须用新密码重新登录，且首次登录会被要求改成自己的密码。</p>
</section>
<section class="card">
  <h2>点数流水</h2>
  <table>
    <thead><tr><th>时间</th><th>类型</th><th>变动</th><th>余额</th><th>备注</th></tr></thead>
    <tbody>
${ledgerRows || emptyRow(5, '暂无流水')}
    </tbody>
  </table>
</section>
<section class="card">
  <h2>计费操作（permit）</h2>
  <table>
    <thead><tr><th>时间</th><th>操作</th><th>单位</th><th>单价</th><th>总额</th><th>状态</th><th>已扣 / 已退</th></tr></thead>
    <tbody>
${permitRows || emptyRow(7, '暂无计费操作')}
    </tbody>
  </table>
</section>
<section class="card">
  <h2>发布订单</h2>
  <table>
    <thead><tr><th>sn</th><th>类型</th><th>点数</th><th>下单</th><th>账本</th><th>上游状态</th><th>链接</th><th>创建时间</th></tr></thead>
    <tbody>
${orderRows || emptyRow(8, '暂无发布订单')}
    </tbody>
  </table>
</section>
<section class="card">
  <h2>Provider 计量（对账用）</h2>
  <table>
    <thead><tr><th>时间</th><th>Provider</th><th>路由</th><th>输入 token</th><th>输出 token</th></tr></thead>
    <tbody>
${providerRows || emptyRow(5, '暂无计量记录')}
    </tbody>
  </table>
</section>
<section class="card">
  <h2>对话计量（隐藏额度口径，千分之一点）</h2>
  <table>
    <thead><tr><th>时间</th><th>模型</th><th>输入</th><th>缓存读</th><th>输出</th><th>折点（千分点）</th></tr></thead>
    <tbody>
${chatRows || emptyRow(6, '暂无对话计量')}
    </tbody>
  </table>
</section>
</main>`,
  );
}

/**
 * 偏好召回名单管理页（单行业视图）：顶部行业下拉即切换（GET ?industry=），
 * 名单常驻两张区——通用名单（恒展开，兜底）+ 各行业专属名单（原生
 * <details> 按类别折叠，当前查看的行业自动展开）；行业没有专属条目时明示
 * 该行业计划回落通用（下发语义，用户裁决 2026-09-08：码集命中行业行只发
 * 行业行，通用不并集）。
 * 添加只有一个动作：输入渠道名（datalist 候选与结果按当前行业过滤，规则
 * 与保底召回垂类匹配同一语义）→ 精确命中预勾选 → 「确认添加到本行业」
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
      searchArea = `  <p class="muted">该行业候选内没有名称包含「${esc(searchQuery)}」的渠道；换个关键词，或把行业切到「0 · 通用」搜全池。</p>`;
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
      <td>${esc(POOL_KIND_LABELS[result.kind] ?? result.kind)}</td>
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
            )}」过滤（自媒体按行业分类、媒体按频道类型映射；GEO 标记仅展示不入选）。</p>\n`
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
  <p class="muted">从上游全量拉取媒体+自媒体资源（约 2.5 万条，约 1 分钟，期间请勿关闭页面）；搜索与勾选都只打本地快照。</p>
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
    <button type="submit">搜索</button>
  </form>
  <p class="muted">切换行业后页面立即刷新，输入提示与搜索结果随之切换到该行业；从候选中选中完整名称后回车，命中的行已预勾选，点「确认添加」即完成。候选只含本行业渠道（自媒体按行业分类、媒体按频道类型映射；GEO 标记仅展示不入选）；要全池挑选请把行业切到「0 · 通用」。</p>
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
  return `    <tr>
      <td class="wrap">${esc(row.name)}</td>
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

function categoryOptionsHtml(selected: number): string {
  return Object.entries(PREFERENCE_CATEGORY_NAMES)
    .map(
      ([code, label]) =>
        `      <option value="${esc(code)}"${Number(code) === selected ? ' selected' : ''}>${esc(code)} · ${esc(label)}</option>`,
    )
    .join('\n');
}

// ── 表单校验（字符串入参；金额走字符串解析避免浮点尾差）─────────────────

const loginFormSchema = z.object({ password: z.string().min(1, '请输入运营密码。').max(128) });

const createAccountFormSchema = z.object({
  phone: phoneSchema,
  initialPassword: z.string().min(8, '初始密码至少 8 位').max(128),
});

const statusFormSchema = z.object({ status: z.enum(['active', 'disabled']) });

/** 充值金额：正数、最多两位小数、最小粒度 0.1 元（1 元 = 10 点 → 点数为整数）。 */
const topupFormSchema = z.object({
  amountYuan: z
    .string()
    .trim()
    .regex(/^\d{1,9}(\.\d{1,2})?$/, '充值金额必须是正数（最多两位小数）。'),
  note: z.string().trim().min(1, '来源备注不能为空。').max(500),
});

const adjustFormSchema = z.object({
  delta: z.string().trim().regex(/^[+-]?\d{1,8}$/, '调整点数必须是整数（可带 +/-）。'),
  note: z.string().trim().min(1, '调点必须带备注。').max(500),
});

/** 账号备注：可空（空串即清除），上限对齐账本备注。 */
const noteFormSchema = z.object({
  note: z.string().trim().max(500, '备注最长 500 字。'),
});

/** 重置密码：双输入防手误（零客户端 JS，只能提交后服务端裁决）。 */
const resetPasswordFormSchema = z
  .object({
    newPassword: z.string().min(8, '新密码至少 8 位').max(128),
    confirmPassword: z.string(),
  })
  .refine(data => data.newPassword === data.confirmPassword, {
    message: '两次输入的密码不一致。',
  });

const accountIdParamSchema = z.string().min(1, 'accountId 不能为空').max(64);

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

export function createAdminPageRoutes(deps: BackendDeps, throttle: AdminLoginThrottle) {
  const routes = new Hono();
  const config = deps.config;
  const upstream = new DistributionUpstream(deps, deps.fetchImpl ?? fetch);

  const hasValidSession = async (c: Context): Promise<boolean> => {
    const token = getCookie(c, ADMIN_SESSION_COOKIE);
    if (!token) return false;
    return (await verifyAdminToken(config.authSecret, token, deps.now())).ok;
  };

  /** 页面会话门：无效/缺失即 303 回登录页（覆盖 GET 页面与全部表单 POST）。 */
  const requireAdminPage = createMiddleware(async (c, next) => {
    if (!(await hasValidSession(c))) {
      return c.redirect('/admin', 303);
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

  routes.get('/admin', async c => {
    if (await hasValidSession(c)) {
      let profile: UpstreamCallResult<{ balanceCents: number }>;
      try {
        profile = await upstream.fetchProfile();
      } catch {
        // 上游不可达不阻断账号管理：余额卡降级为「获取失败」。
        profile = { ok: false, response: new Response('', { status: 502 }) };
      }
      return c.html(
        dashboardHtml(
          listAccounts(deps.db, 200),
          mediaPoolCardHtml(profile, config.adminMediaPoolLowBalanceCents),
          config.signupGrantPoints,
        ),
      );
    }
    return c.html(loginPageHtml());
  });

  routes.post('/admin/session', async c => {
    try {
      const form = await parseFormBody(c);
      const parsed = loginFormSchema.safeParse(form);
      if (!parsed.success) {
        return c.html(loginPageHtml(parsed.error.issues[0]?.message ?? '请输入运营密码。'), 400);
      }
      if (!timingSafeStringEqual(parsed.data.password, config.adminPassword)) {
        await throttle.penalize();
        return c.html(loginPageHtml('运营密码不正确。'), 401);
      }
      throttle.reset();
      const token = await signAdminToken(config.authSecret, config.adminTokenTtlSeconds, deps.now());
      setCookie(c, ADMIN_SESSION_COOKIE, token, {
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
        maxAge: config.adminTokenTtlSeconds,
        // 反代 TLS 终止后内网 hop 是 http：仅当本 hop 即 https 时加 Secure。
        secure: c.req.url.startsWith('https:'),
      });
      return c.redirect('/admin', 303);
    } catch (error) {
      if (error instanceof AppError) {
        return c.html(loginPageHtml(error.message), error.status as ContentfulStatusCode);
      }
      throw error;
    }
  });

  routes.post('/admin/logout', c => {
    deleteCookie(c, ADMIN_SESSION_COOKIE, { path: '/' });
    return c.redirect('/admin', 303);
  });

  routes.post('/admin/ui/accounts', requireAdminPage, async c => {
    try {
      const form = await parseFormBody(c);
      const parsed = createAccountFormSchema.safeParse(form);
      if (!parsed.success) {
        return htmlError(c, parsed.error.issues[0]?.message ?? '表单参数无效。', '/admin', 400);
      }
      createAccountWithGrant(deps, { phone: parsed.data.phone, password: parsed.data.initialPassword });
      return c.redirect('/admin', 303);
    } catch (error) {
      if (error instanceof AppError) return htmlError(c, error.message, '/admin', error.status);
      throw error;
    }
  });

  routes.post('/admin/ui/accounts/:accountId/status', requireAdminPage, async c => {
    try {
      const accountId = accountIdParamSchema.safeParse(c.req.param('accountId'));
      if (!accountId.success) {
        return htmlError(c, '账号 id 无效。', '/admin', 404);
      }
      const form = await parseFormBody(c);
      const parsed = statusFormSchema.safeParse(form);
      if (!parsed.success) {
        return htmlError(c, parsed.error.issues[0]?.message ?? '表单参数无效。', '/admin', 400);
      }
      setAccountStatus(deps, accountId.data, parsed.data.status);
      return c.redirect('/admin', 303);
    } catch (error) {
      if (error instanceof AppError) return htmlError(c, error.message, '/admin', error.status);
      throw error;
    }
  });

  routes.post('/admin/ui/accounts/:accountId/topup', requireAdminPage, async c => {
    const accountId = accountIdParamSchema.safeParse(c.req.param('accountId'));
    if (!accountId.success) {
      return htmlError(c, '账号 id 无效。', '/admin', 404);
    }
    const backHref = `/admin/accounts/${encodeURIComponent(accountId.data)}`;
    try {
      const form = await parseFormBody(c);
      const parsed = topupFormSchema.safeParse(form);
      if (!parsed.success) {
        return htmlError(c, parsed.error.issues[0]?.message ?? '表单参数无效。', backHref, 400);
      }
      const cents = Math.round(Number(parsed.data.amountYuan) * 100);
      if (cents <= 0) {
        return htmlError(c, '充值金额必须是正数。', backHref, 400);
      }
      if (cents % 10 !== 0) {
        return htmlError(c, '充值金额最小粒度为 0.1 元（1 元 = 10 点）。', backHref, 400);
      }
      // 对账口径：金额与来源备注一同落流水（kind=topup，1 元 = 10 点）。
      const note = `充值 ¥${yuan(cents)}：${parsed.data.note}`;
      applyAccountLedgerDelta(deps, accountId.data, cents / 10, 'topup', note);
      return c.redirect(backHref, 303);
    } catch (error) {
      if (error instanceof AppError) return htmlError(c, error.message, backHref, error.status);
      throw error;
    }
  });

  routes.post('/admin/ui/accounts/:accountId/adjust', requireAdminPage, async c => {
    const accountId = accountIdParamSchema.safeParse(c.req.param('accountId'));
    if (!accountId.success) {
      return htmlError(c, '账号 id 无效。', '/admin', 404);
    }
    const backHref = `/admin/accounts/${encodeURIComponent(accountId.data)}`;
    try {
      const form = await parseFormBody(c);
      const parsed = adjustFormSchema.safeParse(form);
      if (!parsed.success) {
        return htmlError(c, parsed.error.issues[0]?.message ?? '表单参数无效。', backHref, 400);
      }
      const delta = Number.parseInt(parsed.data.delta, 10);
      if (delta === 0) {
        return htmlError(c, '调整点数不能为 0。', backHref, 400);
      }
      if (Math.abs(delta) > 10_000_000) {
        return htmlError(c, '单次调整不能超过 10,000,000 点。', backHref, 400);
      }
      applyAccountLedgerDelta(deps, accountId.data, delta, 'adjust', parsed.data.note);
      return c.redirect(backHref, 303);
    } catch (error) {
      if (error instanceof AppError) return htmlError(c, error.message, backHref, error.status);
      throw error;
    }
  });

  routes.post('/admin/ui/accounts/:accountId/note', requireAdminPage, async c => {
    const accountId = accountIdParamSchema.safeParse(c.req.param('accountId'));
    if (!accountId.success) {
      return htmlError(c, '账号 id 无效。', '/admin', 404);
    }
    const backHref = `/admin/accounts/${encodeURIComponent(accountId.data)}`;
    try {
      const form = await parseFormBody(c);
      const parsed = noteFormSchema.safeParse(form);
      if (!parsed.success) {
        return htmlError(c, parsed.error.issues[0]?.message ?? '表单参数无效。', backHref, 400);
      }
      setAccountNote(deps, accountId.data, parsed.data.note);
      return c.redirect(backHref, 303);
    } catch (error) {
      if (error instanceof AppError) return htmlError(c, error.message, backHref, error.status);
      throw error;
    }
  });

  routes.post('/admin/ui/accounts/:accountId/reset-password', requireAdminPage, async c => {
    const accountId = accountIdParamSchema.safeParse(c.req.param('accountId'));
    if (!accountId.success) {
      return htmlError(c, '账号 id 无效。', '/admin', 404);
    }
    const backHref = `/admin/accounts/${encodeURIComponent(accountId.data)}`;
    try {
      const form = await parseFormBody(c);
      const parsed = resetPasswordFormSchema.safeParse(form);
      if (!parsed.success) {
        return htmlError(c, parsed.error.issues[0]?.message ?? '表单参数无效。', backHref, 400);
      }
      adminResetAccountPassword(deps, accountId.data, parsed.data.newPassword);
      return c.redirect(backHref, 303);
    } catch (error) {
      if (error instanceof AppError) return htmlError(c, error.message, backHref, error.status);
      throw error;
    }
  });

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
    const rows = listPreferenceChannels(deps.db);
    const boundRefs = rows
      .filter(row => row.kind !== '' && row.resource_id !== null)
      .map(row => ({ kind: row.kind, resourceId: row.resource_id as number }));
    const snapshotByRef = poolSnapshotByRefs(deps.db, boundRefs);
    const stats = poolSnapshotStats(deps.db);
    const searchResults =
      searchQuery === ''
        ? null
        : searchPoolSnapshot(deps.db, searchQuery, POOL_SEARCH_RESULT_LIMIT, industry);
    // datalist 候选：头部不重名候选 + 当前搜索结果名（覆盖头部之外命中）。
    const suggestions = listPoolSnapshotNames(deps.db, POOL_SUGGESTION_LIMIT, industry);
    if (searchResults !== null) {
      const seen = new Set(suggestions);
      for (const result of searchResults) {
        if (result.name === '' || seen.has(result.name)) continue;
        seen.add(result.name);
        suggestions.push(result.name);
      }
    }
    return c.html(
      preferenceChannelsHtml(rows, stats, snapshotByRef, searchQuery, searchResults, suggestions, industry),
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
      const fetchPage = async (kind: PoolKind, page: number) => {
        const result = await upstream.listResources(kind, page, POOL_SNAPSHOT_PAGE_SIZE);
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
              })),
            }
          : null;
      };
      await refreshDistributionPoolSnapshot(
        deps,
        fetchPage,
        ms => new Promise(resolve => setTimeout(resolve, ms)),
        POOL_SNAPSHOT_PAGE_DELAY_MS,
      );
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

  routes.get('/admin/accounts/:accountId', requireAdminPage, c => {
    const accountId = accountIdParamSchema.safeParse(c.req.param('accountId'));
    if (!accountId.success) {
      return htmlError(c, '账号 id 无效。', '/admin', 404);
    }
    try {
      return c.html(accountDetailHtml(deps, accountId.data));
    } catch (error) {
      if (error instanceof AppError) return htmlError(c, error.message, '/admin', error.status);
      throw error;
    }
  });

  return routes;
}

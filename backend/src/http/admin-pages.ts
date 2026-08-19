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
  createAccountWithGrant,
  findAccountById,
  listAccounts,
  setAccountStatus,
} from '../domain/accounts';
import { applyAccountLedgerDelta, balanceSnapshot, listLedgerEntries } from '../domain/ledger';
import { listPermitHistory } from '../domain/permits';
import { listPublishOrdersForAccount } from '../domain/publish-orders';
import { listChatUsageRecords } from '../domain/chat-usage';
import { listProviderUsageRecords } from '../domain/provider-usage';
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
 * 形态取舍：纯服务端渲染（模板字符串 + esc() 转义 helper，零客户端 JS、
 * 零新依赖、不引入前端构建链）；写操作走表单 POST + 303 See Other（PRG），
 * 刷新/回退不重放。会话凭证复用 signAdminToken 的运营 JWT（audience=
 * xiaojing-admin）放 HttpOnly;SameSite=Lax cookie——无服务端会话表、天然
 * 过期；SameSite=Lax 挡住跨站表单 POST（CSRF 主要面）。运营密码错误经共享
 * AdminLoginThrottle 递增延时（与 JSON 登录同一实例）。
 */

const ADMIN_SESSION_COOKIE = 'xiaojing_admin';

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
label{display:block;margin:10px 0 2px;font-size:13px;color:#3d4c5a}
input{width:240px;max-width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #cbd5e0;border-radius:6px;font:inherit}
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
  <form class="inline" method="post" action="/admin/logout">
    <button class="secondary" type="submit">退出登录</button>
  </form>
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
  <thead><tr><th>手机号</th><th>状态</th><th>余额（点）</th><th>待改密</th><th>建号时间</th><th>流水</th><th>操作</th></tr></thead>
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

const accountIdParamSchema = z.string().min(1, 'accountId 不能为空').max(64);

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

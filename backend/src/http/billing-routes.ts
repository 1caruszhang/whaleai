import { Hono } from 'hono';
import { z } from 'zod';
import type { BackendDeps } from '../deps';
import { balanceSnapshot, ledgerEntrySummary, listLedgerEntries } from '../domain/ledger';
import {
  applyForPermit,
  closePermit,
  getPermit,
  listOpenPermits,
  reportPermitUnit,
} from '../domain/permits';
import { parseJsonBody } from './request';
import { requireAccountAuth } from './auth-routes';
import type { BackendEnv } from './app';

/** permitId 是客户端生成的幂等键：uuid/短横线/冒号/下划线安全字符集。 */
const permitIdSchema = z
  .string()
  .min(8, 'permitId 至少 8 字符')
  .max(128)
  .regex(/^[A-Za-z0-9:_-]+$/, 'permitId 只能包含字母数字与 : _ -');

const applyPermitSchema = z.object({
  permitId: permitIdSchema,
  operation: z.string().min(1).max(64),
  units: z.number().int().min(1).max(1000),
  // 票 07 客户端形态：可省略价目，服务端按价目表定价（定价权威在后端）。
  // 携带时仍逐字段对账，漂移拒绝（price_mismatch / permit_id_conflict）。
  unitPrice: z.number().int().min(0).max(1_000_000).optional(),
  basePrice: z.number().int().min(0).max(1_000_000).optional(),
});

const reportUnitSchema = z.object({
  unit: z.number().int().min(0).max(1_000_000),
  outcome: z.enum(['success', 'failure']),
});

export function createBillingRoutes(deps: BackendDeps) {
  const routes = new Hono<BackendEnv>();
  const requireAccount = requireAccountAuth(deps);

  routes.get('/billing/balance', requireAccount, c => {
    const account = c.get('account');
    return c.json({
      balance: balanceSnapshot(deps.db, account),
      openPermits: listOpenPermits(deps, account.id),
    });
  });

  /**
   * 用户端点数明细：本账号最近 50 笔流水，最新在前。summary 已归一为中文
   * 可读文案（见 ledgerEntrySummary），客户端不做 note 解析。
   */
  routes.get('/billing/ledger', requireAccount, c => {
    const entries = listLedgerEntries(deps.db, c.get('account').id, 50).map(entry => ({
      id: entry.id,
      delta: entry.delta,
      balanceAfter: entry.balance_after,
      kind: entry.kind,
      summary: ledgerEntrySummary(entry.kind, entry.note),
      createdAt: entry.created_at,
    }));
    return c.json({ entries });
  });

  routes.post('/billing/permits', requireAccount, async c => {
    const body = await parseJsonBody(c, applyPermitSchema);
    const { permit, created } = applyForPermit(deps, c.get('account').id, {
      permitId: body.permitId,
      operation: body.operation,
      units: body.units,
      unitPrice: body.unitPrice,
      basePrice: body.basePrice,
    });
    return c.json({ permit }, created ? 201 : 200);
  });

  routes.get('/billing/permits/:permitId', requireAccount, c => {
    const permit = getPermit(deps, c.get('account').id, c.req.param('permitId'));
    return c.json({ permit });
  });

  routes.post('/billing/permits/:permitId/report', requireAccount, async c => {
    const body = await parseJsonBody(c, reportUnitSchema);
    const permit = reportPermitUnit(
      deps,
      c.get('account').id,
      c.req.param('permitId'),
      body.unit,
      body.outcome,
    );
    return c.json({ permit });
  });

  routes.post('/billing/permits/:permitId/close', requireAccount, c => {
    const permit = closePermit(deps, c.get('account').id, c.req.param('permitId'));
    return c.json({ permit });
  });

  return routes;
}

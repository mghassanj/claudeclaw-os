/**
 * Dashboard API for the outbound gateway. Registered from
 * buildDashboardApp, so the global /api/* token middleware, the CSRF
 * check and the DASHBOARD_MUTATIONS_ENABLED switch all apply.
 *
 *   GET  /api/outbound?limit=&status=&target=   read-only history
 *   GET  /api/outbound/:id                      one action
 *   POST /api/outbound/decide {code|id, decision, via}
 *        used by the WhatsApp self-chat "YES <code>" path
 */
import type { Hono } from 'hono';

import { decide, getAction, listActions, publicView, type OutboundStatus } from './outbound.js';

const STATUSES = new Set(['proposed', 'approved', 'rejected', 'executed', 'failed', 'expired']);

export function registerOutboundRoutes(app: Hono): void {
  app.get('/api/outbound', (c) => {
    const limit = Number(c.req.query('limit') ?? '50') || 50;
    const status = c.req.query('status');
    const target = c.req.query('target') || undefined;
    if (status && !STATUSES.has(status)) return c.json({ error: 'bad status' }, 400);
    const rows = listActions({ limit, status: status as OutboundStatus | undefined, target });
    return c.json({ actions: rows.map(publicView) });
  });

  app.get('/api/outbound/:id{[0-9]+}', (c) => {
    const a = getAction(Number(c.req.param('id')));
    if (!a) return c.json({ error: 'not found' }, 404);
    return c.json({ action: publicView(a) });
  });

  app.post('/api/outbound/decide', async (c) => {
    let body: any = {};
    try { body = await c.req.json(); } catch { /* empty */ }
    const decision = body?.decision;
    if (decision !== 'approve' && decision !== 'reject') return c.json({ error: 'decision must be approve|reject' }, 400);
    const code = typeof body?.code === 'string' ? body.code.trim() : undefined;
    const id = Number.isInteger(body?.id) ? body.id : undefined;
    if (!code && id === undefined) return c.json({ error: 'code or id required' }, 400);
    const via = typeof body?.via === 'string' && body.via ? body.via.slice(0, 20) : 'dashboard';
    const res = await decide({ code, id, decision, via });
    return c.json({ ok: res.ok, notFound: !!res.notFound, message: res.message, action: res.action ? publicView(res.action) : null });
  });
}

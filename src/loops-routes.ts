/**
 * Dashboard API for open loops. Registered by buildDashboardApp, so every
 * route sits behind the global /api/ token gate and the CSRF check.
 *
 *   POST /api/loops/inbound    WhatsApp service -> match await_reply loops
 *   GET  /api/loops/watch      WhatsApp service startup catch-up list
 *   POST /api/loops/self-chat  WhatsApp service reports the self-chat id
 *   GET  /api/loops            list (dashboard / debugging)
 */
import type { Hono } from 'hono';

import { logger } from './logger.js';
import { listLoops } from './open-loops.js';
import { getWatchList, handleInboundMessage, rememberWhatsAppSelfChatId, type InboundPayload } from './open-loops-runtime.js';

/** POST paths the WhatsApp service must reach even in dashboard read-only mode. */
export const LOOP_ROUTES_READONLY_EXEMPT = ['/api/loops/inbound', '/api/loops/self-chat'];

export function registerLoopRoutes(app: Hono): void {
  app.post('/api/loops/inbound', async (c) => {
    let body: Partial<InboundPayload> = {};
    try { body = await c.req.json(); } catch { /* empty */ }
    if (typeof body.chatId !== 'string' || !body.chatId) return c.json({ error: 'chatId required' }, 400);
    try {
      const fired = handleInboundMessage({
        chatId: body.chatId,
        isGroup: !!body.isGroup,
        senderIds: Array.isArray(body.senderIds) ? body.senderIds.filter((x) => typeof x === 'string') : [],
        senderName: typeof body.senderName === 'string' ? body.senderName.slice(0, 200) : undefined,
        text: typeof body.text === 'string' ? body.text.slice(0, 8000) : undefined,
        messageId: typeof body.messageId === 'string' ? body.messageId : undefined,
        timestamp: typeof body.timestamp === 'number' ? body.timestamp : undefined,
        catchUp: !!body.catchUp,
      });
      return c.json({ fired });
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err }, 'loops inbound failed');
      return c.json({ error: 'inbound failed' }, 500);
    }
  });

  app.get('/api/loops/watch', (c) => c.json({ loops: getWatchList() }));

  app.post('/api/loops/self-chat', async (c) => {
    let body: { chatId?: unknown } = {};
    try { body = await c.req.json(); } catch { /* empty */ }
    if (typeof body.chatId !== 'string' || !body.chatId) return c.json({ error: 'chatId required' }, 400);
    rememberWhatsAppSelfChatId(body.chatId);
    return c.json({ ok: true });
  });

  app.get('/api/loops', (c) => c.json({ loops: listLoops({ includeClosed: c.req.query('all') === '1', limit: 100 }) }));
}

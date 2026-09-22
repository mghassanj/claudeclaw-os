/**
 * Telegram side of the outbound gateway (main bot only):
 *   - ✅ / ❌ buttons on proposal cards (callback data "ob:a:<id>" / "ob:r:<id>")
 *   - /outbox: the last outbound actions and their receipts
 * Proposal cards themselves are posted by src/outbound.ts through the Bot
 * API so the CLI can post them from any process.
 */
import type { Bot } from 'grammy';

import { ALLOWED_CHAT_ID } from './config.js';
import { logger } from './logger.js';
import { decide, listActions, payloadText, type OutboundAction } from './outbound.js';
import { isLocked } from './security.js';

export function formatOutboxLine(a: OutboundAction): string {
  const when = new Date((a.executed_at ?? a.decided_at ?? a.created_at) * 1000).toISOString().slice(5, 16).replace('T', ' ');
  const text = payloadText(a).replace(/\s+/g, ' ').slice(0, 40);
  let mid = '';
  try { const r = a.receipt ? JSON.parse(a.receipt) : null; if (r?.messageId) mid = ` · id …${String(r.messageId).slice(-8)}`; else if (r?.eventId) mid = ` · event …${String(r.eventId).slice(-8)}`; } catch { /* ignore */ }
  return `#${a.id} ${a.status} · ${a.kind} → ${a.target_name || a.target} · ${when} · ${text}${mid}`;
}

export function registerOutboundHandlers(bot: Bot): void {
  bot.callbackQuery(/^ob:(a|r):(\d+)$/, async (ctx) => {
    const fromId = String(ctx.from?.id ?? '');
    if (!ALLOWED_CHAT_ID || fromId !== ALLOWED_CHAT_ID) {
      logger.warn({ fromId }, 'outbound: callback from unauthorised user ignored');
      await ctx.answerCallbackQuery({ text: 'Not authorised.' }).catch(() => {});
      return;
    }
    if (isLocked()) {
      await ctx.answerCallbackQuery({ text: 'Bot is locked. Unlock with your PIN first.', show_alert: true }).catch(() => {});
      return;
    }
    const decision = ctx.match[1] === 'a' ? 'approve' : 'reject';
    const id = Number(ctx.match[2]);
    await ctx.answerCallbackQuery({ text: decision === 'approve' ? 'Approved, sending…' : 'Cancelling…' }).catch(() => {});
    try {
      const res = await decide({ id, decision, via: 'telegram' });
      // Successful outcomes already produce a receipt / edited card; only
      // surface refusals (already decided, expired, disabled) here.
      if (!res.ok) await ctx.reply(res.message).catch(() => {});
    } catch (err: any) {
      logger.error({ err, id }, 'outbound: decision failed');
      await ctx.reply(`Outbound #${id}: ${err?.message ?? 'decision failed'}`).catch(() => {});
    }
  });

  bot.command('outbox', async (ctx) => {
    if (!ALLOWED_CHAT_ID || String(ctx.chat?.id) !== ALLOWED_CHAT_ID) return;
    const rows = listActions({ limit: 15 });
    await ctx.reply(rows.length ? rows.map(formatOutboxLine).join('\n') : 'No outbound actions yet.');
  });
}

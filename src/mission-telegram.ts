/**
 * Telegram "↻ Retry" button on the interrupted-mission notice the scheduler
 * sends at startup (scheduler.ts). Registered by every agent's bot: each
 * agent's scheduler sends its own notice through its own bot, so the button
 * press comes back to that bot.
 */
import type { Bot, Context } from 'grammy';

import { retryMissionTask } from './db.js';
import { logger } from './logger.js';

/** Telegram callback_data prefix for the "↻ Retry" button on an interrupted mission. */
export const MISSION_RETRY_CALLBACK = 'mission:retry:';

/** Re-queue an interrupted mission; returns the user-facing outcome. */
export function retryMissionFromTelegram(id: string): string {
  const task = retryMissionTask(id);
  return task
    ? `Mission "${task.title}" re-queued; @${task.assigned_agent ?? 'unassigned'} picks it up within a minute.`
    : `Mission ${id} can't be retried (unknown, or no longer interrupted).`;
}

const RETRY_RE = /^mission:retry:(.+)$/;

/**
 * @param allowed returns true when the chat may act (auth + lock check owned
 *                by bot.ts).
 */
export function registerMissionRetryButton(bot: Bot, allowed: (ctx: Context) => Promise<boolean>): void {
  bot.callbackQuery(RETRY_RE, async (ctx) => {
    if (!(await allowed(ctx))) {
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }
    const id = ctx.match![1];
    let text: string;
    try {
      text = retryMissionFromTelegram(id);
    } catch (err) {
      logger.error({ err, id }, 'mission retry failed');
      text = `Could not retry mission ${id}.`;
    }
    await ctx.answerCallbackQuery({ text: text.slice(0, 190) }).catch(() => {});
    await ctx.reply(text).catch(() => {});
  });
}

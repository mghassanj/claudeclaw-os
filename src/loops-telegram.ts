/**
 * Telegram /loops: list open loops with a ✅ Close button per loop.
 * Registered from bot.ts (main agent only; the table is shared).
 */
import { InlineKeyboard, type Bot, type Context } from 'grammy';

import { closeLoop, formatLoopLine, getLoop, listLoops } from './open-loops.js';
import { logger } from './logger.js';

const MAX_BUTTONS = 8;

export function renderLoopsMessage(): { text: string; keyboard?: InlineKeyboard } {
  const loops = listLoops({ limit: 30 });
  if (loops.length === 0) return { text: 'No open loops.' };
  const lines = loops.map((l) => formatLoopLine(l));
  const kb = new InlineKeyboard();
  loops.slice(0, MAX_BUTTONS).forEach((l, i) => {
    kb.text(`✅ Close #${l.id}`, `loop:close:${l.id}`);
    if (i % 2 === 1) kb.row();
  });
  const text = `Open loops (${loops.length}):\n${lines.join('\n')}`;
  return { text: text.length > 3900 ? text.slice(0, 3900) + '…' : text, keyboard: kb };
}

/**
 * @param allowed returns true when the chat may use the command (auth +
 *                lock check owned by bot.ts).
 */
export function registerLoopsCommand(bot: Bot, allowed: (ctx: Context) => Promise<boolean>): void {
  bot.command('loops', async (ctx) => {
    if (!(await allowed(ctx))) return;
    try {
      const { text, keyboard } = renderLoopsMessage();
      await ctx.reply(text, keyboard ? { reply_markup: keyboard } : undefined);
    } catch (err) {
      logger.error({ err }, '/loops failed');
      await ctx.reply('Could not list open loops.').catch(() => {});
    }
  });

  bot.callbackQuery(/^loop:close:(\d+)$/, async (ctx) => {
    if (!(await allowed(ctx))) {
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }
    const id = Number(ctx.match![1]);
    const ok = closeLoop(id, 'closed from Telegram /loops');
    await ctx.answerCallbackQuery({ text: ok ? `Closed #${id}` : `#${id} was already closed` }).catch(() => {});
    const l = getLoop(id);
    if (l) await ctx.reply(`Loop #${id} is now ${l.status}: ${l.summary.slice(0, 120)}`).catch(() => {});
  });
}

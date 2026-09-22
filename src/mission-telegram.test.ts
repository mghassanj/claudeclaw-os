import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { _initTestDatabase, claimNextMissionTask, createMissionTask, getMissionTask, recoverInterruptedMissions } from './db.js';
import { registerMissionRetryButton, retryMissionFromTelegram } from './mission-telegram.js';

beforeEach(() => _initTestDatabase());

function interrupted(id: string, title: string): void {
  createMissionTask(id, title, 'prompt', 'main');
  claimNextMissionTask('main');
  recoverInterruptedMissions('main');
}

/** Minimal grammY stand-in: captures the callbackQuery handler. */
function fakeBot() {
  let pattern: RegExp | null = null;
  let handler: ((ctx: any) => Promise<void>) | null = null;
  const bot = { callbackQuery: (p: RegExp, h: (ctx: any) => Promise<void>) => { pattern = p; handler = h; } };
  const press = async (data: string) => {
    const m = data.match(pattern!);
    if (!m) return null;
    const ctx = { chat: { id: 1 }, match: m, answerCallbackQuery: vi.fn(async () => {}), reply: vi.fn(async () => {}) };
    await handler!(ctx);
    return ctx;
  };
  return { bot, press };
}

describe('mission ↻ Retry button', () => {
  it('re-queues an interrupted mission and says so', async () => {
    interrupted('ab12cd34', 'Draft report');
    const { bot, press } = fakeBot();
    registerMissionRetryButton(bot as any, async () => true);
    const ctx = (await press('mission:retry:ab12cd34'))!;
    expect(getMissionTask('ab12cd34')!.status).toBe('queued');
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Mission "Draft report" re-queued'));
    // A second press is a no-op with an explanation.
    const again = (await press('mission:retry:ab12cd34'))!;
    expect(again.reply).toHaveBeenCalledWith(expect.stringContaining("can't be retried"));
  });

  it('does nothing when the chat is not allowed (auth / PIN lock)', async () => {
    interrupted('ab12cd34', 'Draft report');
    const { bot, press } = fakeBot();
    registerMissionRetryButton(bot as any, async () => false);
    const ctx = (await press('mission:retry:ab12cd34'))!;
    expect(getMissionTask('ab12cd34')!.status).toBe('interrupted');
    expect(ctx.reply).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
  });

  it('ignores other callback data', async () => {
    const { bot, press } = fakeBot();
    registerMissionRetryButton(bot as any, async () => true);
    expect(await press('loop:close:3')).toBeNull();
  });

  it('retryMissionFromTelegram reports unknown ids', () => {
    expect(retryMissionFromTelegram('nope')).toContain("can't be retried");
  });
});

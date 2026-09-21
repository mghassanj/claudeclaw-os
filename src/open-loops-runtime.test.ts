import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./bot.js', () => ({
  formatForTelegram: (s: string) => s,
  splitMessage: (s: string) => [s],
}));

import { _initTestDatabase, setDashboardSetting } from './db.js';
import { addContact } from './contacts.js';
import { createLoop, getLoop } from './open-loops.js';
import {
  _setLoopRuntimeForTests,
  buildLoopPrompt,
  getWatchList,
  handleInboundMessage,
  resolveOrigin,
  resumePendingLoopFires,
  sweepOpenLoops,
} from './open-loops-runtime.js';

const now = () => Math.floor(Date.now() / 1000);

let runner: ReturnType<typeof vi.fn>;
let telegram: ReturnType<typeof vi.fn>;
let whatsapp: ReturnType<typeof vi.fn>;

beforeEach(() => {
  _initTestDatabase();
  runner = vi.fn(async (_p: string) => 'Drafted a reply for Nora; approve?');
  telegram = vi.fn(async (_t: string) => {});
  whatsapp = vi.fn(async (_c: string, _t: string) => {});
  _setLoopRuntimeForTests({ runner, telegram, whatsapp });
  delete process.env.WHATSAPP_SELF_CHAT_ID;
});

describe('handleInboundMessage', () => {
  it('fires a matching await_reply loop once, runs a main turn and reports to Telegram', async () => {
    const nora = addContact({ display_name: 'Nora', wa_chat_id: '966500000001@c.us', language_pref: 'ar-najdi' });
    const l = createLoop({ kind: 'await_reply', summary: 'Nora answer on Thursday', intent_prompt: 'Draft a reply, ask Mohamed', contact_id: nora.id });

    const fired = handleInboundMessage({
      chatId: '966500000001@c.us', senderIds: ['966500000001@c.us'], senderName: 'Nora',
      text: 'Thursday works', messageId: 'm1', timestamp: now() + 1,
    });
    expect(fired).toEqual([l.id]);
    await vi.waitFor(() => expect(telegram).toHaveBeenCalled());

    const prompt = runner.mock.calls[0][0] as string;
    expect(prompt).toContain(`[Open loop #${l.id} fired]`);
    expect(prompt).toContain('Intent: Draft a reply, ask Mohamed');
    expect(prompt).toContain('Thursday works');
    expect(prompt).toContain('prefers: ar-najdi');
    expect(telegram.mock.calls[0][0]).toContain(`Loop #${l.id}`);
    expect(getLoop(l.id)?.status).toBe('fired');
    await vi.waitFor(() => expect(getLoop(l.id)?.pending_trigger).toBeNull());

    // A second message does not fire again (max_fires = 1).
    expect(handleInboundMessage({ chatId: '966500000001@c.us', senderIds: [], text: 'hello?', messageId: 'm2', timestamp: now() + 2 })).toEqual([]);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('ignores messages older than the loop (catch-up replays)', () => {
    createLoop({ kind: 'await_reply', summary: 'x', chat_ref: '966500000001@c.us' });
    expect(handleInboundMessage({ chatId: '966500000001@c.us', text: 'old', messageId: 'old', timestamp: now() - 600 })).toEqual([]);
    expect(runner).not.toHaveBeenCalled();
  });

  it('updates last_interaction_at on known contacts', () => {
    const c = addContact({ display_name: 'Sara', phone: '+966 50 000 0002' });
    handleInboundMessage({ chatId: '966500000002@c.us', text: 'hi', messageId: 'x', timestamp: 1_900_000_000 });
    expect(getWatchList()).toEqual([]);
    return import('./contacts.js').then(({ getContact }) => expect(getContact(c.id)?.last_interaction_at).toBe(1_900_000_000));
  });

  it('reports to the WhatsApp self-chat when the loop came from there', async () => {
    setDashboardSetting('wa_self_chat_id', 'SELF@lid');
    const l = createLoop({ kind: 'await_reply', summary: 'x', chat_ref: '966500000001@c.us', origin: 'whatsapp-self' });
    handleInboundMessage({ chatId: '966500000001@c.us', text: 'ok', messageId: 'm', timestamp: now() + 1 });
    await vi.waitFor(() => expect(whatsapp).toHaveBeenCalled());
    expect(whatsapp.mock.calls[0][0]).toBe('SELF@lid');
    expect(whatsapp.mock.calls[0][1]).toContain(`Loop #${l.id}`);
    expect(telegram).not.toHaveBeenCalled();
  });

  it('falls back to Telegram when WhatsApp delivery fails', async () => {
    whatsapp.mockRejectedValueOnce(new Error('client not ready'));
    createLoop({ kind: 'await_reply', summary: 'x', chat_ref: '966500000001@c.us', origin: 'whatsapp:SELF@lid' });
    handleInboundMessage({ chatId: '966500000001@c.us', text: 'ok', messageId: 'm', timestamp: now() + 1 });
    await vi.waitFor(() => expect(telegram).toHaveBeenCalled());
  });
});

describe('sweepOpenLoops', () => {
  it('fires due reminders once and expires stale loops with one notice', async () => {
    const r = createLoop({ kind: 'reminder', summary: 'pay invoice', intent_prompt: 'remind Mohamed', due_at: now() - 5 });
    const stale = createLoop({ kind: 'await_reply', summary: 'old wait', chat_ref: '966500000009@c.us', expires_at: now() - 1 });

    await sweepOpenLoops();
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
    expect(runner.mock.calls[0][0]).toContain(`[Open loop #${r.id} due]`);
    expect(getLoop(stale.id)?.status).toBe('expired');
    await vi.waitFor(() => expect(telegram.mock.calls.some((c) => String(c[0]).includes('expired'))).toBe(true));

    telegram.mockClear();
    await sweepOpenLoops();
    await new Promise((res) => setTimeout(res, 20));
    expect(runner).toHaveBeenCalledTimes(1);
    expect(telegram.mock.calls.some((c) => String(c[0]).includes('expired'))).toBe(false);
  });

  it('await_reply deadline nudges without consuming the reply fire', async () => {
    const l = createLoop({ kind: 'await_reply', summary: 'x', chat_ref: '966500000001@c.us', due_at: now() - 5 });
    await sweepOpenLoops();
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
    expect(runner.mock.calls[0][0]).toContain('deadline');
    expect(getLoop(l.id)?.status).toBe('waiting');
    expect(handleInboundMessage({ chatId: '966500000001@c.us', text: 'sorry late', messageId: 'z', timestamp: now() + 1 })).toEqual([l.id]);
  });
});

describe('restart durability', () => {
  it('re-runs a fire whose turn never completed', async () => {
    const l = createLoop({ kind: 'await_reply', summary: 'x', chat_ref: '966500000001@c.us' });
    // Simulate: claimed + crashed before the turn finished.
    const { claimFire } = await import('./open-loops.js');
    claimFire(l.id, 'm1', JSON.stringify({ type: 'inbound', text: 'reply while crashing', from: 'Nora' }));
    expect(resumePendingLoopFires()).toBe(1);
    await vi.waitFor(() => expect(runner).toHaveBeenCalled());
    expect(runner.mock.calls[0][0]).toContain('resumed after a restart');
    expect(runner.mock.calls[0][0]).toContain('reply while crashing');
    await vi.waitFor(() => expect(getLoop(l.id)?.pending_trigger).toBeNull());
    expect(resumePendingLoopFires()).toBe(0);
  });
});

describe('helpers', () => {
  it('resolveOrigin', () => {
    expect(resolveOrigin('telegram')).toEqual({ kind: 'telegram' });
    expect(resolveOrigin('whatsapp:abc@c.us')).toEqual({ kind: 'whatsapp', chatId: 'abc@c.us' });
    expect(resolveOrigin('whatsapp-self')).toEqual({ kind: 'telegram' });
    process.env.WHATSAPP_SELF_CHAT_ID = 'env@lid';
    expect(resolveOrigin('whatsapp-self')).toEqual({ kind: 'whatsapp', chatId: 'env@lid' });
  });

  it('prompt tells the agent drafts need approval and how to close', () => {
    const l = createLoop({ kind: 'promise', summary: 'send deck', due_at: now() });
    const p = buildLoopPrompt(l, { type: 'due' });
    expect(p).toContain('Mohamed approves');
    expect(p).toContain(`loops-cli close ${l.id}`);
  });

  it('watch list exposes waiting loops with their ids', () => {
    const l = createLoop({ kind: 'await_reply', summary: 'x', chat_ref: '966500000001@c.us' });
    expect(getWatchList()).toEqual([{ id: l.id, ids: ['966500000001@c.us'], since: l.updated_at }]);
  });
});

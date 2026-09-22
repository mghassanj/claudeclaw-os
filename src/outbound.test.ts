import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';

import { _initTestDatabase, getOutboundDb } from './db.js';
import * as ks from './kill-switches.js';
import {
  propose, decide, complete, getAction, listActions, computeHashes, normalizeText, normalizeTarget,
  isAutonomousContact, generateApprovalCode, formatReceipt, OutboundError, publicView,
  type OutboundDeps,
} from './outbound.js';
import { registerOutboundRoutes } from './outbound-routes.js';
import { formatOutboxLine } from './outbound-telegram.js';

const NORA = '966500000001@c.us';
const ENV_KEYS = ['OUTBOUND_ENABLED', 'OUTBOUND_AUTONOMY_ENABLED', 'OUTBOUND_AUTONOMOUS_CONTACTS', 'OUTBOUND_PROPOSAL_TTL_HOURS'];

function makeDeps(start = 1_800_000_000) {
  let now = start;
  let tgId = 100;
  const deps = {
    now: () => now,
    waPost: vi.fn(async (_route: string, body: Record<string, unknown>) => ({
      ok: true, messageId: `true_${String(body.chatId)}_3EB0ABCDEF123456`, timestamp: now, duplicate: false,
    })),
    notify: vi.fn(async (_text: string, _buttons?: unknown) => ++tgId),
    clearButtons: vi.fn(async () => {}),
  };
  return { deps: deps as unknown as OutboundDeps & typeof deps, advance: (s: number) => { now += s; } };
}

describe('outbound gateway', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    _initTestDatabase();
    saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    ks._reset();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    ks._reset();
  });

  it('propose stores a proposed row and posts a Telegram card with buttons, sending nothing', async () => {
    const { deps } = makeDeps();
    const res = await propose({ kind: 'wa_message', target: NORA, targetName: 'Nora', payload: { text: 'مرحبا نورة' }, agent: 'main' }, deps);
    expect(res.autonomous).toBe(false);
    expect(res.action.status).toBe('proposed');
    expect(res.action.approval_code).toMatch(/^[A-HJ-KMNP-Z2-9]{4}$/);
    expect(res.action.tg_message_id).toBe(101);
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(deps.notify.mock.calls[0][0]).toContain('مرحبا نورة');
    expect(deps.notify.mock.calls[0][0]).toContain(`YES ${res.action.approval_code}`);
    expect(deps.notify.mock.calls[0][1]).toEqual({ id: res.action.id, kind: 'wa_message' });
    expect(deps.waPost).not.toHaveBeenCalled();
    expect(res.action.expires_at - res.action.created_at).toBe(24 * 3600);
  });

  it('approval executes the exact stored text once, with the idempotency key, and posts a receipt', async () => {
    const { deps } = makeDeps();
    const { action } = await propose({ kind: 'wa_message', target: NORA, targetName: 'Nora', payload: { text: 'Hi Nora, see you at 3' } }, deps);
    const r1 = await decide({ id: action.id, decision: 'approve', via: 'telegram' }, deps);
    expect(r1.ok).toBe(true);
    expect(deps.waPost).toHaveBeenCalledTimes(1);
    expect(deps.waPost).toHaveBeenCalledWith('/send-as-me', {
      chatId: NORA, text: 'Hi Nora, see you at 3', idempotencyKey: action.idempotency_key, actionId: action.id,
    });
    const row = getAction(action.id)!;
    expect(row.status).toBe('executed');
    expect(row.decided_via).toBe('telegram');
    expect(JSON.parse(row.receipt!).messageId).toContain('3EB0ABCDEF123456');
    expect(r1.message).toMatch(/^Sent to Nora ✓ Hi Nora, see you at 3 · id …EF123456 \(#\d+\)$/);
    expect(deps.notify).toHaveBeenLastCalledWith(r1.message);
    expect(deps.clearButtons).toHaveBeenCalled();

    // A second approval (e.g. "YES code" after the button) does nothing.
    const r2 = await decide({ id: action.id, decision: 'approve', via: 'whatsapp' }, deps);
    expect(r2.ok).toBe(false);
    expect(r2.message).toContain('already executed');
    expect(deps.waPost).toHaveBeenCalledTimes(1);
  });

  it('two approvals racing still execute once', async () => {
    const { deps } = makeDeps();
    const { action } = await propose({ kind: 'wa_message', target: NORA, payload: { text: 'race' } }, deps);
    const [a, b] = await Promise.all([
      decide({ id: action.id, decision: 'approve', via: 'telegram' }, deps),
      decide({ code: action.approval_code.toLowerCase(), decision: 'approve', via: 'whatsapp' }, deps),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(deps.waPost).toHaveBeenCalledTimes(1);
  });

  it('refuses an identical proposal while pending and within 10 min of execution, unless forced', async () => {
    const { deps, advance } = makeDeps();
    const { action } = await propose({ kind: 'wa_message', target: NORA, payload: { text: 'Same text' } }, deps);
    // Cosmetic whitespace differences are the same message.
    await expect(propose({ kind: 'wa_message', target: NORA, payload: { text: '  Same text \r\n' } }, deps))
      .rejects.toMatchObject({ code: 'duplicate_pending' });
    await decide({ id: action.id, decision: 'approve', via: 'telegram' }, deps);
    advance(5 * 60);
    await expect(propose({ kind: 'wa_message', target: NORA, payload: { text: 'Same text' } }, deps))
      .rejects.toMatchObject({ code: 'duplicate_recent' });
    const forced = await propose({ kind: 'wa_message', target: NORA, payload: { text: 'Same text' }, force: true }, deps);
    expect(forced.action.idempotency_key).toBe(`${action.idempotency_key}~1`);
    expect(forced.action.forced).toBe(1);
    await decide({ id: forced.action.id, decision: 'reject', via: 'telegram' }, deps);
    advance(6 * 60);
    const later = await propose({ kind: 'wa_message', target: NORA, payload: { text: 'Same text' } }, deps);
    expect(later.action.status).toBe('proposed');
    expect(later.action.idempotency_key).toBe(`${action.idempotency_key}~2`);
  });

  it('reject sends nothing; unknown codes are reported as notFound', async () => {
    const { deps } = makeDeps();
    const { action } = await propose({ kind: 'wa_message', target: NORA, payload: { text: 'nope' } }, deps);
    const r = await decide({ code: action.approval_code, decision: 'reject', via: 'whatsapp' }, deps);
    expect(r.ok).toBe(true);
    expect(getAction(action.id)!.status).toBe('rejected');
    expect(deps.waPost).not.toHaveBeenCalled();
    const unknown = await decide({ code: 'ZZZZ', decision: 'approve', via: 'whatsapp' }, deps);
    expect(unknown).toMatchObject({ ok: false, notFound: true });
  });

  it('proposals expire after the TTL and cannot be approved', async () => {
    const { deps, advance } = makeDeps();
    const { action } = await propose({ kind: 'wa_message', target: NORA, payload: { text: 'late' } }, deps);
    advance(24 * 3600 + 1);
    const r = await decide({ id: action.id, decision: 'approve', via: 'telegram' }, deps);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('expired');
    expect(deps.waPost).not.toHaveBeenCalled();
  });

  it('autonomous contacts execute without approval only when OUTBOUND_AUTONOMY_ENABLED is on', async () => {
    process.env.OUTBOUND_AUTONOMOUS_CONTACTS = '+966 50 000 0001';
    const { deps } = makeDeps();
    const r = await propose({ kind: 'wa_message', target: NORA, targetName: 'Nora', payload: { text: 'auto' } }, deps);
    expect(r.autonomous).toBe(true);
    expect(r.action.status).toBe('executed');
    expect(r.action.decided_via).toBe('autonomous');
    expect(deps.waPost).toHaveBeenCalledTimes(1);

    process.env.OUTBOUND_AUTONOMY_ENABLED = 'false';
    ks._reset();
    const r2 = await propose({ kind: 'wa_message', target: NORA, payload: { text: 'auto 2' } }, deps);
    expect(r2.autonomous).toBe(false);
    expect(r2.action.status).toBe('proposed');
  });

  it('revokes always need approval, even for autonomous contacts', async () => {
    process.env.OUTBOUND_AUTONOMOUS_CONTACTS = NORA;
    const { deps } = makeDeps();
    const r = await propose({ kind: 'revoke', target: NORA, payload: { messageId: 'true_966500000001@c.us_ABC' } }, deps);
    expect(r.autonomous).toBe(false);
    expect(r.action.status).toBe('proposed');
    expect(deps.waPost).not.toHaveBeenCalled();
    await decide({ id: r.action.id, decision: 'approve', via: 'telegram' }, deps);
    expect(deps.waPost).toHaveBeenCalledWith('/revoke-as-me', expect.objectContaining({ chatId: NORA, messageId: 'true_966500000001@c.us_ABC' }));
  });

  it('OUTBOUND_ENABLED=false refuses proposals and approvals', async () => {
    const { deps } = makeDeps();
    const { action } = await propose({ kind: 'wa_message', target: NORA, payload: { text: 'x' } }, deps);
    process.env.OUTBOUND_ENABLED = 'false';
    ks._reset();
    await expect(propose({ kind: 'wa_message', target: NORA, payload: { text: 'y' } }, deps)).rejects.toBeInstanceOf(OutboundError);
    const r = await decide({ id: action.id, decision: 'approve', via: 'telegram' }, deps);
    expect(r.ok).toBe(false);
    expect(getAction(action.id)!.status).toBe('proposed');
    expect(deps.waPost).not.toHaveBeenCalled();
  });

  it('refuses to execute a payload changed after proposal', async () => {
    const { deps } = makeDeps();
    const { action } = await propose({ kind: 'wa_message', target: NORA, payload: { text: 'original' } }, deps);
    getOutboundDb().prepare('UPDATE outbound_actions SET payload = ? WHERE id = ?').run('{"text":"tampered"}', action.id);
    const r = await decide({ id: action.id, decision: 'approve', via: 'telegram' }, deps);
    expect(r.ok).toBe(false);
    expect(getAction(action.id)!.status).toBe('failed');
    expect(deps.waPost).not.toHaveBeenCalled();
  });

  it('records a failed send and does not retry it', async () => {
    const { deps } = makeDeps();
    deps.waPost.mockResolvedValueOnce({ ok: false, error: 'client not ready (state=DISCONNECTED)' } as any);
    const { action } = await propose({ kind: 'wa_message', target: NORA, payload: { text: 'fails' } }, deps);
    const r = await decide({ id: action.id, decision: 'approve', via: 'telegram' }, deps);
    expect(r.ok).toBe(false);
    const row = getAction(action.id)!;
    expect(row.status).toBe('failed');
    expect(row.error).toContain('DISCONNECTED');
    expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining('failed'));
  });

  it('approval-only kinds: approve, then the agent records completion once', async () => {
    const { deps } = makeDeps();
    const { action } = await propose({ kind: 'jira', target: 'JTS-136', payload: { text: 'Comment body' } }, deps);
    expect(action.target).toBe('JTS-136');
    expect((await complete(action.id, { ref: 'x' }, deps)).ok).toBe(false); // not approved yet
    const r = await decide({ id: action.id, decision: 'approve', via: 'telegram' }, deps);
    expect(r.ok).toBe(true);
    expect(getAction(action.id)!.status).toBe('approved');
    expect(deps.waPost).not.toHaveBeenCalled();
    const c = await complete(action.id, { ref: 'gmail-123' }, deps);
    expect(c.ok).toBe(true);
    expect(getAction(action.id)!.status).toBe('executed');
    expect((await complete(action.id, { ref: 'again' }, deps)).ok).toBe(false);
  });

  it('validates wa targets and payloads', async () => {
    const { deps } = makeDeps();
    await expect(propose({ kind: 'wa_message', target: 'Nora', payload: { text: 'x' } }, deps)).rejects.toMatchObject({ code: 'bad_target' });
    await expect(propose({ kind: 'wa_message', target: NORA, payload: { text: '   ' } }, deps)).rejects.toMatchObject({ code: 'bad_payload' });
    await expect(propose({ kind: 'revoke', target: NORA, payload: {} }, deps)).rejects.toMatchObject({ code: 'bad_payload' });
  });

  it('list shows history newest first, filterable', async () => {
    const { deps } = makeDeps();
    const a = await propose({ kind: 'wa_message', target: NORA, targetName: 'Nora', payload: { text: 'one' } }, deps);
    await decide({ id: a.action.id, decision: 'approve', via: 'telegram' }, deps);
    await propose({ kind: 'wa_message', target: '966500000002@c.us', targetName: 'Ali', payload: { text: 'two' } }, deps);
    const all = listActions({}, deps.now());
    expect(all.map((r) => r.target_name)).toEqual(['Ali', 'Nora']);
    expect(listActions({ status: 'executed' }, deps.now()).map((r) => r.target_name)).toEqual(['Nora']);
    expect(listActions({ target: 'nor' }, deps.now())).toHaveLength(1);
    expect(formatOutboxLine(all[1])).toMatch(/^#\d+ executed · wa_message → Nora · .* · one · id …EF123456$/);
    expect(publicView(all[0])).not.toHaveProperty('code');
  });
});

describe('outbound helpers', () => {
  it('normalises text and hashes deterministically regardless of key order', () => {
    expect(normalizeText('  a  \r\nb\t\n')).toBe('a\nb');
    const h1 = computeHashes('wa_message', NORA, { text: 'x', b: 1 });
    const h2 = computeHashes('wa_message', NORA, { b: 1, text: 'x ' });
    expect(h1.dedupeHash).toBe(h2.dedupeHash);
    expect(computeHashes('wa_message', '966500000002@c.us', { text: 'x', b: 1 }).dedupeHash).not.toBe(h1.dedupeHash);
  });

  it('normalises WhatsApp targets from phone numbers', () => {
    expect(normalizeTarget('wa_message', '+966 50-000-0001')).toBe(NORA);
    expect(normalizeTarget('wa_message', '123@g.us')).toBe('123@g.us');
    expect(normalizeTarget('wa_message', 'Nora')).toBe('Nora');
  });

  it('matches autonomous contacts by chat id or phone digits only', () => {
    expect(isAutonomousContact(NORA, '')).toBe(false);
    expect(isAutonomousContact(NORA, undefined)).toBe(false);
    expect(isAutonomousContact(NORA, '966500000001')).toBe(true);
    expect(isAutonomousContact(NORA, `x@c.us, ${NORA}`)).toBe(true);
    expect(isAutonomousContact(NORA, '966500000001@g.us')).toBe(false);
    expect(isAutonomousContact(NORA, '96650000000')).toBe(false);
  });

  it('allocates approval codes avoiding taken ones', () => {
    const seq = [0, 0, 0, 0, 1, 1, 1, 1];
    const code = generateApprovalCode((c) => c === 'AAAA', () => seq.shift() ?? 2);
    expect(code).toBe('BBBB');
  });

  it('formats receipts', () => {
    const line = formatReceipt({ id: 7, kind: 'wa_message', target: NORA, target_name: 'Nora', payload: JSON.stringify({ text: 'x'.repeat(60) }) } as any,
      { messageId: 'true_x_ABCDEFGH12345678' });
    expect(line).toBe(`Sent to Nora ✓ ${'x'.repeat(40)}… · id …12345678 (#7)`);
  });
});

describe('outbound dashboard routes', () => {
  beforeEach(() => { _initTestDatabase(); ks._reset(); });

  it('GET /api/outbound lists history and POST /api/outbound/decide applies a decision by code', async () => {
    const { deps } = makeDeps();
    const { action } = await propose({ kind: 'wa_message', target: NORA, payload: { text: 'via api' } }, deps);
    const app = new Hono();
    registerOutboundRoutes(app);
    const list = await (await app.request('/api/outbound?limit=5')).json() as any;
    expect(list.actions).toHaveLength(1);
    expect(list.actions[0]).toMatchObject({ id: action.id, status: 'proposed', payload: { text: 'via api' } });
    expect(list.actions[0].code).toBeUndefined();

    const bad = await app.request('/api/outbound?status=bogus');
    expect(bad.status).toBe(400);

    const res = await app.request('/api/outbound/decide', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: action.approval_code, decision: 'reject', via: 'whatsapp' }),
    });
    const body = await res.json() as any;
    expect(body).toMatchObject({ ok: true, notFound: false });
    expect(getAction(action.id)!.status).toBe('rejected');
    expect(getAction(action.id)!.decided_via).toBe('whatsapp');

    const one = await (await app.request(`/api/outbound/${action.id}`)).json() as any;
    expect(one.action.status).toBe('rejected');
  });
});

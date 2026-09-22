/**
 * Gateway execution of email / calendar through the Google executor:
 * approval runs the executor exactly once, cards show every detail,
 * failures (including re-auth) end as failed rows, legacy rows stay
 * approval-only. The executor itself is covered in google-executor.test.ts;
 * the last tests here run the real GoogleClient with mocked HTTP end to end.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { _initTestDatabase, getOutboundDb } from './db.js';
import * as ks from './kill-switches.js';
import {
  propose, decide, complete, getAction, formatProposal, gatewayExecutes, OutboundError, type OutboundDeps,
} from './outbound.js';
import { GoogleClient, GoogleAuthError, type GoogleExecutor } from './google-executor.js';

const ENV_KEYS = ['OUTBOUND_ENABLED', 'OUTBOUND_AUTONOMY_ENABLED', 'OUTBOUND_AUTONOMOUS_CONTACTS', 'OUTBOUND_PROPOSAL_TTL_HOURS'];
const WORK = 'm.ghassan@jisr.net';

function makeDeps(google?: GoogleExecutor) {
  let now = 1_800_000_000;
  let tgId = 500;
  const g = google ?? {
    sendEmail: vi.fn(async () => ({ messageId: '18f00000000abcd1', threadId: 't1', account: WORK, viaDraft: false })),
    calendar: vi.fn(async (p: any) => ({ action: p.action, eventId: 'evt0000abcdef12', htmlLink: 'https://calendar.google.com/event?eid=x', account: WORK, calendarId: 'primary' })),
  };
  const deps = {
    now: () => now,
    waPost: vi.fn(async () => ({ ok: true, messageId: 'x' })),
    notify: vi.fn(async (_t: string, _b?: unknown) => ++tgId),
    clearButtons: vi.fn(async () => {}),
    google: g,
  };
  return { deps: deps as unknown as OutboundDeps & typeof deps, google: g as any, advance: (s: number) => { now += s; } };
}

const email = (over: Record<string, unknown> = {}) => ({
  account: WORK, to: ['Nora@Example.com'], cc: ['boss@example.com'], subject: 'تحديث المشروع', body: 'Hi Nora,\n\nPlease find the update.\n\nThanks', ...over,
});

describe('outbound gateway: email + calendar execution', () => {
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

  it('email proposal card shows account, recipients, subject and the first 300 chars of the body; nothing is sent', async () => {
    const { deps, google } = makeDeps();
    const long = 'A'.repeat(290) + ' tail-that-is-cut ' + 'B'.repeat(200);
    const { action } = await propose({ kind: 'email', target: 'nora@example.com', payload: email({ body: long, bcc: ['x@example.com'] }) }, deps);
    const card = deps.notify.mock.calls[0][0] as string;
    expect(card).toContain('· Email');
    expect(card).toContain(`From: ${WORK}`);
    expect(card).toContain('To: Nora@Example.com');
    expect(card).toContain('Cc: boss@example.com');
    expect(card).toContain('Bcc: x@example.com');
    expect(card).toContain('Subject: تحديث المشروع');
    expect(card).toContain('A'.repeat(290));
    expect(card).not.toContain('B'.repeat(10));
    expect(card).toContain(`first 300 of ${long.length} chars`);
    expect(card).toContain(`YES ${action.approval_code}`);
    expect(deps.notify.mock.calls[0][1]).toEqual({ id: action.id, kind: 'email' });
    expect(google.sendEmail).not.toHaveBeenCalled();
  });

  it('approval sends the stored email exactly once and posts a receipt', async () => {
    const { deps, google } = makeDeps();
    const { action } = await propose({ kind: 'email', target: 'nora@example.com', payload: email() }, deps);
    const [a, b] = await Promise.all([
      decide({ id: action.id, decision: 'approve', via: 'telegram' }, deps),
      decide({ code: action.approval_code, decision: 'approve', via: 'whatsapp' }, deps),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(google.sendEmail).toHaveBeenCalledTimes(1);
    const [payload, key] = google.sendEmail.mock.calls[0];
    expect(payload).toMatchObject({ account: WORK, to: ['Nora@Example.com'], subject: 'تحديث المشروع' });
    expect(key).toBe(action.idempotency_key);
    const row = getAction(action.id)!;
    expect(row.status).toBe('executed');
    expect(JSON.parse(row.receipt!)).toMatchObject({ messageId: '18f00000000abcd1', threadId: 't1' });
    const ok = (a.ok ? a : b).message;
    expect(ok).toBe(`Email sent from m.ghassan@jisr.net to Nora@Example.com, boss@example.com ✓ "تحديث المشروع" · id …000abcd1 (#${action.id})`);
    expect(deps.notify).toHaveBeenLastCalledWith(ok);
    // Later approvals and `complete` do nothing.
    expect((await decide({ id: action.id, decision: 'approve', via: 'telegram' }, deps)).ok).toBe(false);
    expect((await complete(action.id, { ref: 'x' }, deps)).ok).toBe(false);
    expect(google.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('refuses a duplicate email proposal while one is pending', async () => {
    const { deps } = makeDeps();
    await propose({ kind: 'email', target: 'nora@example.com', payload: email() }, deps);
    await expect(propose({ kind: 'email', target: 'nora@example.com', payload: email() }, deps)).rejects.toMatchObject({ code: 'duplicate_pending' });
  });

  it('validates email payloads at proposal time', async () => {
    const { deps } = makeDeps();
    const bad = async (p: Record<string, unknown>, msg: RegExp) => {
      const err = await propose({ kind: 'email', target: 'x', payload: p }, deps).catch((e) => e);
      expect(err).toBeInstanceOf(OutboundError);
      expect(err.code).toBe('bad_payload');
      expect(err.message).toMatch(msg);
    };
    await bad(email({ account: undefined }), /account/);
    await bad(email({ to: ['not-an-email'] }), /invalid email address/);
    await bad(email({ to: [] }), /at least one/);
    await bad(email({ subject: '' }), /subject/);
    await bad(email({ subject: 'a\r\nBcc: evil@x.com' }), /single line/);
    await bad(email({ body: '  ' }), /body/);
    await bad(email({ inReplyTo: 'abc' }), /Message-ID/);
    await bad(email({ draftId: 'r123' }), /draftMessageId/);
  });

  it('a failed send (e.g. re-auth needed) marks the row failed with the reason and does not retry', async () => {
    const google = {
      sendEmail: vi.fn(async () => { throw new GoogleAuthError('Google account m.ghassan@jisr.net needs re-authorising in workspace-mcp (token refresh refused: invalid_grant)'); }),
      calendar: vi.fn(),
    };
    const { deps } = makeDeps(google as any);
    const { action } = await propose({ kind: 'email', target: 'nora@example.com', payload: email() }, deps);
    const r = await decide({ id: action.id, decision: 'approve', via: 'telegram' }, deps);
    expect(r.ok).toBe(false);
    const row = getAction(action.id)!;
    expect(row.status).toBe('failed');
    expect(row.error).toContain('needs re-authorising');
    expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining('needs re-authorising'));
    expect((await decide({ id: action.id, decision: 'approve', via: 'telegram' }, deps)).ok).toBe(false);
    expect(google.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('calendar create card shows title, time, timezone and attendees; approval creates once', async () => {
    const { deps, google } = makeDeps();
    const payload = { account: WORK, action: 'create', summary: 'Q4 review', start: '2026-09-30T10:00', end: '2026-09-30T11:00', attendees: ['nora@example.com', 'ali@example.com'], conference: true };
    const { action } = await propose({ kind: 'calendar', target: 'nora@example.com, ali@example.com', payload }, deps);
    const card = deps.notify.mock.calls[0][0] as string;
    expect(card).toContain('Calendar CREATE event');
    expect(card).toContain(`Account: ${WORK}`);
    expect(card).toContain('Title: Q4 review');
    expect(card).toContain('When: Wed 2026-09-30 10:00 → 11:00 (Asia/Riyadh)');
    expect(card).toContain('Attendees: nora@example.com, ali@example.com');
    expect(card).toContain('Google Meet link: add');
    const r = await decide({ id: action.id, decision: 'approve', via: 'telegram' }, deps);
    expect(r.ok).toBe(true);
    expect(google.calendar).toHaveBeenCalledTimes(1);
    expect(google.calendar.mock.calls[0][0]).toMatchObject({ action: 'create', calendarId: 'primary', timeZone: 'Asia/Riyadh', start: '2026-09-30T10:00:00' });
    expect(r.message).toContain('Calendar event created ✓ "Q4 review"');
    expect(r.message).toContain('https://calendar.google.com/event?eid=x');
    expect((await decide({ id: action.id, decision: 'approve', via: 'whatsapp' }, deps)).ok).toBe(false);
    expect(google.calendar).toHaveBeenCalledTimes(1);
  });

  it('calendar update/cancel cards show the current event; validation rejects bad times', async () => {
    const { deps } = makeDeps();
    const current = { summary: 'Standup', start: '2026-09-30T09:00:00+03:00', end: '2026-09-30T09:15:00+03:00', attendees: ['a@example.com'] };
    const { action: upd } = await propose({ kind: 'calendar', target: WORK, payload: { account: WORK, action: 'update', eventId: 'abc123', start: '2026-09-30T09:30', end: '2026-09-30T09:45', current } }, deps);
    const card = formatProposal(upd);
    expect(card).toContain('UPDATE event');
    expect(card).toContain('Event: Standup · Wed 2026-09-30 09:00+03:00 → 09:15+03:00');
    expect(card).toContain('When: → Wed 2026-09-30 09:30 → 09:45 (Asia/Riyadh)');
    expect(card).toContain('Current attendees: a@example.com');
    const { action: can } = await propose({ kind: 'calendar', target: WORK, payload: { account: WORK, action: 'cancel', eventId: 'abc123', current } }, deps);
    expect(formatProposal(can)).toContain('CANCEL event (attendees get the cancellation email)');

    const bad = (p: Record<string, unknown>) => propose({ kind: 'calendar', target: WORK, payload: { account: WORK, ...p } }, deps);
    await expect(bad({ action: 'create', summary: 'x', start: '2026-09-30T10:00', end: '2026-09-30T09:00' })).rejects.toThrow(/must be after start/);
    await expect(bad({ action: 'create', summary: 'x', start: '2026-09-31T10:00', end: '2026-10-01T09:00' })).rejects.toThrow(/not a real date/);
    await expect(bad({ action: 'create', summary: 'x', start: 'tomorrow 10am', end: '2026-10-01T09:00' })).rejects.toThrow(/must be ISO/);
    await expect(bad({ action: 'create', summary: 'x', start: '2026-09-30T10:00', end: '2026-09-30T11:00', attendees: ['nope'] })).rejects.toThrow(/invalid email/);
    await expect(bad({ action: 'create', summary: 'x', start: '2026-09-30T10:00', end: '2026-09-30T11:00', timeZone: 'Mars/Base' })).rejects.toThrow(/timeZone/);
    await expect(bad({ action: 'update', start: '2026-09-30T10:00', end: '2026-09-30T11:00' })).rejects.toThrow(/event-id/);
    await expect(bad({ action: 'update', eventId: 'abc123' })).rejects.toThrow(/at least one change/);
    await expect(bad({ action: 'cancel', eventId: 'abc123', summary: 'x' })).rejects.toThrow(/cancel takes only/);
  });

  it('email/calendar rows without an account (proposed before the executor) stay approval-only', async () => {
    const { deps, google } = makeDeps();
    const now = deps.now();
    getOutboundDb().prepare(`INSERT INTO outbound_actions (kind, target, target_name, payload, payload_hash, dedupe_hash, idempotency_key, status, approval_code, requested_by_agent, created_at, expires_at)
      VALUES ('email', 'x@example.com', '', '{"text":"old"}', 'h', 'd', 'd', 'proposed', 'QQQQ', 'main', ?, ?)`).run(now, now + 3600);
    const id = Number((getOutboundDb().prepare('SELECT max(id) AS id FROM outbound_actions').get() as any).id);
    expect(gatewayExecutes(getAction(id)!)).toBe(false);
    const r = await decide({ id, decision: 'approve', via: 'telegram' }, deps);
    expect(r.ok).toBe(true);
    expect(getAction(id)!.status).toBe('approved');
    expect(google.sendEmail).not.toHaveBeenCalled();
    expect((await complete(id, { ref: 'gmail-1' }, deps)).ok).toBe(true);
  });
});

// ── End to end with the real GoogleClient and mocked HTTP ────────────

describe('outbound gateway + GoogleClient (mocked HTTP)', () => {
  let dir: string;
  beforeEach(() => {
    _initTestDatabase();
    ks._reset();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcreds-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function writeCreds(expiredSecondsAgo: number) {
    const expiry = new Date(Date.now() - expiredSecondsAgo * 1000).toISOString().replace('Z', '');
    fs.writeFileSync(path.join(dir, `${WORK}.json`), JSON.stringify({
      token: 'old-token', refresh_token: 'rt-1', token_uri: 'https://oauth2.googleapis.com/token',
      client_id: 'cid', client_secret: 'csecret', scopes: ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/calendar'], expiry,
    }));
  }

  it('invalid_grant on refresh -> action failed with "needs re-authorising", no send attempted, file untouched', async () => {
    writeCreds(600);
    const before = fs.readFileSync(path.join(dir, `${WORK}.json`), 'utf-8');
    const fetchMock = vi.fn(async (url: any) => {
      if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }), { status: 400 });
      }
      return new Response('{}', { status: 200 });
    });
    const { deps } = makeDeps(new GoogleClient({ credentialsDir: dir, fetch: fetchMock as any }));
    const { action } = await propose({ kind: 'email', target: 'nora@example.com', payload: email() }, deps);
    const r = await decide({ id: action.id, decision: 'approve', via: 'telegram' }, deps);
    expect(r.ok).toBe(false);
    const row = getAction(action.id)!;
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/m\.ghassan@jisr\.net needs re-authorising.*invalid_grant/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the token endpoint
    expect(fs.readFileSync(path.join(dir, `${WORK}.json`), 'utf-8')).toBe(before);
  });

  it('missing credentials file -> failed, never throws', async () => {
    const fetchMock = vi.fn();
    const { deps } = makeDeps(new GoogleClient({ credentialsDir: dir, fetch: fetchMock as any }));
    const { action } = await propose({ kind: 'calendar', target: WORK, payload: { account: WORK, action: 'cancel', eventId: 'abc123' } }, deps);
    const r = await decide({ id: action.id, decision: 'approve', via: 'telegram' }, deps);
    expect(r.ok).toBe(false);
    expect(getAction(action.id)!.error).toMatch(/needs re-authorising.*no credentials file/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes the token, sends once, and approving again does not call Gmail again', async () => {
    writeCreds(600);
    const fetchMock = vi.fn(async (url: any, init: any) => {
      const u = String(url);
      if (u.startsWith('https://oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'fresh', expires_in: 3599 }), { status: 200 });
      if (u.endsWith('/messages/send')) {
        expect(init.headers.authorization).toBe('Bearer fresh');
        return new Response(JSON.stringify({ id: 'msg-1', threadId: 'thr-1', labelIds: ['SENT'] }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    const { deps } = makeDeps(new GoogleClient({ credentialsDir: dir, fetch: fetchMock as any }));
    const { action } = await propose({ kind: 'email', target: 'nora@example.com', payload: email() }, deps);
    const r = await decide({ id: action.id, decision: 'approve', via: 'telegram' }, deps);
    expect(r.ok).toBe(true);
    await decide({ id: action.id, decision: 'approve', via: 'whatsapp' }, deps);
    const sends = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/messages/send'));
    expect(sends).toHaveLength(1);
    expect(JSON.parse(getAction(action.id)!.receipt!)).toMatchObject({ messageId: 'msg-1', threadId: 'thr-1', viaDraft: false });
  });
});

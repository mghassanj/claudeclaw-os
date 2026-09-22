import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  GoogleClient, GoogleAuthError, GoogleApiError, buildRawEmail, encodeHeaderValue, credentialFileName, parseExpiry,
  validateEmailPayload, validateCalendarPayload, eventIdForKey, formatWhen, base64url,
} from './google-executor.js';

const WORK = 'm.ghassan@jisr.net';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const KEY = 'k'.repeat(64);

type Route = (url: string, init: any) => Response | Promise<Response>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function mockFetch(routes: Array<[RegExp | string, Route]>) {
  return vi.fn(async (url: any, init: any = {}) => {
    const u = String(url);
    for (const [m, r] of routes) {
      if (typeof m === 'string' ? u.startsWith(m) : m.test(`${init.method ?? 'GET'} ${u}`)) return r(u, init);
    }
    throw new Error(`unexpected fetch ${init.method ?? 'GET'} ${u}`);
  });
}

const decodeRaw = (raw: string) => Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

describe('google-executor pure helpers', () => {
  it('encodes non-ASCII subjects as RFC 2047 UTF-8 words that round-trip, each <= 75 chars', () => {
    expect(encodeHeaderValue('Plain subject')).toBe('Plain subject');
    const subject = 'تحديث مشروع الرواتب لشهر سبتمبر — مراجعة نهائية قبل الإطلاق';
    const enc = encodeHeaderValue(subject);
    const words = enc.split('\r\n ');
    expect(words.length).toBeGreaterThan(1);
    for (const w of words) {
      expect(w.length).toBeLessThanOrEqual(75);
      expect(w).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    }
    const decoded = words.map((w) => Buffer.from(w.slice(10, -2), 'base64').toString('utf8')).join('');
    expect(decoded).toBe(subject);
  });

  it('builds a plain-text reply with In-Reply-To/References and CRLF line endings', () => {
    const p = validateEmailPayload({
      account: WORK, to: ['Nora Alharbi <nora@example.com>', 'ali@example.com'], cc: ['نورة <n2@example.com>'], bcc: ['b@example.com'],
      subject: 'Re: الميزانية', body: 'سلام\nline two', threadId: 'thr1', inReplyTo: '<m2@mail.gmail.com>', references: '<m1@mail.gmail.com>',
    });
    const raw = buildRawEmail(p, { date: new Date(Date.UTC(2026, 8, 22, 7, 0, 0)) });
    const [head, body] = raw.split('\r\n\r\n');
    expect(head).toContain('To: "Nora Alharbi" <nora@example.com>, ali@example.com');
    expect(head).toMatch(/^Cc: =\?UTF-8\?B\?[^?]+\?= <n2@example\.com>$/m);
    expect(head).toContain('Bcc: b@example.com');
    expect(head).toContain(`Subject: ${encodeHeaderValue('Re: الميزانية')}`);
    expect(head).toContain('In-Reply-To: <m2@mail.gmail.com>');
    expect(head).toContain('References: <m1@mail.gmail.com> <m2@mail.gmail.com>');
    expect(head).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(head).toContain('Date: Tue, 22 Sep 2026 07:00:00 +0000');
    expect(head).not.toMatch(/^From:/m);
    expect(Buffer.from(body, 'base64').toString('utf8')).toBe('سلام\r\nline two');
    expect(raw.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('builds multipart/alternative when html is given', () => {
    const p = validateEmailPayload({ account: WORK, to: ['a@example.com'], subject: 'Hi', body: 'text', html: '<p>html</p>' });
    const raw = buildRawEmail(p, { boundary: 'BOUND' });
    expect(raw).toContain('Content-Type: multipart/alternative; boundary="BOUND"');
    expect(raw).toContain('--BOUND\r\nContent-Type: text/html; charset="UTF-8"');
    expect(raw.trimEnd().endsWith('--BOUND--')).toBe(true);
  });

  it('uses workspace-mcp file names and naive-UTC expiry', () => {
    expect(credentialFileName('m.ghassan@jisr.net')).toBe('m.ghassan@jisr.net.json');
    expect(credentialFileName('a+b@x.com')).toBe('a%2Bb@x.com.json');
    expect(parseExpiry('2026-09-22T07:00:00.123456')).toBe(Date.UTC(2026, 8, 22, 7, 0, 0, 123));
    expect(parseExpiry('2026-09-22T07:00:00+00:00')).toBe(Date.UTC(2026, 8, 22, 7, 0, 0));
    expect(parseExpiry(null)).toBeNull();
  });

  it('validates calendar payloads and formats times', () => {
    const c = validateCalendarPayload({ account: 'M.Ghassan@Jisr.net', action: 'create', summary: 'x', start: '2026-09-30T10:00', end: '2026-09-30T11:30' });
    expect(c).toMatchObject({ account: WORK, calendarId: 'primary', timeZone: 'Asia/Riyadh', start: '2026-09-30T10:00:00', end: '2026-09-30T11:30:00' });
    expect(() => validateCalendarPayload({ account: WORK, action: 'create', summary: 'x', start: '2026-09-30', end: '2026-09-30T11:00' })).toThrow(/both be dates/);
    expect(() => validateCalendarPayload({ account: WORK, action: 'create', summary: 'x', start: '2026-09-30T10:00+03:00', end: '2026-09-30T11:00' })).toThrow(/same format/);
    expect(() => validateCalendarPayload({ account: WORK, action: 'create', summary: 'x', start: '2026-09-30T10:00' })).toThrow(/both --start and --end/);
    expect(() => validateCalendarPayload({ account: WORK, action: 'move' })).toThrow(/create\|update\|cancel/);
    expect(formatWhen('2026-09-30T10:00:00', '2026-10-01T09:00:00', 'Asia/Riyadh')).toBe('Wed 2026-09-30 10:00 → Thu 2026-10-01 09:00 (Asia/Riyadh)');
    expect(eventIdForKey(KEY)).toMatch(/^[0-9a-v]{40}$/);
  });
});

describe('GoogleClient (mocked HTTP)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gexec-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function writeCreds(over: Record<string, unknown> = {}, account = WORK) {
    const file = path.join(dir, `${account}.json`);
    fs.writeFileSync(file, JSON.stringify({
      token: 'file-token', refresh_token: 'rt', token_uri: TOKEN_URI, client_id: 'cid', client_secret: 'cs',
      scopes: ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/calendar'],
      expiry: new Date(Date.now() + 30 * 60_000).toISOString().replace('Z', ''), ...over,
    }));
    return file;
  }
  const expired = () => ({ expiry: new Date(Date.now() - 60_000).toISOString().replace('Z', '') });

  it('uses the stored token while valid (no refresh call)', async () => {
    writeCreds();
    const f = mockFetch([[/messages\/send$/, (_u, init) => {
      expect(init.headers.authorization).toBe('Bearer file-token');
      return json({ id: 'm1', threadId: 't1' });
    }]]);
    const g = new GoogleClient({ credentialsDir: dir, fetch: f as any });
    const r = await g.sendEmail(validateEmailPayload({ account: WORK, to: ['a@example.com'], subject: 'Hi', body: 'x' }), KEY);
    expect(r).toMatchObject({ messageId: 'm1', threadId: 't1', viaDraft: false });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('refreshes an expired token once, keeps it in memory, never writes the file', async () => {
    const file = writeCreds(expired());
    const before = fs.readFileSync(file, 'utf-8');
    const f = mockFetch([
      [TOKEN_URI, (_u, init) => {
        const form = new URLSearchParams(init.body);
        expect(Object.fromEntries(form)).toEqual({ grant_type: 'refresh_token', refresh_token: 'rt', client_id: 'cid', client_secret: 'cs' });
        return json({ access_token: 'fresh', expires_in: 3599 });
      }],
      [/messages\/send$/, (_u, init) => { expect(init.headers.authorization).toBe('Bearer fresh'); return json({ id: 'm', threadId: 't' }); }],
    ]);
    const g = new GoogleClient({ credentialsDir: dir, fetch: f as any });
    const p = validateEmailPayload({ account: WORK, to: ['a@example.com'], subject: 'Hi', body: 'x' });
    await g.sendEmail(p, KEY);
    await g.sendEmail(p, KEY);
    expect(f.mock.calls.filter(([u]) => String(u) === TOKEN_URI)).toHaveLength(1);
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
  });

  it('retries once with a forced refresh on 401', async () => {
    writeCreds();
    let sends = 0;
    const f = mockFetch([
      [TOKEN_URI, () => json({ access_token: 'fresh', expires_in: 3599 })],
      [/messages\/send$/, (_u, init) => {
        sends++;
        return init.headers.authorization === 'Bearer file-token' ? json({ error: { message: 'bad' } }, 401) : json({ id: 'm2', threadId: 't' });
      }],
    ]);
    const g = new GoogleClient({ credentialsDir: dir, fetch: f as any });
    const r = await g.sendEmail(validateEmailPayload({ account: WORK, to: ['a@example.com'], subject: 'Hi', body: 'x' }), KEY);
    expect(r.messageId).toBe('m2');
    expect(sends).toBe(2);
  });

  it('invalid_grant -> GoogleAuthError "needs re-authorising"', async () => {
    writeCreds(expired());
    const f = mockFetch([[TOKEN_URI, () => json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400)]]);
    const g = new GoogleClient({ credentialsDir: dir, fetch: f as any });
    const err = await g.sendEmail(validateEmailPayload({ account: WORK, to: ['a@example.com'], subject: 'Hi', body: 'x' }), KEY).catch((e) => e);
    expect(err).toBeInstanceOf(GoogleAuthError);
    expect(err.message).toBe('Google account m.ghassan@jisr.net needs re-authorising in workspace-mcp (token refresh refused: invalid_grant - Token has been expired or revoked.)');
  });

  it('missing/invalid files and missing scopes -> GoogleAuthError', async () => {
    const f = mockFetch([]);
    const g = new GoogleClient({ credentialsDir: dir, fetch: f as any });
    await expect(g.accessToken(WORK)).rejects.toThrow(/needs re-authorising.*no credentials file m\.ghassan@jisr\.net\.json/);
    fs.writeFileSync(path.join(dir, `${WORK}.json`), '{not json');
    await expect(g.accessToken(WORK)).rejects.toThrow(/not valid JSON/);
    writeCreds({ scopes: ['https://www.googleapis.com/auth/gmail.readonly'] });
    await expect(g.sendEmail(validateEmailPayload({ account: WORK, to: ['a@example.com'], subject: 'Hi', body: 'x' }), KEY))
      .rejects.toThrow(/needs re-authorising.*gmail\.send/);
    writeCreds({ ...expired(), refresh_token: null });
    await expect(g.accessToken(WORK)).rejects.toBeInstanceOf(GoogleAuthError);
    expect(f).not.toHaveBeenCalled();
  });

  it('raw send: base64url RFC 2822 with an Arabic subject, threadId passed through', async () => {
    writeCreds();
    let sent: any;
    const f = mockFetch([[/messages\/send$/, (_u, init) => { sent = JSON.parse(init.body); return json({ id: 'm3', threadId: 'thr9' }); }]]);
    const g = new GoogleClient({ credentialsDir: dir, fetch: f as any });
    const subject = 'موعد اجتماع الأسبوع القادم';
    await g.sendEmail(validateEmailPayload({ account: WORK, to: ['a@example.com'], subject, body: 'مرحبا', threadId: 'thr9', inReplyTo: '<x@y>' }), KEY);
    expect(sent.threadId).toBe('thr9');
    expect(sent.raw).toMatch(/^[A-Za-z0-9_-]+$/);
    const mime = decodeRaw(sent.raw);
    const subjLine = mime.split('\r\n\r\n')[0].match(/^Subject: ([\s\S]*?)\r\n(?! )/m)![1];
    const decoded = subjLine.split('\r\n ').map((w) => Buffer.from(w.slice(10, -2), 'base64').toString('utf8')).join('');
    expect(decoded).toBe(subject);
    expect(mime).toContain('In-Reply-To: <x@y>');
  });

  it('draft send: sends only if the draft is unchanged since proposal', async () => {
    writeCreds();
    const draft = {
      id: 'r-1', message: {
        id: 'msg-v1', threadId: 'thr-1', snippet: 's',
        payload: {
          mimeType: 'multipart/mixed',
          headers: [{ name: 'To', value: '"Doe, Jane" <jane@example.com>, bob@example.com' }, { name: 'Subject', value: 'Offer' }],
          parts: [
            { mimeType: 'text/plain', body: { data: base64url('Hello Jane') } },
            { mimeType: 'application/pdf', filename: 'offer.pdf', body: { attachmentId: 'a1' } },
          ],
        },
      },
    };
    let draftSends = 0;
    const f = mockFetch([
      [/GET .*\/drafts\/r-1\?format=full$/, () => json(draft)],
      [/POST .*\/drafts\/send$/, (_u, init) => { draftSends++; expect(JSON.parse(init.body)).toEqual({ id: 'r-1' }); return json({ id: 'sent-1', threadId: 'thr-1' }); }],
    ]);
    const g = new GoogleClient({ credentialsDir: dir, fetch: f as any });
    const d = await g.getDraft(WORK, 'r-1');
    expect(d).toMatchObject({ messageId: 'msg-v1', to: ['"Doe, Jane" <jane@example.com>', 'bob@example.com'], subject: 'Offer', body: 'Hello Jane', attachments: 1 });

    const ok = await g.sendEmail(validateEmailPayload({ account: WORK, draftId: 'r-1', draftMessageId: 'msg-v1', to: d.to, subject: d.subject, body: d.body }), KEY);
    expect(ok).toMatchObject({ messageId: 'sent-1', viaDraft: true });
    await expect(g.sendEmail(validateEmailPayload({ account: WORK, draftId: 'r-1', draftMessageId: 'msg-v0' }), KEY))
      .rejects.toThrow(/edited after it was proposed/);
    expect(draftSends).toBe(1);
  });

  it('threadReplyInfo takes Message-ID/References from the last message and subject from the first', async () => {
    writeCreds();
    const f = mockFetch([[/threads\/thr-1\?format=metadata/, () => json({ messages: [
      { payload: { headers: [{ name: 'Subject', value: 'Budget' }, { name: 'Message-ID', value: '<a@x>' }] } },
      { payload: { headers: [{ name: 'Subject', value: 'Re: Budget' }, { name: 'Message-Id', value: '<b@x>' }, { name: 'References', value: '<a@x>' }] } },
    ] })]]);
    const g = new GoogleClient({ credentialsDir: dir, fetch: f as any });
    expect(await g.threadReplyInfo(WORK, 'thr-1')).toEqual({ inReplyTo: '<b@x>', references: '<a@x>', subject: 'Budget' });
  });

  it('calendar create: insert with sendUpdates=all, deterministic id, Meet request, attendee list', async () => {
    writeCreds();
    let body: any; let url = '';
    const f = mockFetch([[/POST .*\/calendars\/primary\/events\?/, (u, init) => {
      url = u; body = JSON.parse(init.body);
      return json({ id: body.id, htmlLink: 'https://www.google.com/calendar/event?eid=abc', hangoutLink: 'https://meet.google.com/x' });
    }]]);
    const g = new GoogleClient({ credentialsDir: dir, fetch: f as any });
    const p = validateCalendarPayload({ account: WORK, action: 'create', summary: 'Review', start: '2026-09-30T10:00', end: '2026-09-30T11:00', attendees: ['A@Example.com'], location: 'HQ', conference: true });
    const r = await g.calendar(p, KEY);
    expect(url).toContain('sendUpdates=all');
    expect(url).toContain('conferenceDataVersion=1');
    expect(body).toMatchObject({
      id: eventIdForKey(KEY), summary: 'Review', location: 'HQ',
      start: { dateTime: '2026-09-30T10:00:00', timeZone: 'Asia/Riyadh' }, end: { dateTime: '2026-09-30T11:00:00', timeZone: 'Asia/Riyadh' },
      attendees: [{ email: 'a@example.com' }],
      conferenceData: { createRequest: { conferenceSolutionKey: { type: 'hangoutsMeet' } } },
    });
    expect(r).toMatchObject({ action: 'create', eventId: eventIdForKey(KEY), htmlLink: 'https://www.google.com/calendar/event?eid=abc', hangoutLink: 'https://meet.google.com/x' });
  });

  it('calendar create retried with the same key returns the existing event (409), not a second one', async () => {
    writeCreds();
    const id = eventIdForKey(KEY);
    const f = mockFetch([
      [/POST .*\/events\?/, () => json({ error: { message: 'The requested identifier already exists.' } }, 409)],
      [new RegExp(`GET .*/events/${id}$`), () => json({ id, summary: 'Review', htmlLink: 'https://cal/x' })],
    ]);
    const g = new GoogleClient({ credentialsDir: dir, fetch: f as any });
    const p = validateCalendarPayload({ account: WORK, action: 'create', summary: 'Review', start: '2026-09-30', end: '2026-10-01' });
    expect(await g.calendar(p, KEY)).toMatchObject({ eventId: id, htmlLink: 'https://cal/x', duplicate: true });
  });

  it('calendar update patches only the given fields; cancel deletes with sendUpdates=all', async () => {
    writeCreds();
    const calls: Array<{ method: string; url: string; body?: any }> = [];
    const f = mockFetch([
      [/PATCH .*\/events\/ev1\?/, (u, init) => { calls.push({ method: 'PATCH', url: u, body: JSON.parse(init.body) }); return json({ id: 'ev1', htmlLink: 'https://cal/ev1' }); }],
      [/DELETE .*\/events\/ev1\?/, (u) => { calls.push({ method: 'DELETE', url: u }); return new Response(null, { status: 204 }); }],
      [/DELETE .*\/events\/gone\?/, () => json({ error: { message: 'Resource has been deleted' } }, 410)],
    ]);
    const g = new GoogleClient({ credentialsDir: dir, fetch: f as any });
    const u = await g.calendar(validateCalendarPayload({ account: WORK, action: 'update', eventId: 'ev1', start: '2026-09-30T12:00', end: '2026-09-30T13:00', timeZone: 'Europe/London' }), KEY);
    expect(calls[0].body).toEqual({ start: { dateTime: '2026-09-30T12:00:00', timeZone: 'Europe/London' }, end: { dateTime: '2026-09-30T13:00:00', timeZone: 'Europe/London' } });
    expect(calls[0].url).toContain('sendUpdates=all');
    expect(u).toMatchObject({ action: 'update', eventId: 'ev1', htmlLink: 'https://cal/ev1' });
    const c = await g.calendar(validateCalendarPayload({ account: WORK, action: 'cancel', eventId: 'ev1' }), KEY);
    expect(calls[1].url).toMatch(/\/events\/ev1\?sendUpdates=all$/);
    expect(c).toMatchObject({ action: 'cancel', eventId: 'ev1' });
    expect(await g.calendar(validateCalendarPayload({ account: WORK, action: 'cancel', eventId: 'gone' }), KEY)).toMatchObject({ alreadyCancelled: true });
  });

  it('API errors surface as GoogleApiError with the status and Google message', async () => {
    writeCreds();
    const f = mockFetch([[/POST .*\/events\?/, () => json({ error: { message: 'Invalid attendee email.' } }, 400)]]);
    const g = new GoogleClient({ credentialsDir: dir, fetch: f as any });
    const err = await g.calendar(validateCalendarPayload({ account: WORK, action: 'create', summary: 'x', start: '2026-09-30T10:00', end: '2026-09-30T11:00' }), KEY).catch((e) => e);
    expect(err).toBeInstanceOf(GoogleApiError);
    expect(err.message).toBe('Calendar events.insert failed: HTTP 400 - Invalid attendee email.');
  });
});

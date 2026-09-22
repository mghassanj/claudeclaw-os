/**
 * Google executor for the outbound gateway: sends approved emails (Gmail)
 * and writes approved calendar events (Google Calendar) as Mohamed.
 *
 * Credentials: the workspace-mcp service owns one OAuth credential file
 * per account, <GOOGLE_CREDENTIALS_DIR>/<url-quoted email>.json, in the
 * google.oauth2.credentials layout (token, refresh_token, token_uri,
 * client_id, client_secret, scopes, expiry as a naive-UTC ISO string).
 * We only READ that file. A refreshed access token is kept in memory and
 * never written back: the MCP owns the file and its refresh cycle.
 *
 * Agents get read + draft tools from the MCP only. This module is the one
 * path that can send mail or write calendar events, and it is only called
 * from outbound.ts after Mohamed approved the exact payload.
 *
 * Nothing here throws past its caller unexplained: a missing/invalid
 * credential file or a refused refresh (invalid_grant) raises
 * GoogleAuthError with a "needs re-authorising" message, which the gateway
 * records as a failed action.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const DEFAULT_GOOGLE_CREDENTIALS_DIR = path.join(os.homedir(), '.config', 'workspace-mcp', 'credentials');
export const DEFAULT_TIME_ZONE = 'Asia/Riyadh';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CALENDAR = 'https://www.googleapis.com/calendar/v3';
const HTTP_TIMEOUT_MS = 30_000;
/** Refresh a little before the recorded expiry. */
const EXPIRY_SKEW_MS = 60_000;

const SCOPE = 'https://www.googleapis.com/auth/';
const SEND_SCOPES = [`${SCOPE}gmail.send`, `${SCOPE}gmail.compose`, `${SCOPE}gmail.modify`, 'https://mail.google.com/'];
const DRAFT_SCOPES = [`${SCOPE}gmail.compose`, `${SCOPE}gmail.modify`, 'https://mail.google.com/'];
const CALENDAR_SCOPES = [`${SCOPE}calendar`, `${SCOPE}calendar.events`];

// ── Errors ───────────────────────────────────────────────────────────

/** The account's stored authorisation is unusable; Mohamed must re-authorise it in workspace-mcp. */
export class GoogleAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleAuthError';
  }
}

export class GoogleApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'GoogleApiError';
  }
}

// ── Validation (pure) ────────────────────────────────────────────────

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const NAME_ADDR_RE = /^\s*"?([^"<>]*?)"?\s*<([^<>\s]+)>\s*$/;
const MSG_ID_RE = /^<[^<>\s]+>$/;
const GOOGLE_ID_RE = /^[A-Za-z0-9_-]{1,256}$/;
const MAX_RECIPIENTS = 50;

export function isEmail(s: string): boolean {
  return EMAIL_RE.test(s) && s.length <= 254;
}

export interface ParsedAddress { name?: string; email: string }

/** "a@b.com" or "Name <a@b.com>"; throws on anything else. */
export function parseAddress(raw: string): ParsedAddress {
  const s = String(raw).trim();
  if (/[\r\n]/.test(s)) throw new Error(`invalid email address "${s.slice(0, 80)}" (line break)`);
  const m = s.match(NAME_ADDR_RE);
  const email = (m ? m[2] : s).trim();
  if (!isEmail(email)) throw new Error(`invalid email address "${s.slice(0, 80)}"`);
  const name = m?.[1]?.trim();
  return name ? { name, email } : { email };
}

function noNewline(label: string, v: string): string {
  if (/[\r\n]/.test(v)) throw new Error(`${label} must be a single line`);
  return v;
}

function optString(p: Record<string, unknown>, key: string): string | undefined {
  const v = p[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new Error(`${key} must be a string`);
  return v;
}

function addressList(p: Record<string, unknown>, key: string): string[] {
  const v = p[key];
  if (v === undefined || v === null) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.map((x) => {
    if (typeof x !== 'string') throw new Error(`${key} entries must be strings`);
    return x.trim();
  }).filter(Boolean).map((x) => { parseAddress(x); return x; });
}

export interface EmailPayload {
  account: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  html?: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  /** Send this existing Gmail draft instead of composing. */
  draftId?: string;
  /** The draft's message id when it was proposed; the send is refused if the draft changed since. */
  draftMessageId?: string;
  /** Display only: number of attachments in the draft. */
  attachments?: number;
}

export function validateAccount(v: unknown): string {
  if (typeof v !== 'string' || !isEmail(v.trim())) throw new Error('account must be the Google account email (e.g. m.ghassan@jisr.net)');
  return v.trim().toLowerCase();
}

/** Validate + normalise an email payload. Throws Error with a readable message. */
export function validateEmailPayload(raw: Record<string, unknown>): EmailPayload {
  const account = validateAccount(raw.account);
  const draftId = optString(raw, 'draftId');
  if (draftId !== undefined && !GOOGLE_ID_RE.test(draftId)) throw new Error('draftId looks invalid');
  const to = addressList(raw, 'to');
  const cc = addressList(raw, 'cc');
  const bcc = addressList(raw, 'bcc');
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) throw new Error(`too many recipients (max ${MAX_RECIPIENTS})`);
  const subject = noNewline('subject', optString(raw, 'subject') ?? '');
  const body = optString(raw, 'body') ?? '';
  const html = optString(raw, 'html');
  const threadId = optString(raw, 'threadId');
  if (threadId !== undefined && !GOOGLE_ID_RE.test(threadId)) throw new Error('threadId looks invalid');
  const inReplyTo = optString(raw, 'inReplyTo');
  if (inReplyTo !== undefined && !MSG_ID_RE.test(inReplyTo.trim())) throw new Error('inReplyTo must be a Message-ID like <abc@mail.gmail.com>');
  const references = optString(raw, 'references');
  if (references !== undefined && !references.trim().split(/\s+/).every((r) => MSG_ID_RE.test(r))) {
    throw new Error('references must be space-separated Message-IDs');
  }
  const draftMessageId = optString(raw, 'draftMessageId');
  const attachments = typeof raw.attachments === 'number' ? raw.attachments : undefined;

  if (!draftId) {
    if (to.length === 0) throw new Error('email needs at least one --to recipient');
    if (!subject.trim()) throw new Error('email needs a subject');
    if (!body.trim() && !html) throw new Error('email needs a body (--text or --text-file)');
    if (draftMessageId) throw new Error('draftMessageId only applies to draft sends');
  } else if (!draftMessageId) {
    throw new Error('draft sends need draftMessageId (the CLI records it when proposing)');
  }
  const out: EmailPayload = { account, to, cc, bcc, subject, body };
  if (html) out.html = html;
  if (threadId) out.threadId = threadId;
  if (inReplyTo) out.inReplyTo = inReplyTo.trim();
  if (references) out.references = references.trim();
  if (draftId) out.draftId = draftId;
  if (draftMessageId) out.draftMessageId = draftMessageId;
  if (attachments !== undefined) out.attachments = attachments;
  return out;
}

export type CalendarAction = 'create' | 'update' | 'cancel';

export interface CalendarPayload {
  account: string;
  action: CalendarAction;
  calendarId: string;
  eventId?: string;
  summary?: string;
  start?: string;
  end?: string;
  timeZone: string;
  attendees?: string[];
  location?: string;
  description?: string;
  conference?: boolean;
  /** Display only: the event as it was when an update/cancel was proposed. */
  current?: { summary?: string; start?: string; end?: string; attendees?: string[] };
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?$/;

interface ParsedTime { allDay: boolean; hasOffset: boolean; ms: number; iso: string }

/** Parse YYYY-MM-DD, YYYY-MM-DDTHH:MM[:SS][Z|±HH:MM]. Naive times are wall-clock in the event's timeZone. */
export function parseEventTime(label: string, v: string): ParsedTime {
  const s = v.trim();
  const d = s.match(DATE_RE);
  if (d) {
    const ms = Date.UTC(+d[1], +d[2] - 1, +d[3]);
    const back = new Date(ms);
    if (back.getUTCMonth() !== +d[2] - 1 || back.getUTCDate() !== +d[3]) throw new Error(`${label} "${s}" is not a real date`);
    return { allDay: true, hasOffset: false, ms, iso: s };
  }
  const t = s.match(DATETIME_RE);
  if (!t) throw new Error(`${label} "${s}" must be ISO like 2026-09-30T10:00 (or 2026-09-30 for all-day)`);
  const [, y, mo, da, h, mi, se = '00', off] = t;
  if (+h > 23 || +mi > 59 || +se > 59) throw new Error(`${label} "${s}" has an invalid time`);
  const wall = Date.UTC(+y, +mo - 1, +da, +h, +mi, +se);
  const back = new Date(wall);
  if (back.getUTCMonth() !== +mo - 1 || back.getUTCDate() !== +da) throw new Error(`${label} "${s}" is not a real date`);
  const iso = `${y}-${mo}-${da}T${h}:${mi}:${se}${off ?? ''}`;
  return { allDay: false, hasOffset: !!off, ms: off ? Date.parse(iso) : wall, iso };
}

function validTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

export function validateCalendarPayload(raw: Record<string, unknown>): CalendarPayload {
  const account = validateAccount(raw.account);
  const action = raw.action;
  if (action !== 'create' && action !== 'update' && action !== 'cancel') throw new Error('calendar action must be create|update|cancel');
  const calendarId = optString(raw, 'calendarId') ?? 'primary';
  if (calendarId !== 'primary' && !isEmail(calendarId) && !/^[A-Za-z0-9._@-]{1,256}$/.test(calendarId)) throw new Error('calendarId looks invalid');
  const eventId = optString(raw, 'eventId');
  if (eventId !== undefined && !/^[A-Za-z0-9_-]{1,1024}$/.test(eventId)) throw new Error('eventId looks invalid');
  const timeZone = optString(raw, 'timeZone') ?? DEFAULT_TIME_ZONE;
  if (!validTimeZone(timeZone)) throw new Error(`unknown timeZone "${timeZone}"`);
  const summary = optString(raw, 'summary');
  if (summary !== undefined) noNewline('summary', summary);
  const location = optString(raw, 'location');
  const description = optString(raw, 'description');
  const start = optString(raw, 'start');
  const end = optString(raw, 'end');
  const attendeesRaw = raw.attendees;
  const attendees = attendeesRaw === undefined ? undefined : addressList(raw, 'attendees').map((a) => parseAddress(a).email.toLowerCase());
  if (attendees && attendees.length > MAX_RECIPIENTS) throw new Error(`too many attendees (max ${MAX_RECIPIENTS})`);
  if (raw.conference !== undefined && typeof raw.conference !== 'boolean') throw new Error('conference must be true/false');
  const conference = raw.conference === true ? true : undefined;

  const out: CalendarPayload = { account, action, calendarId, timeZone };
  if (eventId) out.eventId = eventId;

  if ((start === undefined) !== (end === undefined)) throw new Error('give both --start and --end');
  if (start !== undefined && end !== undefined) {
    const s = parseEventTime('start', start);
    const e = parseEventTime('end', end);
    if (s.allDay !== e.allDay) throw new Error('start and end must both be dates (all-day) or both date-times');
    if (s.hasOffset !== e.hasOffset) throw new Error('start and end must use the same format (both with or both without a UTC offset)');
    if (e.ms <= s.ms) throw new Error(`end (${end}) must be after start (${start})${s.allDay ? '; all-day end dates are exclusive' : ''}`);
    out.start = s.iso;
    out.end = e.iso;
  }

  if (action === 'create') {
    if (eventId) throw new Error('create takes no eventId');
    if (!summary?.trim()) throw new Error('calendar create needs --summary');
    if (!out.start) throw new Error('calendar create needs --start and --end');
  } else {
    if (!eventId) throw new Error(`calendar ${action} needs --event-id`);
  }
  if (action === 'cancel') {
    if (summary || out.start || attendees || location || description || conference) {
      throw new Error('calendar cancel takes only --event-id (and --calendar)');
    }
  } else {
    if (summary !== undefined) out.summary = summary;
    if (attendees !== undefined) out.attendees = attendees;
    if (location !== undefined) out.location = location;
    if (description !== undefined) out.description = description;
    if (conference) out.conference = true;
    if (action === 'update' && out.summary === undefined && !out.start && !out.attendees && out.location === undefined && out.description === undefined && !out.conference) {
      throw new Error('calendar update needs at least one change (--summary/--start+--end/--attendee/--location/--description/--conference)');
    }
  }
  const cur = raw.current;
  if (cur && typeof cur === 'object') {
    const c = cur as Record<string, unknown>;
    out.current = {
      ...(typeof c.summary === 'string' ? { summary: c.summary } : {}),
      ...(typeof c.start === 'string' ? { start: c.start } : {}),
      ...(typeof c.end === 'string' ? { end: c.end } : {}),
      ...(Array.isArray(c.attendees) ? { attendees: c.attendees.filter((x): x is string => typeof x === 'string') } : {}),
    };
  }
  return out;
}

// ── RFC 2822 message building (pure) ─────────────────────────────────

export function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * RFC 2047 encoded-word(s) for a header value. ASCII passes through; any
 * non-ASCII text becomes =?UTF-8?B?...?= words of at most 75 chars each,
 * split on code-point boundaries so no UTF-8 sequence is cut.
 */
export function encodeHeaderValue(s: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const words: string[] = [];
  let chunk = '';
  for (const ch of s) {
    // 45 bytes -> 60 base64 chars; + 12 for "=?UTF-8?B?" and "?=" = 72 <= 75.
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) { words.push(chunk); chunk = ''; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}

function formatAddress(raw: string): string {
  const a = parseAddress(raw);
  if (!a.name) return a.email;
  // eslint-disable-next-line no-control-regex
  const ascii = /^[\x20-\x7e]*$/.test(a.name);
  const name = ascii ? `"${a.name.replace(/["\\]/g, '\\$&')}"` : encodeHeaderValue(a.name);
  return `${name} <${a.email}>`;
}

function wrapBase64(buf: Buffer): string {
  return (buf.toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
}

/** Build the RFC 2822 message (CRLF line endings) for a composed email. */
export function buildRawEmail(p: EmailPayload, opts: { boundary?: string; date?: Date } = {}): string {
  const headers: string[] = [];
  // No From header: Gmail sets it to the authenticated account (with its display name).
  headers.push(`To: ${p.to.map(formatAddress).join(', ')}`);
  if (p.cc.length) headers.push(`Cc: ${p.cc.map(formatAddress).join(', ')}`);
  if (p.bcc.length) headers.push(`Bcc: ${p.bcc.map(formatAddress).join(', ')}`);
  headers.push(`Subject: ${encodeHeaderValue(p.subject)}`);
  headers.push(`Date: ${(opts.date ?? new Date()).toUTCString().replace('GMT', '+0000')}`);
  if (p.inReplyTo) {
    headers.push(`In-Reply-To: ${p.inReplyTo}`);
    const refs = (p.references ?? '').split(/\s+/).filter(Boolean);
    if (!refs.includes(p.inReplyTo)) refs.push(p.inReplyTo);
    headers.push(`References: ${refs.join(' ')}`);
  } else if (p.references) {
    headers.push(`References: ${p.references}`);
  }
  headers.push('MIME-Version: 1.0');
  const text = p.body.replace(/\r?\n/g, '\r\n');
  if (!p.html) {
    headers.push('Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64');
    return `${headers.join('\r\n')}\r\n\r\n${wrapBase64(Buffer.from(text, 'utf8'))}\r\n`;
  }
  const boundary = opts.boundary ?? `cc_${crypto.randomBytes(12).toString('hex')}`;
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  return [
    headers.join('\r\n'), '',
    `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '',
    wrapBase64(Buffer.from(text, 'utf8')),
    `--${boundary}`, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '',
    wrapBase64(Buffer.from(p.html, 'utf8')),
    `--${boundary}--`, '',
  ].join('\r\n');
}

/** Google Calendar event id derived from the gateway idempotency key (base32hex: 0-9a-v). */
export function eventIdForKey(idempotencyKey: string): string {
  return crypto.createHash('sha256').update(`calendar:${idempotencyKey}`).digest('hex').slice(0, 40);
}

function calTime(v: string, timeZone: string): Record<string, string> {
  return DATE_RE.test(v) ? { date: v } : { dateTime: v, timeZone };
}

function eventBody(p: CalendarPayload, idempotencyKey: string): Record<string, unknown> {
  const b: Record<string, unknown> = {};
  if (p.summary !== undefined) b.summary = p.summary;
  if (p.start && p.end) { b.start = calTime(p.start, p.timeZone); b.end = calTime(p.end, p.timeZone); }
  if (p.attendees) b.attendees = p.attendees.map((email) => ({ email }));
  if (p.location !== undefined) b.location = p.location;
  if (p.description !== undefined) b.description = p.description;
  if (p.conference) {
    b.conferenceData = { createRequest: { requestId: eventIdForKey(idempotencyKey).slice(0, 32), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
  }
  return b;
}

// ── Credentials ──────────────────────────────────────────────────────

interface StoredCredentials {
  token?: string | null;
  refresh_token?: string | null;
  token_uri?: string | null;
  client_id?: string | null;
  client_secret?: string | null;
  scopes?: string[] | null;
  expiry?: string | null;
}

/** Same file name workspace-mcp uses: urllib.parse.quote(email, safe="@._-") + ".json". */
export function credentialFileName(account: string): string {
  const quoted = Array.from(Buffer.from(account, 'utf8')).map((b) => {
    const c = String.fromCharCode(b);
    return /[A-Za-z0-9@._~-]/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }).join('');
  return `${quoted}.json`;
}

/** Parse workspace-mcp's expiry (naive ISO = UTC) to epoch ms. */
export function parseExpiry(v: string | null | undefined): number | null {
  if (!v) return null;
  const s = /[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? v : `${v}Z`;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

export interface GoogleClientOptions {
  credentialsDir?: string;
  fetch?: typeof fetch;
  now?: () => number; // epoch ms
}

export interface EmailReceipt { messageId: string; threadId: string | null; account: string; viaDraft: boolean; labelIds?: string[] }
export interface CalendarReceipt { action: CalendarAction; eventId: string; htmlLink: string | null; hangoutLink?: string | null; account: string; calendarId: string; duplicate?: boolean; alreadyCancelled?: boolean }

export interface DraftSummary {
  draftId: string;
  messageId: string;
  threadId: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  attachments: number;
}

export interface ThreadReplyInfo { inReplyTo?: string; references?: string; subject?: string }

export interface EventSummary { id: string; summary?: string; start?: string; end?: string; attendees?: string[]; htmlLink?: string; status?: string }

export interface GoogleExecutor {
  sendEmail(p: EmailPayload, idempotencyKey: string): Promise<EmailReceipt>;
  calendar(p: CalendarPayload, idempotencyKey: string): Promise<CalendarReceipt>;
}

function splitAddresses(v: string | undefined): string[] {
  if (!v) return [];
  // Commas inside quoted display names are rare in Gmail's own headers; split on commas outside quotes.
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (const ch of v) {
    if (ch === '"') q = !q;
    if (ch === ',' && !q) { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function header(headers: Array<{ name: string; value: string }> | undefined, name: string): string | undefined {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

interface GmailPart { mimeType?: string; filename?: string; body?: { data?: string; attachmentId?: string }; parts?: GmailPart[]; headers?: Array<{ name: string; value: string }> }

function walkParts(p: GmailPart | undefined, visit: (p: GmailPart) => void): void {
  if (!p) return;
  visit(p);
  for (const c of p.parts ?? []) walkParts(c, visit);
}

export class GoogleClient implements GoogleExecutor {
  private readonly dir: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  /** account -> in-memory access token, tied to the refresh token it came from. */
  private readonly tokens = new Map<string, { token: string; expiresAt: number; refreshToken: string }>();

  constructor(opts: GoogleClientOptions = {}) {
    this.dir = opts.credentialsDir || DEFAULT_GOOGLE_CREDENTIALS_DIR;
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  credentialPath(account: string): string {
    const p = path.resolve(this.dir, credentialFileName(account));
    if (path.dirname(p) !== path.resolve(this.dir)) throw new GoogleAuthError(`refusing credential path outside ${this.dir}`);
    return p;
  }

  private reauth(account: string, why: string): GoogleAuthError {
    return new GoogleAuthError(`Google account ${account} needs re-authorising in workspace-mcp (${why})`);
  }

  private readCredentials(account: string): StoredCredentials {
    const file = this.credentialPath(account);
    let text: string;
    try { text = fs.readFileSync(file, 'utf-8'); } catch {
      throw this.reauth(account, `no credentials file ${path.basename(file)} in ${this.dir}`);
    }
    let data: StoredCredentials;
    try { data = JSON.parse(text) as StoredCredentials; } catch {
      throw this.reauth(account, 'credentials file is not valid JSON');
    }
    if (!data || typeof data !== 'object') throw this.reauth(account, 'credentials file is empty');
    return data;
  }

  private checkScopes(account: string, creds: StoredCredentials, anyOf: string[], what: string): void {
    if (!Array.isArray(creds.scopes) || creds.scopes.length === 0) return; // unknown: let Google decide
    if (!creds.scopes.some((s) => anyOf.includes(s))) {
      throw this.reauth(account, `granted scopes do not allow ${what}; needs one of ${anyOf.map((s) => s.replace(SCOPE, '')).join(', ')}`);
    }
  }

  /** A usable access token for the account, refreshing (in memory only) when expired. */
  async accessToken(account: string, opts: { forceRefresh?: boolean; scopes?: string[]; what?: string } = {}): Promise<string> {
    const creds = this.readCredentials(account);
    if (opts.scopes) this.checkScopes(account, creds, opts.scopes, opts.what ?? 'this action');
    const now = this.now();
    const refreshToken = creds.refresh_token ?? '';
    const cached = this.tokens.get(account);
    if (!opts.forceRefresh && cached && cached.refreshToken === refreshToken && cached.expiresAt - EXPIRY_SKEW_MS > now) {
      return cached.token;
    }
    const fileExpiry = parseExpiry(creds.expiry);
    if (!opts.forceRefresh && creds.token && fileExpiry !== null && fileExpiry - EXPIRY_SKEW_MS > now) {
      return creds.token;
    }
    if (!refreshToken) throw this.reauth(account, 'access token expired and no refresh_token is stored');
    if (!creds.token_uri || !creds.client_id || !creds.client_secret) {
      throw this.reauth(account, 'credentials file lacks token_uri/client_id/client_secret');
    }
    let res: Response;
    try {
      res = await this.fetchImpl(creds.token_uri, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: creds.client_id,
          client_secret: creds.client_secret,
        }).toString(),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (err: any) {
      throw new Error(`Google token refresh for ${account} failed: ${err?.message ?? err}`);
    }
    const data = await res.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !data.access_token) {
      const code = data.error ?? `HTTP ${res.status}`;
      if (res.status === 400 || res.status === 401 || data.error === 'invalid_grant' || data.error === 'invalid_client' || data.error === 'unauthorized_client') {
        throw this.reauth(account, `token refresh refused: ${code}${data.error_description ? ` - ${data.error_description}` : ''}`);
      }
      throw new Error(`Google token refresh for ${account} failed: ${code}`);
    }
    const expiresAt = now + (Number(data.expires_in) > 0 ? Number(data.expires_in) : 3600) * 1000;
    this.tokens.set(account, { token: data.access_token, expiresAt, refreshToken });
    return data.access_token;
  }

  /** Authenticated JSON call; on 401 refreshes once and retries. */
  async api(account: string, method: string, url: string, body: unknown, auth: { scopes: string[]; what: string }): Promise<{ status: number; data: any }> {
    let token = await this.accessToken(account, auth);
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
      } catch (err: any) {
        throw new Error(`Google API ${method} ${new URL(url).pathname} failed: ${err?.message ?? err}`);
      }
      if (res.status === 401 && attempt === 0) {
        this.tokens.delete(account);
        token = await this.accessToken(account, { ...auth, forceRefresh: true });
        continue;
      }
      const text = await res.text().catch(() => '');
      let data: any = {};
      try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 300) }; }
      return { status: res.status, data };
    }
  }

  private fail(what: string, status: number, data: any, account: string): never {
    const msg = data?.error?.message ?? data?.error_description ?? data?.raw ?? '';
    if (status === 401) throw this.reauth(account, `${what}: Google says unauthorised`);
    if (status === 403 && /insufficient|scope/i.test(String(msg))) throw this.reauth(account, `${what}: ${msg}`);
    throw new GoogleApiError(`${what} failed: HTTP ${status}${msg ? ` - ${String(msg).slice(0, 300)}` : ''}`, status);
  }

  // ── Gmail ──

  async getDraft(account: string, draftId: string): Promise<DraftSummary> {
    const { status, data } = await this.api(account, 'GET', `${GMAIL}/drafts/${encodeURIComponent(draftId)}?format=full`, undefined,
      { scopes: DRAFT_SCOPES, what: 'reading drafts' });
    if (status === 404) throw new GoogleApiError(`Gmail draft ${draftId} not found in ${account} (already sent or deleted?)`, 404);
    if (status !== 200) this.fail('Gmail drafts.get', status, data, account);
    const msg = data?.message ?? {};
    const headers = msg.payload?.headers as Array<{ name: string; value: string }> | undefined;
    let plain = '';
    let html = '';
    let attachments = 0;
    walkParts(msg.payload as GmailPart | undefined, (p) => {
      if (p.filename) { attachments++; return; }
      if (p.mimeType === 'text/plain' && p.body?.data && !plain) plain = fromBase64url(p.body.data).toString('utf8');
      if (p.mimeType === 'text/html' && p.body?.data && !html) html = fromBase64url(p.body.data).toString('utf8');
    });
    const body = plain || html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim() || String(msg.snippet ?? '');
    return {
      draftId: String(data.id ?? draftId),
      messageId: String(msg.id ?? ''),
      threadId: msg.threadId ?? null,
      to: splitAddresses(header(headers, 'To')),
      cc: splitAddresses(header(headers, 'Cc')),
      bcc: splitAddresses(header(headers, 'Bcc')),
      subject: header(headers, 'Subject') ?? '',
      body,
      attachments,
    };
  }

  /** In-Reply-To / References / subject for replying to the last message of a thread. */
  async threadReplyInfo(account: string, threadId: string): Promise<ThreadReplyInfo> {
    const q = 'format=metadata&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Subject';
    const { status, data } = await this.api(account, 'GET', `${GMAIL}/threads/${encodeURIComponent(threadId)}?${q}`, undefined,
      { scopes: [...DRAFT_SCOPES, `${SCOPE}gmail.readonly`], what: 'reading the thread' });
    if (status === 404) throw new GoogleApiError(`Gmail thread ${threadId} not found in ${account}`, 404);
    if (status !== 200) this.fail('Gmail threads.get', status, data, account);
    const msgs = (data?.messages ?? []) as Array<{ payload?: { headers?: Array<{ name: string; value: string }> } }>;
    const last = msgs[msgs.length - 1];
    const h = last?.payload?.headers;
    const mid = header(h, 'Message-ID') ?? header(h, 'Message-Id');
    const refs = header(h, 'References');
    const subject = header(msgs[0]?.payload?.headers, 'Subject');
    return {
      ...(mid && MSG_ID_RE.test(mid.trim()) ? { inReplyTo: mid.trim() } : {}),
      ...(refs ? { references: refs.trim().split(/\s+/).filter((r) => MSG_ID_RE.test(r)).join(' ') || undefined } : {}),
      ...(subject ? { subject } : {}),
    };
  }

  async sendEmail(p: EmailPayload, _idempotencyKey: string): Promise<EmailReceipt> {
    if (p.draftId) {
      // The agent can edit drafts; send only the version Mohamed approved.
      const current = await this.getDraft(p.account, p.draftId);
      if (p.draftMessageId && current.messageId !== p.draftMessageId) {
        throw new Error(`Gmail draft ${p.draftId} was edited after it was proposed; nothing sent. Propose it again.`);
      }
      const { status, data } = await this.api(p.account, 'POST', `${GMAIL}/drafts/send`, { id: p.draftId },
        { scopes: DRAFT_SCOPES, what: 'sending drafts' });
      if (status !== 200) this.fail('Gmail drafts.send', status, data, p.account);
      return { messageId: String(data.id), threadId: data.threadId ?? null, account: p.account, viaDraft: true, labelIds: data.labelIds };
    }
    const raw = base64url(buildRawEmail(p));
    const { status, data } = await this.api(p.account, 'POST', `${GMAIL}/messages/send`,
      { raw, ...(p.threadId ? { threadId: p.threadId } : {}) },
      { scopes: SEND_SCOPES, what: 'sending email' });
    if (status !== 200) this.fail('Gmail messages.send', status, data, p.account);
    return { messageId: String(data.id), threadId: data.threadId ?? null, account: p.account, viaDraft: false, labelIds: data.labelIds };
  }

  // ── Calendar ──

  private eventsUrl(p: { calendarId: string }, eventId?: string, query = ''): string {
    const base = `${CALENDAR}/calendars/${encodeURIComponent(p.calendarId)}/events`;
    return `${base}${eventId ? `/${encodeURIComponent(eventId)}` : ''}${query ? `?${query}` : ''}`;
  }

  async getEvent(account: string, calendarId: string, eventId: string): Promise<EventSummary> {
    const { status, data } = await this.api(account, 'GET', this.eventsUrl({ calendarId }, eventId), undefined,
      { scopes: [...CALENDAR_SCOPES, `${SCOPE}calendar.readonly`], what: 'reading calendar events' });
    if (status === 404 || status === 410) throw new GoogleApiError(`calendar event ${eventId} not found in ${calendarId} (${account})`, status);
    if (status !== 200) this.fail('Calendar events.get', status, data, account);
    return summarizeEvent(data);
  }

  async calendar(p: CalendarPayload, idempotencyKey: string): Promise<CalendarReceipt> {
    const auth = { scopes: CALENDAR_SCOPES, what: 'writing calendar events' };
    const base = { action: p.action, account: p.account, calendarId: p.calendarId };
    if (p.action === 'create') {
      const id = eventIdForKey(idempotencyKey);
      const { status, data } = await this.api(p.account, 'POST', this.eventsUrl(p, undefined, 'sendUpdates=all&conferenceDataVersion=1'),
        { id, ...eventBody(p, idempotencyKey) }, auth);
      if (status === 409) {
        // Already created by an earlier attempt with this key: report that event, don't create another.
        const existing = await this.getEvent(p.account, p.calendarId, id);
        return { ...base, eventId: existing.id, htmlLink: existing.htmlLink ?? null, duplicate: true };
      }
      if (status !== 200) this.fail('Calendar events.insert', status, data, p.account);
      return { ...base, eventId: String(data.id), htmlLink: data.htmlLink ?? null, hangoutLink: data.hangoutLink ?? null };
    }
    if (p.action === 'update') {
      const { status, data } = await this.api(p.account, 'PATCH', this.eventsUrl(p, p.eventId, 'sendUpdates=all&conferenceDataVersion=1'),
        eventBody(p, idempotencyKey), auth);
      if (status !== 200) this.fail('Calendar events.patch', status, data, p.account);
      return { ...base, eventId: String(data.id ?? p.eventId), htmlLink: data.htmlLink ?? null, hangoutLink: data.hangoutLink ?? null };
    }
    const { status, data } = await this.api(p.account, 'DELETE', this.eventsUrl(p, p.eventId, 'sendUpdates=all'), undefined, auth);
    if (status === 410) return { ...base, eventId: p.eventId!, htmlLink: null, alreadyCancelled: true };
    if (status !== 204 && status !== 200) this.fail('Calendar events.delete', status, data, p.account);
    return { ...base, eventId: p.eventId!, htmlLink: null };
  }
}

function summarizeEvent(data: any): EventSummary {
  const t = (x: any): string | undefined => x?.dateTime ?? x?.date ?? undefined;
  return {
    id: String(data?.id ?? ''),
    ...(data?.summary ? { summary: String(data.summary) } : {}),
    ...(t(data?.start) ? { start: t(data.start) } : {}),
    ...(t(data?.end) ? { end: t(data.end) } : {}),
    ...(Array.isArray(data?.attendees) ? { attendees: data.attendees.map((a: any) => String(a.email ?? '')).filter(Boolean) } : {}),
    ...(data?.htmlLink ? { htmlLink: String(data.htmlLink) } : {}),
    ...(data?.status ? { status: String(data.status) } : {}),
  };
}

// ── Display helpers (pure) ───────────────────────────────────────────

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Wed 2026-09-30 10:00 → 11:00 (Asia/Riyadh)" */
export function formatWhen(start: string | undefined, end: string | undefined, timeZone: string): string {
  if (!start) return '(unchanged)';
  const day = (s: string) => {
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? WEEKDAYS[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()] : '';
  };
  const show = (s: string) => s.replace('T', ' ').replace(/:00(?=$|Z|[+-]\d{2}:\d{2}$)/, '');
  if (DATE_RE.test(start)) return `${day(start)} ${start}${end ? ` → ${end} (all-day, end exclusive)` : ''}`;
  const sameDay = end && end.slice(0, 10) === start.slice(0, 10);
  const endShown = end ? (sameDay ? show(end).slice(11) : `${day(end)} ${show(end)}`) : '';
  return `${day(start)} ${show(start)}${endShown ? ` → ${endShown}` : ''} (${timeZone})`;
}

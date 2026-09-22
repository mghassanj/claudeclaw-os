/**
 * Outbound gateway: every action an agent takes on Mohamed's behalf
 * towards a third party (WhatsApp as him, email, calendar invite, Jira /
 * Slack post, revoke/delete) goes through here.
 *
 *   propose  -> row in outbound_actions (status=proposed) + Telegram card
 *               with ✅ / ❌ buttons + a 4-char code for "YES <code>" in the
 *               WhatsApp self-chat.
 *   approve  -> atomic proposed->approved flip, then the EXACT stored payload
 *               is executed once (wa_message / revoke via the WhatsApp
 *               service's token-gated /send-as-me and /revoke-as-me).
 *   receipt  -> stored on the row and posted to Telegram as one line.
 *
 * Why (2026-09-21, "reply to Nora"): two parallel turns each sent the same
 * reply by scripting WhatsApp Web, one revoked the other's copy without
 * asking, and nothing recorded what had been sent. Confirmation was up to
 * the model. Here it is enforced by code: the agent can only propose.
 *
 * Idempotency: dedupe_hash = sha256(kind \n target \n canonical payload).
 * A proposal is refused while an identical one is pending, or was executed
 * in the last DUPLICATE_WINDOW_SEC, unless forced. idempotency_key is the
 * dedupe hash (suffixed ~n for sanctioned repeats) and is also passed to
 * the WhatsApp service, which refuses to send the same key twice.
 *
 * email and calendar are executed here too, through src/google-executor.ts
 * (Gmail send / draft send, Calendar insert / patch / delete with
 * sendUpdates=all), using the workspace-mcp OAuth credentials of the
 * account named in the payload. Agents only have read + draft Google
 * tools, so this is the only path that sends mail or invites people.
 *
 * Kinds without an executor (jira, slack, other) are approval-only:
 * approval flips the row to `approved`, the agent performs the action
 * itself and records the result with `outbound-cli complete`.
 */
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

import { getOutboundDb } from './db.js';
import {
  GoogleClient, formatWhen, validateCalendarPayload, validateEmailPayload, type GoogleExecutor,
} from './google-executor.js';
import { isEnabled } from './kill-switches.js';
import { logger } from './logger.js';

export const OUTBOUND_KINDS = ['wa_message', 'email', 'calendar', 'jira', 'slack', 'revoke', 'other'] as const;
export type OutboundKind = typeof OUTBOUND_KINDS[number];
export type OutboundStatus = 'proposed' | 'approved' | 'rejected' | 'executed' | 'failed' | 'expired';

/** Kinds the gateway executes itself after approval. */
export const EXECUTABLE_KINDS: ReadonlySet<OutboundKind> = new Set(['wa_message', 'revoke', 'email', 'calendar']);
const GOOGLE_KINDS: ReadonlySet<OutboundKind> = new Set(['email', 'calendar']);
/** Kinds that can never run without an explicit approval (autonomy never applies). */
const ALWAYS_APPROVE_KINDS: ReadonlySet<OutboundKind> = new Set(['revoke', 'email', 'calendar', 'jira', 'slack', 'other']);

export const DUPLICATE_WINDOW_SEC = 10 * 60;
const DEFAULT_TTL_HOURS = 24;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

export interface OutboundAction {
  id: number;
  kind: OutboundKind;
  target: string;
  target_name: string;
  payload: string;
  payload_hash: string;
  dedupe_hash: string;
  idempotency_key: string;
  status: OutboundStatus;
  approval_code: string;
  requested_by_agent: string;
  session_ref: string | null;
  turn_ref: string | null;
  forced: number;
  created_at: number;
  expires_at: number;
  decided_at: number | null;
  decided_via: string | null;
  executed_at: number | null;
  receipt: string | null;
  error: string | null;
  tg_message_id: number | null;
}

export class OutboundError extends Error {
  constructor(message: string, public readonly code: string, public readonly existing?: OutboundAction) {
    super(message);
    this.name = 'OutboundError';
  }
}

// ── Environment ──────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let _envCache: { at: number; values: Record<string, string> } | null = null;

/**
 * process.env first, then PROJECT_ROOT/.env (not cwd/.env: the CLI is run
 * by agents from their own working directory). Cached briefly.
 */
export function outboundEnv(key: string): string | undefined {
  if (process.env[key] !== undefined) return process.env[key];
  const now = Date.now();
  if (!_envCache || now - _envCache.at > 1500) {
    const values: Record<string, string> = {};
    try {
      for (const line of fs.readFileSync(path.join(PROJECT_ROOT, '.env'), 'utf-8').split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq === -1) continue;
        let v = t.slice(eq + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        values[t.slice(0, eq).trim()] = v;
      }
    } catch { /* no .env */ }
    _envCache = { at: now, values };
  }
  const v = _envCache.values[key];
  return v === '' ? undefined : v;
}

// ── Pure helpers ─────────────────────────────────────────────────────

/** Normalise message text so cosmetic whitespace differences hash the same. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .split('\n').map((l) => l.replace(/[ \t]+$/g, '')).join('\n')
    .trim();
}

function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val === undefined) continue;
      out[k] = canonicalize(val);
    }
    return out;
  }
  if (typeof v === 'string') return normalizeText(v);
  return v;
}

/** Deterministic JSON: sorted keys, normalised strings. */
export function canonicalPayload(payload: Record<string, unknown>): string {
  return JSON.stringify(canonicalize(payload));
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export function normalizeTarget(kind: OutboundKind, target: string): string {
  const t = target.trim();
  if (kind === 'wa_message' || kind === 'revoke') {
    if (/@(c\.us|g\.us|lid|s\.whatsapp\.net)$/i.test(t)) return t;
    const digits = t.replace(/[^\d]/g, '');
    if (digits.length >= 7 && /^[+\d\s()-]+$/.test(t)) return `${digits}@c.us`;
  }
  if (kind === 'email') return t.toLowerCase();
  return t;
}

export function computeHashes(kind: OutboundKind, target: string, payload: Record<string, unknown>): {
  canonical: string; payloadHash: string; dedupeHash: string;
} {
  const canonical = canonicalPayload(payload);
  return {
    canonical,
    payloadHash: sha256(canonical),
    dedupeHash: sha256(`${kind}\n${target}\n${canonical}`),
  };
}

export function generateApprovalCode(isTaken: (code: string) => boolean, rand = crypto.randomInt): string {
  for (let attempt = 0; attempt < 200; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[rand(CODE_ALPHABET.length)];
    if (!isTaken(code)) return code;
  }
  throw new OutboundError('could not allocate a free approval code', 'code_exhausted');
}

/** Comma list of chat ids / phone numbers that may be messaged without approval. */
export function isAutonomousContact(target: string, list: string | undefined): boolean {
  if (!list) return false;
  const tUser = target.split('@')[0].replace(/[^\d]/g, '');
  for (const raw of list.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (raw === target) return true;
    const digits = raw.split('@')[0].replace(/[^\d]/g, '');
    if (digits && tUser && digits === tUser && (!raw.includes('@') || raw.split('@')[1] === target.split('@')[1])) return true;
  }
  return false;
}

export function payloadText(action: Pick<OutboundAction, 'payload'>): string {
  try {
    const p = JSON.parse(action.payload) as Record<string, unknown>;
    if (typeof p.text === 'string') return p.text;
    if (typeof p.account === 'string' && typeof p.subject === 'string') {
      return `${p.subject}${typeof p.body === 'string' && p.body ? ` — ${p.body}` : ''}`;
    }
    if (typeof p.account === 'string' && typeof p.action === 'string') {
      const cur = (p.current ?? {}) as Record<string, unknown>;
      return `${p.action} ${String(p.summary ?? cur.summary ?? p.eventId ?? '')}${typeof p.start === 'string' ? ` @ ${p.start}` : ''}`;
    }
    if (typeof p.messageId === 'string') return `revoke ${p.messageId}`;
    return action.payload;
  } catch { return action.payload; }
}

function oneLine(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n) + '…' : flat;
}

export function formatReceipt(action: OutboundAction, receipt: Record<string, unknown>): string {
  const who = action.target_name || action.target;
  const mid = typeof receipt.messageId === 'string' ? receipt.messageId : '';
  const idPart = mid ? ` · id …${mid.slice(-8)}` : '';
  if (action.kind === 'revoke') return `Revoked in ${who} ✓ ${oneLine(payloadText(action), 40)}${idPart} (#${action.id})`;
  const p = parsePayload(action);
  if (action.kind === 'email' && typeof p.account === 'string') {
    const to = [...asList(p.to), ...asList(p.cc), ...asList(p.bcc)];
    return `Email sent from ${p.account} to ${oneLine(to.join(', '), 120)} ✓ "${oneLine(String(p.subject ?? ''), 60)}"${idPart}${receipt.viaDraft ? ' (draft)' : ''} (#${action.id})`;
  }
  if (action.kind === 'calendar' && typeof p.account === 'string') {
    const cur = (p.current ?? {}) as Record<string, unknown>;
    const title = oneLine(String(p.summary ?? cur.summary ?? p.eventId ?? ''), 60);
    const verb = p.action === 'create' ? 'created' : p.action === 'update' ? 'updated' : 'cancelled';
    const when = p.action === 'cancel' ? '' : ` ${formatWhen(p.start as string | undefined, p.end as string | undefined, String(p.timeZone ?? ''))}`;
    const eid = typeof receipt.eventId === 'string' ? ` · event …${receipt.eventId.slice(-8)}` : '';
    const link = typeof receipt.htmlLink === 'string' ? ` ${receipt.htmlLink}` : '';
    const note = receipt.duplicate ? ' (already existed)' : receipt.alreadyCancelled ? ' (was already cancelled)' : '';
    return `Calendar event ${verb} ✓ "${title}"${p.action === 'update' && !p.start ? '' : when}${eid}${note} · invites sent (#${action.id})${link}`;
  }
  return `Sent to ${who} ✓ ${oneLine(payloadText(action), 40)}${idPart} (#${action.id})`;
}

const KIND_LABEL: Record<OutboundKind, string> = {
  wa_message: 'WhatsApp message (as you)',
  email: 'Email',
  calendar: 'Calendar',
  jira: 'Jira',
  slack: 'Slack',
  revoke: 'REVOKE / delete for everyone',
  other: 'Action',
};

function parsePayload(action: Pick<OutboundAction, 'payload'>): Record<string, unknown> {
  try { return JSON.parse(action.payload) as Record<string, unknown>; } catch { return {}; }
}

function asList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

const BODY_PREVIEW_CHARS = 300;

function bodyPreview(body: string): string {
  const b = body.trim();
  if (b.length <= BODY_PREVIEW_CHARS) return b;
  return `${b.slice(0, BODY_PREVIEW_CHARS)}… (first ${BODY_PREVIEW_CHARS} of ${b.length} chars)`;
}

function approveFooter(action: OutboundAction, what: string): string[] {
  const exp = new Date(action.expires_at * 1000).toISOString().replace('T', ' ').slice(0, 16);
  return [
    `Approve once, ${what}: tap ✅, or reply "YES ${action.approval_code}" in your WhatsApp self-chat ("NO ${action.approval_code}" to cancel).`,
    `Expires ${exp} UTC.`,
  ];
}

function formatEmailProposal(action: OutboundAction, p: Record<string, unknown>): string {
  const lines = [
    `📤 Approval needed #${action.id} · Email${p.draftId ? ' (existing Gmail draft)' : ''}`,
    `From: ${p.account}`,
    `To: ${asList(p.to).join(', ') || '(none)'}`,
  ];
  if (asList(p.cc).length) lines.push(`Cc: ${asList(p.cc).join(', ')}`);
  if (asList(p.bcc).length) lines.push(`Bcc: ${asList(p.bcc).join(', ')}`);
  lines.push(`Subject: ${p.subject || '(no subject)'}`);
  if (p.threadId || p.inReplyTo) lines.push(`Reply in thread ${p.threadId ?? ''}${p.inReplyTo ? ` (to ${p.inReplyTo})` : ''}`.trim());
  if (typeof p.attachments === 'number' && p.attachments > 0) lines.push(`Attachments: ${p.attachments}`);
  if (p.html) lines.push('Includes an HTML version');
  lines.push(`From agent: ${action.requested_by_agent}`, '', bodyPreview(String(p.body ?? '')), '');
  return [...lines, ...approveFooter(action, 'this exact email')].join('\n');
}

function formatCalendarProposal(action: OutboundAction, p: Record<string, unknown>): string {
  const act = String(p.action);
  const cur = (p.current ?? {}) as Record<string, unknown>;
  const tz = String(p.timeZone ?? '');
  const head = act === 'create' ? 'CREATE event' : act === 'update' ? 'UPDATE event' : 'CANCEL event';
  const lines = [
    `📤 Approval needed #${action.id} · Calendar ${head} (attendees get the ${act === 'cancel' ? 'cancellation' : 'invite/update'} email)`,
    `Account: ${p.account}${p.calendarId && p.calendarId !== 'primary' ? ` · calendar ${p.calendarId}` : ''}`,
  ];
  if (act !== 'create') {
    lines.push(`Event: ${cur.summary ?? '(untitled)'} · ${formatWhen(cur.start as string | undefined, cur.end as string | undefined, tz)} · id ${p.eventId}`);
    if (asList(cur.attendees).length) lines.push(`Current attendees: ${asList(cur.attendees).join(', ')}`);
  }
  if (act !== 'cancel') {
    const arrow = act === 'update' ? '→ ' : '';
    if (p.summary !== undefined) lines.push(`Title: ${arrow}${p.summary}`);
    if (p.start) lines.push(`When: ${arrow}${formatWhen(p.start as string, p.end as string, tz)}`);
    if (p.attendees !== undefined) lines.push(`Attendees: ${arrow}${asList(p.attendees).join(', ') || '(none)'}`);
    else if (act === 'create') lines.push('Attendees: (none)');
    if (p.location !== undefined) lines.push(`Location: ${arrow}${p.location}`);
    if (p.conference) lines.push('Google Meet link: add');
    if (typeof p.description === 'string' && p.description) lines.push(`Description: ${arrow}${bodyPreview(p.description)}`);
  }
  lines.push(`From agent: ${action.requested_by_agent}`, '');
  return [...lines, ...approveFooter(action, `this exact ${act}`)].join('\n');
}

export function formatProposal(action: OutboundAction): string {
  if (GOOGLE_KINDS.has(action.kind)) {
    const p = parsePayload(action);
    if (typeof p.account === 'string') {
      return action.kind === 'email' ? formatEmailProposal(action, p) : formatCalendarProposal(action, p);
    }
  }
  const text = payloadText(action);
  const preview = text.length > 3500 ? text.slice(0, 3500) + `\n… (preview truncated; full text is ${text.length} chars)` : text;
  const exp = new Date(action.expires_at * 1000).toISOString().replace('T', ' ').slice(0, 16);
  return [
    `📤 Approval needed #${action.id} · ${KIND_LABEL[action.kind]}`,
    `To: ${action.target_name ? `${action.target_name} (${action.target})` : action.target}`,
    `From agent: ${action.requested_by_agent}`,
    '',
    preview,
    '',
    `Approve once, this exact text: tap ✅, or reply "YES ${action.approval_code}" in your WhatsApp self-chat ("NO ${action.approval_code}" to cancel).`,
    `Expires ${exp} UTC.`,
  ].join('\n');
}

// ── Side-effect dependencies (injectable for tests) ──────────────────

export interface WaCallResult { ok: boolean; messageId?: string | null; timestamp?: number; duplicate?: boolean; error?: string }

export interface OutboundDeps {
  now(): number; // unix seconds
  /** POST to the WhatsApp service (bearer WA_API_TOKEN). */
  waPost(route: '/send-as-me' | '/revoke-as-me', body: Record<string, unknown>): Promise<WaCallResult>;
  /** Post to Mohamed's main Telegram chat. Returns the message id when known. */
  notify(text: string, buttonsForActionId?: { id: number; kind: OutboundKind }): Promise<number | null>;
  /** Drop the ✅/❌ buttons from a proposal card after a decision. */
  clearButtons(messageId: number, footer: string, originalText: string): Promise<void>;
  /** Gmail / Calendar executor (defaults to the workspace-mcp-credentialed GoogleClient). */
  google?: GoogleExecutor;
}

let _google: GoogleClient | null = null;
let _googleDir: string | undefined;
/** Process-wide Google client (keeps refreshed access tokens in memory). */
export function defaultGoogleClient(): GoogleClient {
  const dir = outboundEnv('GOOGLE_CREDENTIALS_DIR');
  if (!_google || dir !== _googleDir) {
    _google = new GoogleClient({ credentialsDir: dir });
    _googleDir = dir;
  }
  return _google;
}

function httpJson(method: 'GET' | 'POST', port: number, pathName: string, token: string, body?: unknown, timeoutMs = 60_000): Promise<{ status: number; data: any }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathName, method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let chunks = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        let data: any = {};
        try { data = JSON.parse(chunks || '{}'); } catch { data = { error: chunks.slice(0, 300) }; }
        resolve({ status: res.statusCode ?? 0, data });
      });
      res.on('error', reject);
    });
    const timer = setTimeout(() => req.destroy(new Error(`WhatsApp service timed out after ${timeoutMs / 1000}s`)), timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end(payload);
  });
}

/** Call a WhatsApp-service route. Used by the gateway and the CLI read commands. */
export async function waRequest(method: 'GET' | 'POST', route: string, body?: unknown): Promise<{ status: number; data: any }> {
  const token = outboundEnv('WA_API_TOKEN');
  if (!token) throw new OutboundError('WA_API_TOKEN is not set; the WhatsApp service API is locked', 'no_wa_token');
  const port = Number(outboundEnv('WHATSAPP_QR_PORT') ?? '9334');
  return httpJson(method, port, route, token, body);
}

async function telegram(method: string, body: Record<string, unknown>): Promise<any> {
  const token = outboundEnv('TELEGRAM_BOT_TOKEN');
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set');
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({})) as any;
  if (!data?.ok) throw new Error(`telegram ${method} failed: ${data?.description ?? res.status}`);
  return data.result;
}

export const defaultDeps: OutboundDeps = {
  now: () => Math.floor(Date.now() / 1000),
  async waPost(route, body) {
    const { status, data } = await waRequest('POST', route, body);
    if (status < 200 || status >= 300 || !data?.ok) {
      return { ok: false, error: data?.error ?? `HTTP ${status}` };
    }
    return data as WaCallResult;
  },
  async notify(text, buttons) {
    const chatId = outboundEnv('ALLOWED_CHAT_ID');
    if (!chatId) { logger.warn('outbound: ALLOWED_CHAT_ID not set, cannot notify'); return null; }
    const approveLabel = buttons?.kind === 'wa_message' ? '✅ Send'
      : buttons?.kind === 'email' ? '✅ Send email' : '✅ Approve';
    const result = await telegram('sendMessage', {
      chat_id: chatId,
      text,
      link_preview_options: { is_disabled: true },
      ...(buttons ? {
        reply_markup: {
          inline_keyboard: [[
            { text: approveLabel, callback_data: `ob:a:${buttons.id}` },
            { text: '❌ Cancel', callback_data: `ob:r:${buttons.id}` },
          ]],
        },
      } : {}),
    });
    return typeof result?.message_id === 'number' ? result.message_id : null;
  },
  async clearButtons(messageId, footer, originalText) {
    const chatId = outboundEnv('ALLOWED_CHAT_ID');
    if (!chatId) return;
    const text = `${originalText}\n\n${footer}`.slice(0, 4096);
    await telegram('editMessageText', { chat_id: chatId, message_id: messageId, text, link_preview_options: { is_disabled: true } })
      .catch(() => telegram('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }));
  },
};

// ── DB access ────────────────────────────────────────────────────────

const db = () => getOutboundDb();

export function getAction(id: number): OutboundAction | undefined {
  return db().prepare('SELECT * FROM outbound_actions WHERE id = ?').get(id) as OutboundAction | undefined;
}

export function findPendingByCode(code: string): OutboundAction | undefined {
  return db().prepare(`SELECT * FROM outbound_actions WHERE approval_code = ? AND status = 'proposed' ORDER BY id DESC LIMIT 1`)
    .get(code.toUpperCase()) as OutboundAction | undefined;
}

export function expireStale(now: number): number {
  return db().prepare(`UPDATE outbound_actions SET status = 'expired', decided_at = ?, decided_via = 'ttl'
    WHERE status = 'proposed' AND expires_at <= ?`).run(now, now).changes;
}

export interface ListFilter { limit?: number; status?: OutboundStatus; target?: string; sinceSec?: number; agent?: string }

export function listActions(f: ListFilter = {}, now = Math.floor(Date.now() / 1000)): OutboundAction[] {
  expireStale(now);
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.status) { where.push('status = ?'); args.push(f.status); }
  if (f.target) { where.push('(target = ? OR target_name LIKE ?)'); args.push(f.target, `%${f.target}%`); }
  if (f.sinceSec) { where.push('created_at >= ?'); args.push(f.sinceSec); }
  if (f.agent) { where.push('requested_by_agent = ?'); args.push(f.agent); }
  const limit = Math.max(1, Math.min(f.limit ?? 20, 500));
  return db().prepare(`SELECT * FROM outbound_actions ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY id DESC LIMIT ${limit}`).all(...args) as OutboundAction[];
}

function setStatus(id: number, from: OutboundStatus, to: OutboundStatus, fields: Record<string, unknown> = {}): boolean {
  const cols = Object.keys(fields);
  const sets = ['status = ?', ...cols.map((c) => `${c} = ?`)].join(', ');
  return db().prepare(`UPDATE outbound_actions SET ${sets} WHERE id = ? AND status = ?`)
    .run(to, ...cols.map((c) => fields[c]), id, from).changes === 1;
}

// ── Propose ──────────────────────────────────────────────────────────

export interface ProposeInput {
  kind: OutboundKind;
  target: string;
  targetName?: string;
  payload: Record<string, unknown>;
  agent?: string;
  sessionRef?: string;
  turnRef?: string;
  force?: boolean;
  ttlHours?: number;
}

export interface ProposeResult {
  action: OutboundAction;
  autonomous: boolean;
  /** Present when autonomy executed it immediately. */
  outcome?: DecisionResult;
}

export async function propose(input: ProposeInput, deps: OutboundDeps = defaultDeps): Promise<ProposeResult> {
  if (!isEnabled('OUTBOUND_ENABLED')) {
    throw new OutboundError('outbound gateway disabled (OUTBOUND_ENABLED=false)', 'disabled');
  }
  if (!OUTBOUND_KINDS.includes(input.kind)) {
    throw new OutboundError(`unknown kind "${input.kind}" (use ${OUTBOUND_KINDS.join('|')})`, 'bad_kind');
  }
  const target = normalizeTarget(input.kind, input.target);
  if (!target) throw new OutboundError('target required', 'bad_target');
  if (input.kind === 'wa_message') {
    if (typeof input.payload.text !== 'string' || !normalizeText(input.payload.text)) {
      throw new OutboundError('wa_message needs a non-empty text', 'bad_payload');
    }
    if (!/@(c\.us|g\.us|lid)$/.test(target)) {
      throw new OutboundError(`wa_message target must be a WhatsApp chat id (…@c.us / …@g.us / …@lid), got "${target}"`, 'bad_target');
    }
  }
  if (input.kind === 'revoke' && typeof input.payload.messageId !== 'string') {
    throw new OutboundError('revoke needs payload.messageId (the WhatsApp message id to delete for everyone)', 'bad_payload');
  }
  if (GOOGLE_KINDS.has(input.kind)) {
    // Email / calendar are executed by the gateway, so the payload must be
    // complete and valid now: that is exactly what Mohamed will approve.
    try {
      input = {
        ...input,
        payload: (input.kind === 'email'
          ? validateEmailPayload(input.payload)
          : validateCalendarPayload(input.payload)) as unknown as Record<string, unknown>,
      };
    } catch (err: any) {
      throw new OutboundError(`${input.kind}: ${err?.message ?? err}`, 'bad_payload');
    }
  }

  const now = deps.now();
  expireStale(now);
  const { canonical, payloadHash, dedupeHash } = computeHashes(input.kind, target, input.payload);

  const prior = db().prepare(`SELECT * FROM outbound_actions WHERE dedupe_hash = ? ORDER BY id DESC`).all(dedupeHash) as OutboundAction[];
  if (!input.force) {
    const pending = prior.find((r) => r.status === 'proposed' || r.status === 'approved');
    if (pending) {
      throw new OutboundError(
        `identical action already ${pending.status} as #${pending.id}; not proposing again`,
        'duplicate_pending', pending);
    }
    const recent = prior.find((r) => r.status === 'executed' && (r.executed_at ?? 0) > now - DUPLICATE_WINDOW_SEC);
    if (recent) {
      throw new OutboundError(
        `identical action was already executed as #${recent.id} at ${new Date((recent.executed_at ?? 0) * 1000).toISOString()}; refusing a repeat within ${DUPLICATE_WINDOW_SEC / 60} min (use --force only if Mohamed asked to send it again)`,
        'duplicate_recent', recent);
    }
  }
  const idempotencyKey = prior.length === 0 ? dedupeHash : `${dedupeHash}~${prior.length}`;

  const taken = db().prepare(`SELECT 1 FROM outbound_actions WHERE approval_code = ? AND status IN ('proposed','approved')`);
  const code = generateApprovalCode((c) => !!taken.get(c));
  const ttlHours = input.ttlHours ?? (Number(outboundEnv('OUTBOUND_PROPOSAL_TTL_HOURS')) || DEFAULT_TTL_HOURS);

  const info = db().prepare(`INSERT INTO outbound_actions
    (kind, target, target_name, payload, payload_hash, dedupe_hash, idempotency_key, status, approval_code,
     requested_by_agent, session_ref, turn_ref, forced, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?)`).run(
    input.kind, target, input.targetName ?? '', canonical, payloadHash, dedupeHash, idempotencyKey, code,
    input.agent ?? 'main', input.sessionRef ?? null, input.turnRef ?? null, input.force ? 1 : 0,
    now, now + Math.round(ttlHours * 3600),
  );
  let action = getAction(Number(info.lastInsertRowid))!;
  logger.info({ id: action.id, kind: action.kind, target: action.target, agent: action.requested_by_agent }, 'outbound: proposed');

  const autonomous =
    input.kind === 'wa_message' &&
    !ALWAYS_APPROVE_KINDS.has(input.kind) &&
    isEnabled('OUTBOUND_AUTONOMY_ENABLED') &&
    isAutonomousContact(target, outboundEnv('OUTBOUND_AUTONOMOUS_CONTACTS'));

  if (autonomous) {
    const outcome = await decide({ id: action.id, decision: 'approve', via: 'autonomous' }, deps);
    return { action: getAction(action.id)!, autonomous: true, outcome };
  }

  try {
    const msgId = await deps.notify(formatProposal(action), { id: action.id, kind: action.kind });
    if (msgId) {
      db().prepare('UPDATE outbound_actions SET tg_message_id = ? WHERE id = ?').run(msgId, action.id);
      action = getAction(action.id)!;
    }
  } catch (err) {
    logger.warn({ err, id: action.id }, 'outbound: could not post proposal to Telegram');
  }
  return { action, autonomous: false };
}

// ── Decide + execute ─────────────────────────────────────────────────

export interface DecideInput {
  id?: number;
  code?: string;
  decision: 'approve' | 'reject';
  /** telegram | whatsapp | dashboard | autonomous */
  via: string;
}

export interface DecisionResult {
  ok: boolean;
  action?: OutboundAction;
  /** Human-readable one-liner for whoever decided. */
  message: string;
  /** No action matched the id/code (lets the WhatsApp path fall through to the agent). */
  notFound?: boolean;
}

export async function decide(input: DecideInput, deps: OutboundDeps = defaultDeps): Promise<DecisionResult> {
  const now = deps.now();
  expireStale(now);
  let action = input.id !== undefined ? getAction(input.id) : input.code ? findPendingByCode(input.code) : undefined;
  if (!action) {
    return {
      ok: false, notFound: true,
      message: input.code ? `No pending action with code ${input.code.toUpperCase()}.` : `Action #${input.id} not found.`,
    };
  }
  if (action.status !== 'proposed') {
    return { ok: false, action, message: `#${action.id} is already ${action.status}; nothing done.` };
  }

  if (input.decision === 'reject') {
    if (!setStatus(action.id, 'proposed', 'rejected', { decided_at: now, decided_via: input.via })) {
      action = getAction(action.id)!;
      return { ok: false, action, message: `#${action.id} is already ${action.status}; nothing done.` };
    }
    action = getAction(action.id)!;
    logger.info({ id: action.id, via: input.via }, 'outbound: rejected');
    await finishCard(action, `❌ Cancelled (${input.via})`, deps);
    return { ok: true, action, message: `Cancelled #${action.id}; nothing was sent.` };
  }

  if (!isEnabled('OUTBOUND_ENABLED')) {
    return { ok: false, action, message: 'Outbound gateway is disabled (OUTBOUND_ENABLED=false); approval not applied.' };
  }
  // The atomic flip is the exactly-once guard: two approvals racing
  // (button + "YES code") can't both win.
  if (!setStatus(action.id, 'proposed', 'approved', { decided_at: now, decided_via: input.via })) {
    action = getAction(action.id)!;
    return { ok: false, action, message: `#${action.id} is already ${action.status}; nothing done.` };
  }
  action = getAction(action.id)!;
  logger.info({ id: action.id, via: input.via }, 'outbound: approved');

  if (!gatewayExecutes(action)) {
    await finishCard(action, `✅ Approved (${input.via}); the agent must now do it and record it`, deps);
    return {
      ok: true, action,
      message: `Approved #${action.id} (${action.kind}). The agent performs it and records it with: outbound-cli complete ${action.id} --receipt '{...}'`,
    };
  }
  return execute(action, deps);
}

async function execute(action: OutboundAction, deps: OutboundDeps): Promise<DecisionResult> {
  const fail = async (error: string): Promise<DecisionResult> => {
    setStatus(action.id, 'approved', 'failed', { error: error.slice(0, 1000), executed_at: deps.now() });
    const failed = getAction(action.id)!;
    logger.error({ id: action.id, error }, 'outbound: execution failed');
    const line = `❌ #${action.id} to ${action.target_name || action.target} failed: ${error.slice(0, 200)}`;
    await deps.notify(line).catch(() => null);
    await finishCard(failed, '❌ Failed', deps);
    return { ok: false, action: failed, message: line };
  };

  // Execute exactly what was approved: the stored payload must still hash
  // to the hash recorded at proposal time.
  if (crypto.createHash('sha256').update(action.payload).digest('hex') !== action.payload_hash) {
    return fail('stored payload does not match its approved hash; refusing to execute');
  }
  const payload = JSON.parse(action.payload) as Record<string, unknown>;

  let receipt: Record<string, unknown>;
  if (GOOGLE_KINDS.has(action.kind)) {
    // Never crash: a missing credentials file, a refused refresh
    // (invalid_grant) or an API error all end as a failed row with a reason.
    try {
      const google = deps.google ?? defaultGoogleClient();
      const r = action.kind === 'email'
        ? await google.sendEmail(validateEmailPayload(payload), action.idempotency_key)
        : await google.calendar(validateCalendarPayload(payload), action.idempotency_key);
      receipt = { ...r, sentAt: new Date(deps.now() * 1000).toISOString() };
    } catch (err: any) {
      return fail(err?.message ?? String(err));
    }
  } else {
    let res: WaCallResult;
    try {
      res = action.kind === 'wa_message'
        ? await deps.waPost('/send-as-me', { chatId: action.target, text: payload.text, idempotencyKey: action.idempotency_key, actionId: action.id })
        : await deps.waPost('/revoke-as-me', { chatId: action.target, messageId: payload.messageId, idempotencyKey: action.idempotency_key, actionId: action.id });
    } catch (err: any) {
      return fail(err?.message ?? String(err));
    }
    if (!res.ok) return fail(res.error ?? 'WhatsApp service refused');
    receipt = {
      messageId: res.messageId ?? null,
      sentAt: new Date((res.timestamp ?? deps.now()) * 1000).toISOString(),
      chatId: action.target,
      duplicate: !!res.duplicate,
    };
  }

  setStatus(action.id, 'approved', 'executed', { executed_at: deps.now(), receipt: JSON.stringify(receipt) });
  const done = getAction(action.id)!;
  const line = formatReceipt(done, receipt);
  logger.info({ id: done.id, kind: done.kind, messageId: receipt.messageId ?? receipt.eventId ?? null }, 'outbound: executed');
  await deps.notify(line).catch((err) => logger.warn({ err }, 'outbound: receipt post failed'));
  await finishCard(done, '✅ Done', deps);
  return { ok: true, action: done, message: line };
}

/**
 * Whether approval makes the gateway execute this row itself. Email /
 * calendar rows proposed before the Google executor existed carry no
 * `account`; they stay approval-only (agent + `complete`).
 */
export function gatewayExecutes(action: Pick<OutboundAction, 'kind' | 'payload'>): boolean {
  if (!EXECUTABLE_KINDS.has(action.kind)) return false;
  if (GOOGLE_KINDS.has(action.kind)) return typeof parsePayload(action).account === 'string';
  return true;
}

async function finishCard(action: OutboundAction, footer: string, deps: OutboundDeps): Promise<void> {
  if (!action.tg_message_id) return;
  try { await deps.clearButtons(action.tg_message_id, footer, formatProposal(action)); } catch { /* cosmetic */ }
}

/** Record the result of an approved, agent-executed action (email, calendar, jira, slack, other). */
export async function complete(id: number, receipt: Record<string, unknown>, deps: OutboundDeps = defaultDeps): Promise<DecisionResult> {
  const action = getAction(id);
  if (!action) return { ok: false, message: `Action #${id} not found.` };
  if (gatewayExecutes(action)) {
    return { ok: false, action, message: `#${id} (${action.kind}) is executed by the gateway itself; nothing to complete.` };
  }
  if (action.status !== 'approved') {
    return { ok: false, action, message: `#${id} is ${action.status}, not approved; it must not be executed.` };
  }
  const failed = typeof receipt.error === 'string';
  if (!setStatus(id, 'approved', failed ? 'failed' : 'executed', {
    executed_at: deps.now(), receipt: JSON.stringify(receipt), ...(failed ? { error: String(receipt.error).slice(0, 1000) } : {}),
  })) {
    return { ok: false, action: getAction(id), message: `#${id} changed state concurrently; nothing recorded.` };
  }
  const done = getAction(id)!;
  const line = failed
    ? `❌ #${id} ${done.kind} to ${done.target_name || done.target} failed: ${String(receipt.error).slice(0, 200)}`
    : `Done: ${done.kind} to ${done.target_name || done.target} ✓ ${oneLine(payloadText(done), 40)} (#${id})`;
  await deps.notify(line).catch(() => null);
  return { ok: !failed, action: done, message: line };
}

/**
 * Compact public view (API / CLI JSON). The approval code is deliberately
 * left out: it is Mohamed's to type, and an agent that can read it could
 * try to replay it.
 */
export function publicView(a: OutboundAction): Record<string, unknown> {
  let receipt: unknown = null;
  try { receipt = a.receipt ? JSON.parse(a.receipt) : null; } catch { receipt = a.receipt; }
  let payload: unknown = null;
  try { payload = JSON.parse(a.payload); } catch { payload = a.payload; }
  return {
    id: a.id, kind: a.kind, target: a.target, targetName: a.target_name, status: a.status,
    payload, agent: a.requested_by_agent, sessionRef: a.session_ref, turnRef: a.turn_ref, forced: !!a.forced,
    createdAt: a.created_at, expiresAt: a.expires_at, decidedAt: a.decided_at, decidedVia: a.decided_via,
    executedAt: a.executed_at, receipt, error: a.error,
  };
}

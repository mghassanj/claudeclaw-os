/**
 * Durable open loops (table `open_loops`, created in db.ts).
 *
 * An open loop is anything the assistant has promised to keep track of:
 *   - await_reply: wait for a contact's WhatsApp reply, then act (intent_prompt)
 *   - reminder:    fire at due_at
 *   - promise:     something the assistant committed to do, due at due_at
 *
 * Status lifecycle:
 *   open     reminder/promise not yet due (or an unconfirmed commitment)
 *   waiting  await_reply watching its chat
 *   fired    fired max_fires times; the agent closes it (done) once handled
 *   done / dropped / expired  terminal
 *
 * This module is pure data access + formatting; firing, delivery and the
 * scheduler sweep live in open-loops-runtime.ts.
 */
import { getDatabaseHandle } from './db.js';
import { getContact, waUserPart, type Contact } from './contacts.js';

export type LoopKind = 'await_reply' | 'promise' | 'reminder';
export type LoopStatus = 'open' | 'waiting' | 'fired' | 'done' | 'dropped' | 'expired';

export const ACTIVE_STATUSES: LoopStatus[] = ['open', 'waiting'];
export const DEFAULT_LOOP_TTL_SEC = 7 * 86400;

export interface OpenLoop {
  id: number;
  kind: LoopKind;
  contact_id: number | null;
  channel: string;
  chat_ref: string | null;
  summary: string;
  intent_prompt: string;
  origin: string;
  due_at: number | null;
  expires_at: number;
  next_check_at: number | null;
  status: LoopStatus;
  fired_count: number;
  max_fires: number;
  resolution: string | null;
  needs_confirmation: number;
  pending_trigger: string | null;
  last_trigger_ref: string | null;
  created_by_agent: string;
  created_at: number;
  updated_at: number;
}

export interface NewLoop {
  kind: LoopKind;
  summary: string;
  intent_prompt?: string;
  contact_id?: number | null;
  channel?: string;
  chat_ref?: string | null;
  origin?: string;
  due_at?: number | null;
  expires_at?: number | null;
  max_fires?: number;
  needs_confirmation?: boolean;
  created_by_agent?: string;
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

export function createLoop(input: NewLoop): OpenLoop {
  const t = nowSec();
  const due = input.due_at ?? null;
  // Default expiry: 7 days, or 1 day past the due time if that is later.
  const expires = input.expires_at ?? Math.max(t + DEFAULT_LOOP_TTL_SEC, (due ?? 0) + 86400);
  const status: LoopStatus = input.kind === 'await_reply' ? 'waiting' : 'open';
  // next_check_at drives the scheduler sweep: reminders/promises fire at it;
  // for await_reply it is an optional "no reply by then" deadline nudge.
  const nextCheck = input.needs_confirmation ? null : due;
  const res = getDatabaseHandle().prepare(
    `INSERT INTO open_loops (kind, contact_id, channel, chat_ref, summary, intent_prompt, origin,
       due_at, expires_at, next_check_at, status, max_fires, needs_confirmation, created_by_agent,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.kind,
    input.contact_id ?? null,
    input.channel ?? 'whatsapp',
    input.chat_ref ?? null,
    input.summary.trim(),
    (input.intent_prompt ?? '').trim(),
    input.origin ?? 'telegram',
    due,
    expires,
    nextCheck,
    status,
    Math.max(1, input.max_fires ?? 1),
    input.needs_confirmation ? 1 : 0,
    input.created_by_agent ?? 'main',
    t,
    t,
  );
  return getLoop(Number(res.lastInsertRowid))!;
}

export function getLoop(id: number): OpenLoop | null {
  return (getDatabaseHandle().prepare('SELECT * FROM open_loops WHERE id = ?').get(id) as OpenLoop | undefined) ?? null;
}

/** Active loops (open/waiting + fired-but-not-closed), overdue first. */
export function listLoops(opts: { includeClosed?: boolean; contactId?: number; limit?: number } = {}): OpenLoop[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (!opts.includeClosed) where.push(`status IN ('open','waiting','fired')`);
  if (opts.contactId !== undefined) {
    where.push('contact_id = ?');
    args.push(opts.contactId);
  }
  const sql = `SELECT * FROM open_loops ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE WHEN status IN ('open','waiting','fired') THEN 0 ELSE 1 END,
             CASE WHEN COALESCE(next_check_at, due_at) IS NULL THEN 1 ELSE 0 END,
             COALESCE(next_check_at, due_at) ASC, id DESC
    LIMIT ?`;
  args.push(opts.limit ?? 50);
  return getDatabaseHandle().prepare(sql).all(...args) as OpenLoop[];
}

function setTerminal(id: number, status: LoopStatus, resolution: string | null): boolean {
  const res = getDatabaseHandle().prepare(
    `UPDATE open_loops SET status = ?, resolution = COALESCE(?, resolution), pending_trigger = NULL,
       next_check_at = NULL, updated_at = ?
     WHERE id = ? AND status IN ('open','waiting','fired')`,
  ).run(status, resolution, nowSec(), id);
  return res.changes === 1;
}

export function closeLoop(id: number, resolution?: string): boolean {
  return setTerminal(id, 'done', resolution ?? null);
}

export function dropLoop(id: number, reason?: string): boolean {
  return setTerminal(id, 'dropped', reason ?? null);
}

/** Push the next check (and the due time) to `until`; reopens a fired loop. */
export function snoozeLoop(id: number, until: number): boolean {
  const loop = getLoop(id);
  if (!loop || !['open', 'waiting', 'fired'].includes(loop.status)) return false;
  const status: LoopStatus = loop.kind === 'await_reply' ? 'waiting' : 'open';
  const firedCount = loop.status === 'fired' ? Math.max(0, loop.max_fires - 1) : loop.fired_count;
  getDatabaseHandle().prepare(
    `UPDATE open_loops SET next_check_at = ?, due_at = CASE WHEN kind = 'await_reply' THEN due_at ELSE ? END,
       expires_at = MAX(expires_at, ? + 86400), status = ?, fired_count = ?, updated_at = ?
     WHERE id = ?`,
  ).run(until, until, until, status, firedCount, nowSec(), id);
  return true;
}

/** Confirm a commitment captured by memory intake so the sweep may fire it. */
export function confirmLoop(id: number): boolean {
  const res = getDatabaseHandle().prepare(
    `UPDATE open_loops SET needs_confirmation = 0, next_check_at = due_at, updated_at = ?
     WHERE id = ? AND needs_confirmation = 1 AND status IN ('open','waiting')`,
  ).run(nowSec(), id);
  return res.changes === 1;
}

/**
 * Atomically claim a fire. Returns the updated loop, or null when another
 * path (live hook vs startup catch-up vs sweep) already claimed it or the
 * same trigger (message id) was seen before. The trigger payload is stored
 * in pending_trigger so a crash mid-turn is re-run on the next start.
 */
export function claimFire(id: number, triggerRef: string, triggerPayload: string): OpenLoop | null {
  const t = nowSec();
  const res = getDatabaseHandle().prepare(
    `UPDATE open_loops SET
       fired_count = fired_count + 1,
       status = CASE WHEN fired_count + 1 >= max_fires THEN 'fired' ELSE status END,
       pending_trigger = ?, last_trigger_ref = ?, next_check_at = NULL, updated_at = ?
     WHERE id = ? AND status IN ('open','waiting') AND needs_confirmation = 0
       AND fired_count < max_fires
       AND (last_trigger_ref IS NULL OR last_trigger_ref != ?)`,
  ).run(triggerPayload, triggerRef, t, id, triggerRef);
  return res.changes === 1 ? getLoop(id) : null;
}

/**
 * Claim an await_reply deadline nudge ("no reply by due time"). Does not
 * consume a fire: the loop keeps waiting for the actual reply.
 */
export function claimDeadlineNudge(id: number, triggerPayload: string): OpenLoop | null {
  const res = getDatabaseHandle().prepare(
    `UPDATE open_loops SET next_check_at = NULL, pending_trigger = ?, updated_at = ?
     WHERE id = ? AND kind = 'await_reply' AND status = 'waiting' AND next_check_at IS NOT NULL`,
  ).run(triggerPayload, nowSec(), id);
  return res.changes === 1 ? getLoop(id) : null;
}

export function clearPendingTrigger(id: number): void {
  getDatabaseHandle().prepare('UPDATE open_loops SET pending_trigger = NULL WHERE id = ?').run(id);
}

export function getLoopsWithPendingTrigger(): OpenLoop[] {
  return getDatabaseHandle()
    .prepare('SELECT * FROM open_loops WHERE pending_trigger IS NOT NULL ORDER BY id')
    .all() as OpenLoop[];
}

/** Reminders/promises (and await_reply deadlines) whose next check is due. */
export function getDueLoops(now = nowSec()): OpenLoop[] {
  return getDatabaseHandle().prepare(
    `SELECT * FROM open_loops
     WHERE status IN ('open','waiting') AND needs_confirmation = 0
       AND next_check_at IS NOT NULL AND next_check_at <= ? AND expires_at > ?
     ORDER BY next_check_at ASC`,
  ).all(now, now) as OpenLoop[];
}

/** Mark active loops past expires_at as expired; returns the ones changed. */
export function expireLoops(now = nowSec()): OpenLoop[] {
  const db = getDatabaseHandle();
  const rows = db.prepare(
    `SELECT * FROM open_loops WHERE status IN ('open','waiting') AND expires_at <= ?`,
  ).all(now) as OpenLoop[];
  const out: OpenLoop[] = [];
  const stmt = db.prepare(
    `UPDATE open_loops SET status = 'expired', next_check_at = NULL, updated_at = ?
     WHERE id = ? AND status IN ('open','waiting')`,
  );
  for (const r of rows) {
    if (stmt.run(now, r.id).changes === 1) out.push({ ...r, status: 'expired' });
  }
  return out;
}

/** The WhatsApp ids a loop listens on: its chat_ref plus its contact's ids. */
export function loopWaIds(loop: OpenLoop, contact?: Contact | null): string[] {
  const c = contact === undefined ? (loop.contact_id ? getContact(loop.contact_id) : null) : contact;
  return [loop.chat_ref, c?.wa_chat_id, c?.phone].filter((x): x is string => !!x);
}

/** Active await_reply loops (claimable). */
export function getWaitingReplyLoops(): OpenLoop[] {
  return getDatabaseHandle().prepare(
    `SELECT * FROM open_loops
     WHERE kind = 'await_reply' AND status = 'waiting' AND needs_confirmation = 0
       AND fired_count < max_fires ORDER BY id`,
  ).all() as OpenLoop[];
}

export interface InboundIds {
  /** The chat the message arrived in (group id or 1:1 chat id). */
  chatId: string;
  isGroup: boolean;
  /** Ids of the sender: msg.from / msg.author / contact number, any form. */
  senderIds: string[];
}

/**
 * Await-reply loops that an inbound WhatsApp message satisfies. Matching is
 * on the id user-part, so @c.us / @lid / bare-phone variants of one id match.
 *   - loop with chat_ref: the message must be IN that chat (for a 1:1 chat,
 *     the sender ids count as the chat, since the same person can show up
 *     as @lid or @c.us). A DM-bound loop never fires on a group message.
 *   - loop with only a contact: fires on that contact's message in any chat.
 */
export function matchAwaitReplyLoops(msg: InboundIds): OpenLoop[] {
  const part = (x: string | null | undefined): string => waUserPart(x);
  const senderParts = new Set(msg.senderIds.map(part).filter((p) => p.length >= 5));
  const chatParts = new Set([part(msg.chatId)].filter((p) => p.length >= 5));
  if (!msg.isGroup) for (const p of senderParts) chatParts.add(p);
  if (chatParts.size === 0 && senderParts.size === 0) return [];
  return getWaitingReplyLoops().filter((l) => {
    if (l.chat_ref) return chatParts.has(part(l.chat_ref));
    const c = l.contact_id ? getContact(l.contact_id) : null;
    return [c?.wa_chat_id, c?.phone].some((id) => !!id && (senderParts.has(part(id)) || chatParts.has(part(id))));
  });
}

// ── Formatting ─────────────────────────────────────────────────────

export function relTime(ts: number | null, now = nowSec()): string {
  if (!ts) return '';
  const d = ts - now;
  const abs = Math.abs(d);
  const unit = abs < 3600 ? `${Math.max(1, Math.round(abs / 60))}m` : abs < 86400 * 2 ? `${Math.round(abs / 3600)}h` : `${Math.round(abs / 86400)}d`;
  return d < 0 ? `${unit} ago` : `in ${unit}`;
}

export function isOverdue(l: OpenLoop, now = nowSec()): boolean {
  const due = l.next_check_at ?? l.due_at;
  return l.status === 'fired' || (!!due && due <= now);
}

export function formatLoopLine(l: OpenLoop, now = nowSec()): string {
  const who = l.contact_id ? getContact(l.contact_id)?.display_name : null;
  const bits = [`#${l.id} ${l.kind}`];
  if (who) bits.push(who);
  if (l.status === 'fired') bits.push('FIRED, not closed');
  else if (l.due_at) bits.push(l.due_at <= now ? `OVERDUE ${relTime(l.due_at, now)}` : `due ${relTime(l.due_at, now)}`);
  if (l.needs_confirmation) bits.push('UNCONFIRMED (ask Mohamed)');
  bits.push(`expires ${relTime(l.expires_at, now)}`);
  const summary = l.summary.length > 140 ? l.summary.slice(0, 140) + '…' : l.summary;
  return `- ${bits.join(' · ')}: ${summary}`;
}

/** The [Open loops] context block: max 8, overdue first. Empty string if none. */
export function buildOpenLoopsBlock(max = 8, now = nowSec()): string {
  const loops = listLoops({ limit: 100 });
  if (loops.length === 0) return '';
  const sorted = loops.slice().sort((a, b) => {
    const oa = isOverdue(a, now) ? 0 : 1;
    const ob = isOverdue(b, now) ? 0 : 1;
    if (oa !== ob) return oa - ob;
    const da = a.next_check_at ?? a.due_at ?? Number.MAX_SAFE_INTEGER;
    const dbb = b.next_check_at ?? b.due_at ?? Number.MAX_SAFE_INTEGER;
    return da - dbb || a.id - b.id;
  });
  const shown = sorted.slice(0, max);
  const more = loops.length - shown.length;
  const lines = shown.map((l) => formatLoopLine(l, now));
  if (more > 0) lines.push(`- …and ${more} more (loops-cli list)`);
  return `[Open loops — close with loops-cli when handled]\n${lines.join('\n')}\n[End open loops]`;
}

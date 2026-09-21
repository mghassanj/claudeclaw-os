/**
 * Open-loop runtime (main process only): fires loops as queued MAIN agent
 * turns and delivers the result to the loop's origin.
 *
 * Triggers:
 *   - WhatsApp inbound (POST /api/loops/inbound from the WhatsApp service)
 *     -> await_reply loops watching that chat/contact
 *   - scheduler sweep (every 60 s) -> due reminders/promises, await_reply
 *     deadlines, and expiry (Mohamed is told once per expired batch)
 *   - startup -> re-run fires whose turn never finished (pending_trigger)
 *
 * All state is in SQLite, so restarts lose nothing: a fire is claimed in
 * the DB (atomic UPDATE) BEFORE the turn runs and pending_trigger is only
 * cleared once the result was delivered.
 */
import http from 'node:http';

import { getDashboardSetting, setDashboardSetting } from './db.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { findContactsByWaIds, getContact, touchContactInteraction } from './contacts.js';
import {
  claimDeadlineNudge,
  claimFire,
  clearPendingTrigger,
  expireLoops,
  getDueLoops,
  getLoopsWithPendingTrigger,
  getWaitingReplyLoops,
  loopWaIds,
  matchAwaitReplyLoops,
  type OpenLoop,
} from './open-loops.js';

type TextSender = (text: string) => Promise<void>;
type TurnRunner = (prompt: string) => Promise<string>;
type WaSender = (chatId: string, text: string) => Promise<void>;

let telegramSender: TextSender | null = null;
let turnRunner: TurnRunner = async (prompt) => {
  const { runMainTurnQueued } = await import('./main-turn.js');
  return runMainTurnQueued(prompt);
};
let waSender: WaSender = postWhatsAppSend;

/** Wired by initScheduler (main agent): raw text -> Telegram main chat. */
export function setLoopTelegramSender(send: TextSender): void {
  telegramSender = send;
}

/** @internal tests */
export function _setLoopRuntimeForTests(opts: { runner?: TurnRunner; telegram?: TextSender | null; whatsapp?: WaSender }): void {
  if (opts.runner) turnRunner = opts.runner;
  if (opts.telegram !== undefined) telegramSender = opts.telegram;
  if (opts.whatsapp) waSender = opts.whatsapp;
}

// ── Delivery ───────────────────────────────────────────────────────

const SELF_CHAT_SETTING = 'wa_self_chat_id';

function envValue(key: string): string {
  return process.env[key] || readEnvFile([key])[key] || '';
}

/** Recorded by the WhatsApp service the first time it sees the self-chat. */
export function rememberWhatsAppSelfChatId(chatId: string): void {
  if (!chatId || getDashboardSetting(SELF_CHAT_SETTING) === chatId) return;
  setDashboardSetting(SELF_CHAT_SETTING, chatId);
}

export function resolveOrigin(origin: string): { kind: 'telegram' } | { kind: 'whatsapp'; chatId: string } {
  if (origin.startsWith('whatsapp:') && origin.length > 'whatsapp:'.length) {
    return { kind: 'whatsapp', chatId: origin.slice('whatsapp:'.length) };
  }
  if (origin === 'whatsapp-self') {
    const id = envValue('WHATSAPP_SELF_CHAT_ID') || getDashboardSetting(SELF_CHAT_SETTING) || '';
    if (id) return { kind: 'whatsapp', chatId: id };
  }
  return { kind: 'telegram' };
}

async function sendTelegram(text: string): Promise<void> {
  if (!telegramSender) {
    logger.warn('open-loops: no Telegram sender registered; dropping notification');
    return;
  }
  const { formatForTelegram, splitMessage } = await import('./bot.js');
  for (const chunk of splitMessage(formatForTelegram(text))) await telegramSender(chunk);
}

export async function deliverToOrigin(origin: string, text: string): Promise<void> {
  const target = resolveOrigin(origin);
  if (target.kind === 'whatsapp') {
    try {
      await waSender(target.chatId, text);
      return;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, 'open-loops: WhatsApp delivery failed; falling back to Telegram');
    }
  }
  await sendTelegram(text);
}

function waHeaders(body: string): Record<string, string | number> {
  const h: Record<string, string | number> = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
  // Sent when configured, for a token-gated WhatsApp HTTP API.
  const token = envValue('WHATSAPP_API_TOKEN');
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/** POST to the WhatsApp service's loopback /send (it adds the 🤖 prefix). */
function postWhatsAppSend(chatId: string, text: string): Promise<void> {
  const port = Number(envValue('WHATSAPP_QR_PORT') || '9334');
  const body = JSON.stringify({ chatId, text });
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/send', method: 'POST', headers: waHeaders(body) },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => (res.statusCode === 200 ? resolve() : reject(new Error(`whatsapp /send HTTP ${res.statusCode}: ${data.slice(0, 200)}`))));
      },
    );
    req.setTimeout(30_000, () => req.destroy(new Error('whatsapp /send timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

// ── Firing ─────────────────────────────────────────────────────────

export interface LoopTrigger {
  type: 'inbound' | 'due' | 'deadline';
  /** inbound: sender display name, message text, WhatsApp message id, unix ts. */
  from?: string;
  text?: string;
  messageId?: string;
  at?: number;
  catchUp?: boolean;
}

function originLabel(origin: string): string {
  const o = resolveOrigin(origin);
  return o.kind === 'telegram' ? 'Telegram' : 'WhatsApp self-chat';
}

export function buildLoopPrompt(loop: OpenLoop, trigger: LoopTrigger, resumed = false): string {
  const contact = loop.contact_id ? getContact(loop.contact_id) : null;
  const who = contact?.display_name ?? trigger.from ?? 'the contact';
  const head = trigger.type === 'inbound'
    ? `[Open loop #${loop.id} fired] new message from ${trigger.from || who}`
    : trigger.type === 'deadline'
      ? `[Open loop #${loop.id} deadline] no reply from ${who} yet`
      : `[Open loop #${loop.id} due] ${loop.kind}`;
  const lines = [
    head + (resumed ? ' (resumed after a restart)' : ''),
    `Summary: ${loop.summary}`,
    `Intent: ${loop.intent_prompt || '(none recorded; tell Mohamed what happened and ask what to do)'}`,
  ];
  if (contact?.language_pref) lines.push(`${contact.display_name} prefers: ${contact.language_pref}`);
  if (trigger.type === 'inbound') {
    const when = trigger.at ? new Date(trigger.at * 1000).toISOString() : 'just now';
    lines.push(`Message (WhatsApp${loop.chat_ref ? ` chat ${loop.chat_ref}` : ''}, ${when}${trigger.catchUp ? ', received while offline' : ''}):`);
    lines.push((trigger.text ?? '').slice(0, 3000) || '(no text: media message)');
  }
  lines.push('');
  lines.push(
    `Act on the intent. A reply to a third party is a draft until Mohamed approves that exact text; do not send, revoke or delete on your own. ` +
    `When handled run \`loops-cli close ${loop.id} "<what happened>"\` (or snooze it). ` +
    `Your answer is delivered to Mohamed on ${originLabel(loop.origin)}.`,
  );
  return lines.join('\n');
}

/** Run the fire as a queued main turn and deliver the reply. Never throws. */
export async function runLoopFire(loop: OpenLoop, trigger: LoopTrigger, resumed = false): Promise<void> {
  const prompt = buildLoopPrompt(loop, trigger, resumed);
  try {
    logger.info({ loopId: loop.id, type: trigger.type, resumed }, 'open-loops: firing');
    const reply = (await turnRunner(prompt)).trim() || 'Done.';
    await deliverToOrigin(loop.origin, `🔁 Loop #${loop.id}: ${reply}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ loopId: loop.id, err: msg }, 'open-loops: fire failed');
    try {
      await deliverToOrigin(loop.origin, `⚠️ Loop #${loop.id} fired (${loop.summary.slice(0, 80)}) but the agent turn failed: ${msg.slice(0, 200)}`);
    } catch { /* ignore */ }
  } finally {
    try { clearPendingTrigger(loop.id); } catch { /* ignore */ }
  }
}

// ── WhatsApp inbound ───────────────────────────────────────────────

export interface InboundPayload {
  chatId: string;
  isGroup?: boolean;
  senderIds?: string[];
  senderName?: string;
  text?: string;
  messageId?: string;
  timestamp?: number;
  catchUp?: boolean;
}

/**
 * Match an inbound WhatsApp message against waiting await_reply loops,
 * claim each match and start its turn in the background. Returns the ids
 * fired. Messages older than the loop's last update are ignored, so the
 * WhatsApp catch-up replay can't fire a loop on a message it predates.
 */
export function handleInboundMessage(p: InboundPayload): number[] {
  if (!p.chatId) return [];
  const ids = { chatId: p.chatId, isGroup: !!p.isGroup, senderIds: p.senderIds ?? [] };
  const at = p.timestamp ?? Math.floor(Date.now() / 1000);

  // Record the interaction on known contacts (1:1 chats, or group author).
  try {
    const touched = findContactsByWaIds(p.isGroup ? ids.senderIds : [p.chatId, ...ids.senderIds]);
    for (const c of touched) touchContactInteraction(c.id, at);
  } catch { /* non-fatal */ }

  const fired: number[] = [];
  for (const loop of matchAwaitReplyLoops(ids)) {
    if (at < loop.updated_at) continue;
    const trigger: LoopTrigger = {
      type: 'inbound', from: p.senderName, text: p.text, messageId: p.messageId, at, catchUp: p.catchUp,
    };
    const claimed = claimFire(loop.id, p.messageId || `${p.chatId}:${at}`, JSON.stringify(trigger));
    if (!claimed) continue;
    fired.push(loop.id);
    void runLoopFire(claimed, trigger);
  }
  return fired;
}

/** What the WhatsApp service should re-check on startup. */
export function getWatchList(): Array<{ id: number; ids: string[]; since: number }> {
  return getWaitingReplyLoops().map((l) => ({ id: l.id, ids: loopWaIds(l), since: l.updated_at }))
    .filter((w) => w.ids.length > 0);
}

// ── Scheduler sweep ────────────────────────────────────────────────

let sweeping = false;

export async function sweepOpenLoops(now = Math.floor(Date.now() / 1000)): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const expired = expireLoops(now);
    if (expired.length > 0) {
      const lines = expired.map((l) => `- #${l.id} ${l.kind}: ${l.summary.slice(0, 120)}`);
      await sendTelegram(
        `⌛ ${expired.length} open loop${expired.length === 1 ? '' : 's'} expired without resolution:\n${lines.join('\n')}\n\n` +
        `Reopen with loops-cli add, or ignore.`,
      );
    }
    for (const loop of getDueLoops(now)) {
      if (loop.kind === 'await_reply') {
        const trigger: LoopTrigger = { type: 'deadline' };
        const claimed = claimDeadlineNudge(loop.id, JSON.stringify(trigger));
        if (claimed) void runLoopFire(claimed, trigger);
      } else {
        const trigger: LoopTrigger = { type: 'due' };
        const claimed = claimFire(loop.id, `due:${loop.next_check_at}`, JSON.stringify(trigger));
        if (claimed) void runLoopFire(claimed, trigger);
      }
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, 'open-loops sweep failed');
  } finally {
    sweeping = false;
  }
}

/** Re-run fires interrupted by a restart. Call once at startup. */
export function resumePendingLoopFires(): number {
  let n = 0;
  for (const loop of getLoopsWithPendingTrigger()) {
    let trigger: LoopTrigger = { type: 'due' };
    try { trigger = JSON.parse(loop.pending_trigger ?? '{}') as LoopTrigger; } catch { /* keep default */ }
    void runLoopFire(loop, trigger, true);
    n++;
  }
  if (n > 0) logger.warn({ count: n }, 'open-loops: resumed fires interrupted by restart');
  return n;
}

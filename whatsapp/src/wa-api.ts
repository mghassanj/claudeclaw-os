// Supported WhatsApp API for the ClaudeClaw outbound gateway (served by
// healthcheck.ts on 127.0.0.1:9334). Replaces the ad-hoc DevTools scripts
// agents were writing (2026-09-21 Nora incident):
//   GET  /contacts/find?q=               name/phone -> chat ids (cached contacts + chat titles)
//   GET  /chats/:id/messages?since=&limit=
//   POST /send-as-me   {chatId, text, idempotencyKey, actionId}   (no 🤖 prefix)
//   POST /revoke-as-me {chatId, messageId, idempotencyKey, actionId}
// All of these, and the older /send* routes, require
// "Authorization: Bearer $WA_API_TOKEN". /send-as-me and /revoke-as-me are
// meant for the gateway only (src/outbound.ts executes them after
// Mohamed's approval); every call is logged with its action id.
import crypto from "node:crypto";
import type http from "node:http";
import type { WAClient } from "./client.js";
import { expectOutgoing, markSent } from "./sent-registry.js";

export type AuthResult = "ok" | "unconfigured" | "denied";

export function checkBearer(header: string | undefined, token: string | undefined): AuthResult {
  if (!token) return "unconfigured";
  const m = (header ?? "").match(/^Bearer\s+(.+)$/i);
  if (!m) return "denied";
  const a = Buffer.from(m[1].trim());
  const b = Buffer.from(token);
  if (a.length !== b.length) return "denied";
  return crypto.timingSafeEqual(a, b) ? "ok" : "denied";
}

export async function readJson(req: http.IncomingMessage, maxBytes = 256 * 1024): Promise<any> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > maxBytes) throw new Error("body too large");
  }
  return body ? JSON.parse(body) : {};
}

// ── Contact lookup ───────────────────────────────────────────────────

export interface ContactLike {
  id: { _serialized: string };
  name?: string;
  pushname?: string;
  shortName?: string;
  number?: string;
  isGroup?: boolean;
  isMe?: boolean;
  isMyContact?: boolean;
}

export interface ContactMatch { id: string; name: string; number?: string; isGroup: boolean; isMyContact: boolean }

/** Case-insensitive name match, or digit match (>= 4 digits) on the number. */
export function matchContacts(list: ContactLike[], q: string, limit = 20): ContactMatch[] {
  const needle = q.trim().toLowerCase();
  const digits = q.replace(/\D/g, "");
  if (!needle) return [];
  const seen = new Set<string>();
  const out: ContactMatch[] = [];
  for (const c of list) {
    if (c.isMe) continue;
    const id = c.id?._serialized;
    if (!id || seen.has(id)) continue;
    const names = [c.name, c.pushname, c.shortName].filter(Boolean).map((s) => String(s).toLowerCase());
    const byName = names.some((n) => n.includes(needle));
    const byNumber = digits.length >= 4 && !!c.number && c.number.includes(digits);
    if (!byName && !byNumber) continue;
    seen.add(id);
    out.push({
      id,
      name: c.name ?? c.pushname ?? c.shortName ?? "",
      number: c.number || undefined,
      isGroup: !!c.isGroup,
      isMyContact: !!c.isMyContact,
    });
  }
  // Saved contacts and exact names first.
  out.sort((x, y) =>
    Number(y.name.toLowerCase() === needle) - Number(x.name.toLowerCase() === needle) ||
    Number(y.isMyContact) - Number(x.isMyContact));
  return out.slice(0, limit);
}

// getContacts() walks every contact through the page (~18 s on a large
// address book), so lookups use an in-memory snapshot of contacts + chat
// titles. A stale snapshot is served immediately and refreshed in the
// background; only the very first lookup (or one after a failed load)
// waits for WhatsApp. TTL: WA_CONTACTS_CACHE_MS (default 10 min).

export interface ChatLike {
  id: { _serialized: string };
  name?: string;
  formattedTitle?: string;
  isGroup?: boolean;
}

interface Snapshot { list: ContactLike[]; at: number }
interface CacheEntry { snap: Snapshot | null; loading: Promise<Snapshot> | null }
const contactCache = new WeakMap<object, CacheEntry>();

export function contactsCacheMs(): number {
  const v = Number(process.env.WA_CONTACTS_CACHE_MS);
  return Number.isFinite(v) && v >= 0 && process.env.WA_CONTACTS_CACHE_MS !== undefined && process.env.WA_CONTACTS_CACHE_MS !== ""
    ? v : 10 * 60 * 1000;
}

/** Chats as ContactLike, keyed on their title (saved names, group subjects). */
export function chatsAsContacts(chats: ChatLike[]): ContactLike[] {
  return chats
    .map((c) => ({
      id: c.id,
      name: c.name ?? c.formattedTitle ?? (c as any)?._data?.formattedTitle,
      isGroup: !!c.isGroup,
    }))
    .filter((c) => !!c.id?._serialized && !!c.name);
}

async function loadSnapshot(client: WAClient): Promise<Snapshot> {
  const [contacts, chats] = await Promise.all([
    client.getContacts() as unknown as Promise<ContactLike[]>,
    // Chat titles are a bonus; a getChats failure must not break lookups.
    Promise.resolve().then(() => client.getChats() as unknown as Promise<ChatLike[]>).catch(() => [] as ChatLike[]),
  ]);
  // Contacts first so their richer fields (number, isMyContact) win the de-dupe in matchContacts.
  return { list: [...contacts, ...chatsAsContacts(chats)], at: Date.now() };
}

function refresh(client: WAClient, entry: CacheEntry): Promise<Snapshot> {
  if (!entry.loading) {
    entry.loading = loadSnapshot(client)
      .then((snap) => { entry.snap = snap; return snap; })
      .finally(() => { entry.loading = null; });
  }
  return entry.loading;
}

/** Contacts + chat titles, cached; stale data is returned while a background refresh runs. */
export async function cachedContactList(client: WAClient, now = Date.now()): Promise<ContactLike[]> {
  let entry = contactCache.get(client);
  if (!entry) { entry = { snap: null, loading: null }; contactCache.set(client, entry); }
  if (!entry.snap) return (await refresh(client, entry)).list;
  if (now - entry.snap.at >= contactsCacheMs()) {
    refresh(client, entry).catch((e) => console.warn(`[wa-api] background contacts refresh failed: ${String(e).slice(0, 150)}`));
  }
  return entry.snap.list;
}

/** Warm the cache (e.g. on READY) so the first lookup is fast too. Never throws. */
export function warmContactsCache(client: WAClient): void {
  cachedContactList(client).catch((e) => console.warn(`[wa-api] contacts warm-up failed: ${String(e).slice(0, 150)}`));
}

/** Test-only. */
export function _resetContactsCache(client: WAClient): void { contactCache.delete(client); }

export async function findContacts(client: WAClient, q: string): Promise<ContactMatch[]> {
  return matchContacts(await cachedContactList(client), q);
}

// ── Chat history ─────────────────────────────────────────────────────

export async function chatMessages(client: WAClient, chatId: string, since: number | undefined, limit: number) {
  const chat = await client.getChatById(chatId);
  const msgs = await chat.fetchMessages({ limit: Math.max(1, Math.min(limit, 200)) });
  return msgs
    .filter((m) => !since || m.timestamp >= since)
    .map((m: any) => ({
      id: m.id?._serialized ?? null,
      fromMe: !!m.fromMe,
      author: m.fromMe ? undefined : (m._data?.notifyName ?? m.author ?? undefined),
      body: m.body ?? "",
      timestamp: m.timestamp,
      type: m.type,
      hasMedia: !!m.hasMedia,
    }));
}

// ── Gateway sends (idempotent) ───────────────────────────────────────

const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
interface Done { messageId: string | null; timestamp: number; at: number }
const done = new Map<string, Done>();
const inflight = new Map<string, Promise<Done>>();

function prune(now: number) {
  for (const [k, v] of done) if (now - v.at > IDEMPOTENCY_TTL_MS) done.delete(k);
}

/** Test-only. */
export function _resetIdempotency() { done.clear(); inflight.clear(); }

/**
 * Run `op` at most once per idempotency key within 10 minutes. A repeat
 * returns the first result with duplicate=true instead of acting again.
 */
export async function onceByKey(key: string, op: () => Promise<Done>): Promise<Done & { duplicate: boolean }> {
  const now = Date.now();
  prune(now);
  const prev = done.get(key);
  if (prev) return { ...prev, duplicate: true };
  const running = inflight.get(key);
  if (running) return { ...(await running), duplicate: true };
  const p = op();
  inflight.set(key, p);
  try {
    const res = await p;
    done.set(key, res);
    return { ...res, duplicate: false };
  } finally {
    inflight.delete(key);
  }
}

export interface SendAsMeInput { chatId: string; text: string; idempotencyKey: string; actionId?: number | string }

export function validateSendAsMe(b: any): SendAsMeInput {
  if (!b || typeof b.chatId !== "string" || !/@(c\.us|g\.us|lid)$/.test(b.chatId)) throw new Error("chatId (…@c.us|@g.us|@lid) required");
  if (typeof b.text !== "string" || !b.text.trim()) throw new Error("text required");
  if (typeof b.idempotencyKey !== "string" || b.idempotencyKey.length < 16) throw new Error("idempotencyKey required");
  return { chatId: b.chatId, text: b.text, idempotencyKey: b.idempotencyKey, actionId: b.actionId };
}

export async function sendAsMe(client: WAClient, input: SendAsMeInput) {
  return onceByKey(`send:${input.idempotencyKey}`, async () => {
    // Register before sending so message_create (which can fire before
    // sendMessage resolves) doesn't treat Mohamed's outgoing text as input.
    expectOutgoing(input.chatId, input.text);
    const sent = await client.sendMessage(input.chatId, input.text);
    const messageId = (sent as any)?.id?._serialized ?? null;
    if (messageId) markSent(messageId);
    return { messageId, timestamp: (sent as any)?.timestamp ?? Math.floor(Date.now() / 1000), at: Date.now() };
  });
}

export interface RevokeInput { chatId: string; messageId: string; idempotencyKey: string; actionId?: number | string }

export function validateRevoke(b: any): RevokeInput {
  if (!b || typeof b.chatId !== "string" || !b.chatId) throw new Error("chatId required");
  if (typeof b.messageId !== "string" || !b.messageId) throw new Error("messageId required");
  if (typeof b.idempotencyKey !== "string" || b.idempotencyKey.length < 16) throw new Error("idempotencyKey required");
  return { chatId: b.chatId, messageId: b.messageId, idempotencyKey: b.idempotencyKey, actionId: b.actionId };
}

export async function revokeAsMe(client: WAClient, input: RevokeInput) {
  return onceByKey(`revoke:${input.idempotencyKey}`, async () => {
    const msg = await client.getMessageById(input.messageId);
    if (!msg) throw new Error("message not found");
    if (!msg.fromMe) throw new Error("can only revoke Mohamed's own messages");
    const remote = (msg.id as any)?.remote?._serialized ?? (msg.id as any)?.remote ?? msg.to;
    if (remote && remote !== input.chatId) throw new Error(`message belongs to ${remote}, not ${input.chatId}`);
    await msg.delete(true);
    return { messageId: input.messageId, timestamp: Math.floor(Date.now() / 1000), at: Date.now() };
  });
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// In-memory registry of message IDs the bot has sent, so the message_create
// handler can ignore the bot's own outbound messages when self-chat /
// self-reply processing is on. The 🤖 text prefix only covers text and
// captioned media; voice notes and uncaptioned media have no body to prefix,
// so without this they would be reprocessed as user input — an infinite loop.
//
// Persisted to disk: after a restart the self-chat catch-up replays recent
// messages, and anything the gateway sent AS Mohamed (no 🤖 prefix) would be
// read back as his own input if this set started empty (2026-09-21: the bot
// answered its own gateway test after a restart).

const MAX = 1000;

export function registryPath(): string {
  return process.env.WA_SENT_REGISTRY_PATH
    ?? path.join(os.homedir(), ".cache", "claudeclaw", "wa-sent-ids.json");
}

function load(): Set<string> {
  try {
    const ids = JSON.parse(fs.readFileSync(registryPath(), "utf8"));
    return new Set(Array.isArray(ids) ? ids.filter((x) => typeof x === "string").slice(-MAX) : []);
  } catch {
    return new Set();
  }
}

function save(): void {
  try {
    const p = registryPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...sentIds]), { mode: 0o600 });
    fs.renameSync(tmp, p);
  } catch (e) {
    console.warn("[wa] could not persist sent registry:", e);
  }
}

const sentIds = load();

export function markSent(id: string | undefined | null): void {
  if (!id) return;
  sentIds.add(id);
  if (sentIds.size > MAX) {
    const drop = Math.floor(MAX * 0.2);
    let i = 0;
    for (const v of sentIds) {
      sentIds.delete(v);
      if (++i >= drop) break;
    }
  }
  save();
}

export function wasSentByBot(id: string | undefined | null): boolean {
  return !!id && sentIds.has(id);
}

// Messages the outbound gateway is about to send AS Mohamed (no 🤖 prefix,
// see wa-api.ts sendAsMe). message_create can fire before sendMessage
// resolves with the id, so the id registry alone could miss it and a send
// into an allowed group would be read back as Mohamed's own input.
// Keyed by chat + exact body, consumed on first match, expires after 2 min.
const EXPECT_TTL_MS = 2 * 60 * 1000;
const expected = new Map<string, number>();

export function expectOutgoing(chatId: string, body: string): void {
  const now = Date.now();
  for (const [k, at] of expected) if (now - at > EXPECT_TTL_MS) expected.delete(k);
  expected.set(`${chatId}\n${body}`, now);
}

export function consumeExpectedOutgoing(chatId: string | undefined, body: string | undefined): boolean {
  if (!chatId || body === undefined) return false;
  const k = `${chatId}\n${body}`;
  const at = expected.get(k);
  if (at === undefined) return false;
  expected.delete(k);
  return Date.now() - at <= EXPECT_TTL_MS;
}

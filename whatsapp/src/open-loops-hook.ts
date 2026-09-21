// Open-loop triggers from WhatsApp to the main process (dashboard loopback
// API, DASHBOARD_TOKEN sent as an Authorization: Bearer header). The WhatsApp service does not
// open the SQLite store; the dashboard owns loop state and firing.
//
//   notifyOpenLoops    every non-self inbound message (1:1 or group) ->
//                      POST /api/loops/inbound; the dashboard matches it
//                      against waiting await_reply loops and, on a match,
//                      queues a main-agent turn.
//   catchUpOpenLoops   on READY: for chats with waiting loops, replay
//                      messages newer than the loop's last update (so a
//                      reply that arrived while we were down still fires).
//   reportSelfChatId   tells the dashboard which chat is the self-chat so
//                      loops created there can report back to it.
import http from "node:http";

interface MinimalMsg {
  id: { _serialized: string };
  from?: string;
  to?: string;
  author?: string;
  fromMe?: boolean;
  body?: string;
  type?: string;
  hasMedia?: boolean;
  timestamp: number;
  getContact?: () => Promise<any>;
}

export interface InboundLoopPayload {
  chatId: string;
  isGroup: boolean;
  senderIds: string[];
  senderName?: string;
  text: string;
  messageId: string;
  timestamp: number;
  catchUp?: boolean;
}

function dashboardRequest(method: "GET" | "POST", path: string, payload?: unknown, timeoutMs = 10_000): Promise<{ status: number; data: string }> {
  const port = Number(process.env.DASHBOARD_PORT ?? "3141");
  const token = process.env.DASHBOARD_TOKEN ?? "";
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const headers: Record<string, string | number> = { Authorization: `Bearer ${token}` };
  if (body) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(body);
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method, headers },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { data += c; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, data }));
        res.on("error", reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`dashboard ${path} timed out`)));
    req.on("error", reject);
    req.end(body || undefined);
  });
}

/** Text the loop turn sees; media without a caption gets a placeholder. */
export function loopMessageText(msg: Pick<MinimalMsg, "body" | "type" | "hasMedia">): string {
  const body = (msg.body ?? "").trim();
  if (body) return body;
  if (msg.type === "ptt" || msg.type === "audio") return "[voice note: open the chat to listen]";
  if (msg.hasMedia) return `[${msg.type ?? "media"} attachment]`;
  return "";
}

export async function buildInboundPayload(msg: MinimalMsg, chatId: string, isGroup: boolean): Promise<InboundLoopPayload> {
  const senderIds = [msg.from, msg.author].filter((x): x is string => !!x && !x.endsWith("@g.us"));
  let senderName: string | undefined;
  try {
    const c = await msg.getContact?.();
    if (c?.number) senderIds.push(String(c.number));
    if (c?.id?._serialized) senderIds.push(String(c.id._serialized));
    senderName = c?.pushname ?? c?.name ?? undefined;
  } catch { /* @lid contacts sometimes can't be resolved */ }
  return {
    chatId,
    isGroup,
    senderIds: [...new Set(senderIds)],
    senderName,
    text: loopMessageText(msg),
    messageId: msg.id._serialized,
    timestamp: msg.timestamp,
  };
}

/** Fire-and-forget; never throws. Skips the account's own messages. */
export async function notifyOpenLoops(msg: MinimalMsg, chatId: string, isGroup: boolean, catchUp = false): Promise<number[]> {
  if (msg.fromMe || !chatId) return [];
  try {
    const payload = await buildInboundPayload(msg, chatId, isGroup);
    if (catchUp) payload.catchUp = true;
    const { status, data } = await dashboardRequest("POST", "/api/loops/inbound", payload);
    if (status !== 200) {
      console.warn("[wa] open-loops inbound HTTP", status, data.slice(0, 120));
      return [];
    }
    const fired = (JSON.parse(data || "{}").fired ?? []) as number[];
    if (fired.length) console.log("[wa] open loop(s) fired:", fired.join(","));
    return fired;
  } catch (e) {
    console.warn("[wa] open-loops inbound failed:", (e as Error).message);
    return [];
  }
}

let reportedSelfChat = "";
export function reportSelfChatId(chatId: string): void {
  if (!chatId || reportedSelfChat === chatId) return;
  reportedSelfChat = chatId;
  dashboardRequest("POST", "/api/loops/self-chat", { chatId })
    .then(({ status }) => { if (status !== 200) reportedSelfChat = ""; })
    .catch(() => { reportedSelfChat = ""; });
}

interface WatchEntry { id: number; ids: string[]; since: number }

/**
 * Startup catch-up: for each waiting await_reply loop, look in its chat for
 * inbound messages newer than the loop's last update and send them through
 * notifyOpenLoops (the dashboard dedupes by message id and loop state).
 */
export async function catchUpOpenLoops(client: { getChatById: (id: string) => Promise<any> }): Promise<void> {
  let watch: WatchEntry[] = [];
  try {
    const { status, data } = await dashboardRequest("GET", "/api/loops/watch");
    if (status !== 200) throw new Error(`HTTP ${status}`);
    watch = (JSON.parse(data || "{}").loops ?? []) as WatchEntry[];
  } catch (e) {
    console.warn("[wa] open-loops catch-up: watch list unavailable:", (e as Error).message);
    return;
  }
  for (const w of watch) {
    let chat: any = null;
    for (const raw of w.ids) {
      const id = raw.includes("@") ? raw : `${raw.replace(/\D/g, "")}@c.us`;
      try { chat = await client.getChatById(id); } catch { chat = null; }
      if (chat) break;
    }
    if (!chat) {
      console.log(`[wa] open-loops catch-up: loop #${w.id}: chat not found`);
      continue;
    }
    try {
      const recent: MinimalMsg[] = await chat.fetchMessages({ limit: 30 });
      const missed = recent.filter((m) => !m.fromMe && m.timestamp > w.since);
      console.log(`[wa] open-loops catch-up: loop #${w.id}: ${missed.length} new message(s)`);
      if (missed.length === 0) continue;
      // One combined trigger (all missed messages, oldest first), addressed
      // as the newest message so the dashboard's id/timestamp checks apply.
      missed.sort((a, b) => a.timestamp - b.timestamp);
      const last = missed[missed.length - 1];
      const payload = await buildInboundPayload(last, chat.id._serialized, !!chat.isGroup);
      payload.catchUp = true;
      payload.text = missed.map((m) => loopMessageText(m)).filter(Boolean).join("\n");
      const { status, data } = await dashboardRequest("POST", "/api/loops/inbound", payload);
      if (status === 200) console.log(`[wa] open-loops catch-up: loop #${w.id}: fired=${data.slice(0, 60)}`);
    } catch (e) {
      console.warn(`[wa] open-loops catch-up: loop #${w.id} failed:`, (e as Error).message);
    }
  }
}

import pkg from "whatsapp-web.js";
const { Client, LocalAuth, MessageMedia } = pkg;
import qrcode from "qrcode";
import fs from "node:fs";
import path from "node:path";

export type WAClient = InstanceType<typeof Client>;

export interface ClientState {
  client: WAClient;
  state: "INITIALIZING" | "QR_REQUIRED" | "READY" | "DISCONNECTED";
  lastQrPng: Buffer | null;
  /** Resolves after the first "ready" has applied the WA Web page patches. */
  patched: Promise<void>;
}

// WA_AUTH_PATH lets the service run as its own Unix user with the session in a
// directory only that user can read (agents run as ubuntu and must not be able
// to read or drive the WhatsApp session).
export function buildClient(authPath = process.env.WA_AUTH_PATH ?? "/home/ubuntu/.wwebjs_auth"): ClientState {
  // Chrome used to run with --remote-debugging-port (puppeteer's default),
  // publishing the port in <profile>/DevToolsActivePort. Agents found it and
  // drove WhatsApp Web directly over CDP (2026-09-21 Nora double-send and
  // unapproved revoke). With pipe:true puppeteer talks to Chrome over
  // --remote-debugging-pipe (fds 3/4): no TCP port, no DevToolsActivePort.
  // Remove a stale port file left by an older launch so nothing points at it.
  try { fs.rmSync(path.join(authPath, "session", "DevToolsActivePort"), { force: true }); } catch { /* ignore */ }
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: authPath }),
    puppeteer: {
      headless: true,
      pipe: true,
      executablePath: "/usr/bin/google-chrome",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    },
  });
  let markPatched: () => void = () => {};
  const patched = new Promise<void>((resolve) => { markPatched = resolve; });
  const state: ClientState = { client, state: "INITIALIZING", lastQrPng: null, patched };

  client.on("qr", async (qr) => {
    state.state = "QR_REQUIRED";
    state.lastQrPng = await qrcode.toBuffer(qr, { type: "png", scale: 8 });
    console.log("[wa] QR_REQUIRED — scan via http://localhost:9334/qr");
  });
  client.on("ready", async () => {
    state.state = "READY";
    state.lastQrPng = null;
    console.log("[wa] READY");
    try {
      await patchGetMessagesById(client);
    } catch (e) {
      console.warn("[wa] getMessagesById patch failed:", e);
    }
    try {
      await patchMsgKeySerialized(client);
    } catch (e) {
      console.warn("[wa] MsgKey patch failed:", e);
    }
    try {
      await patchMessageIdSerialized(client);
    } catch (e) {
      console.warn("[wa] message id patch failed:", e);
    }
    markPatched();
  });
  client.on("disconnected", (reason) => {
    state.state = "DISCONNECTED";
    console.log("[wa] DISCONNECTED:", reason);
  });
  client.on("auth_failure", (msg) => {
    state.state = "DISCONNECTED";
    console.log("[wa] auth_failure:", msg);
  });

  return state;
}

// WA Web 2.3000.x: Msg.getMessagesById throws an IndexedDB DataError ("No key
// or key range specified") for ids that aren't cached in memory. whatsapp-web.js
// calls it from getChatModel to fill chat.lastMessage, so msg.getChat() failed
// (minified "r: r") for any chat whose last message was evicted - including the
// pilot group. Treat that DataError as "not found"; every library call site
// already reads the result as `?.messages?.[0]`. Idempotent per page load.
async function patchGetMessagesById(client: WAClient): Promise<void> {
  await client.pupPage?.evaluate(() => {
    const Msg = (globalThis as any).require("WAWebCollections").Msg;
    if (Msg.__ccPatched) return;
    const orig = Msg.getMessagesById.bind(Msg);
    Msg.getMessagesById = async (...args: unknown[]) => {
      try {
        return await orig(...args);
      } catch (e: any) {
        if (e?.name === "DataError") return { messages: [] };
        throw e;
      }
    };
    Msg.__ccPatched = true;
  });
  console.log("[wa] patched Msg.getMessagesById (DataError -> not found)");
}

// Page-side half of the MsgKey rename below: whatsapp-web.js reads
// `<MsgKey>._serialized` inside the page (e.g. sendMessage returns
// Msg.get(newMsgKey._serialized)), so sends "failed" with an undefined result
// even though the message went out. Restore `_serialized` on the MsgKey
// prototype as an alias of the minified `$1` field.
async function patchMsgKeySerialized(client: WAClient): Promise<void> {
  await client.pupPage?.evaluate(() => {
    const MsgKey = (globalThis as any).require("WAWebMsgKey");
    const proto = MsgKey?.prototype;
    if (!proto || Object.prototype.hasOwnProperty.call(proto, "_serialized")) return;
    Object.defineProperty(proto, "_serialized", {
      configurable: true,
      get() {
        return this.$1 ?? this.toString();
      },
    });
  });
  console.log("[wa] patched MsgKey.prototype._serialized");
}

// WA Web 2.3000.x renamed the MsgKey's serialized-id field from `_serialized`
// to a minified `$1`, so whatsapp-web.js messages arrive with
// msg.id._serialized === undefined. That broke recordInbound (NOT NULL
// message_id), reply quoting and dedup. Restore it from MsgKey.toString(),
// which still yields "<fromMe>_<remote>_<id>[_<participant>]". The function
// is re-injected on SPA reloads, so the flag lives on the function itself.
async function patchMessageIdSerialized(client: WAClient): Promise<void> {
  await client.pupPage?.evaluate(() => {
    const W = (globalThis as any).WWebJS;
    if (W.getMessageModel.__ccPatched) return;
    const orig = W.getMessageModel;
    const patched = (msg: any, ...rest: unknown[]) => {
      const model = orig(msg, ...rest);
      if (model?.id && !model.id._serialized && msg?.id?.toString) {
        model.id._serialized = msg.id.toString();
      }
      return model;
    };
    (patched as any).__ccPatched = true;
    W.getMessageModel = patched;
  });
  console.log("[wa] patched WWebJS.getMessageModel (restore id._serialized)");
}

export { MessageMedia };

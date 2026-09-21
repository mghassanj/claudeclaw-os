import pkg from "whatsapp-web.js";
const { Client, LocalAuth, MessageMedia } = pkg;
import qrcode from "qrcode";

export type WAClient = InstanceType<typeof Client>;

export interface ClientState {
  client: WAClient;
  state: "INITIALIZING" | "QR_REQUIRED" | "READY" | "DISCONNECTED";
  lastQrPng: Buffer | null;
}

export function buildClient(authPath = "/home/ubuntu/.wwebjs_auth"): ClientState {
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: authPath }),
    puppeteer: {
      headless: true,
      executablePath: "/usr/bin/google-chrome",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    },
  });
  const state: ClientState = { client, state: "INITIALIZING", lastQrPng: null };

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

export { MessageMedia };

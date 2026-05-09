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
  client.on("ready", () => {
    state.state = "READY";
    state.lastQrPng = null;
    console.log("[wa] READY");
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

export { MessageMedia };

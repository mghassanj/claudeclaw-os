// Bridge the WhatsApp self-chat to the MAIN agent in the dashboard process
// (loopback HTTP) so the self-chat shares one conversation + memory with
// Telegram main, instead of the standalone Jisr-support persona.
//
// Uses node:http rather than fetch: Node's fetch (undici) aborts after 300 s
// without response headers, and the dashboard only answers when the agent
// turn finishes. Long turns therefore "failed" at exactly 300 s while the
// agent kept running in the background (2026-09-21). The wait now covers the
// agent's own limit (AGENT_TIMEOUT_MS) plus time spent queued behind another
// turn on the same session.
import http from "node:http";

/** Channel metadata the dashboard's /api/agent/main-turn accepts (all optional). */
export interface MainBridgeMeta {
  channel: "whatsapp-self";
  lang?: "ar" | "en" | "unknown";
  inboundType?: "text" | "voice" | "image" | "document";
  image?: { base64: string; mime: string };
}

/** A file the agent asked to send with a [SEND_FILE:…] / [SEND_PHOTO:…] marker. */
export interface MainBridgeFile {
  type: "document" | "photo";
  filePath: string;
  caption?: string;
}

export interface MainBridgeReply {
  text: string;
  files: MainBridgeFile[];
}

/** Parse the dashboard response body; tolerant of an older server that only returns {text}. */
export function parseMainBridgeReply(data: string): MainBridgeReply {
  const parsed = JSON.parse(data || "{}") as { text?: unknown; files?: unknown };
  const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
  const files = Array.isArray(parsed.files)
    ? parsed.files.filter((f): f is MainBridgeFile =>
      !!f && typeof f === "object" && typeof (f as MainBridgeFile).filePath === "string"
      && ((f as MainBridgeFile).type === "document" || (f as MainBridgeFile).type === "photo"))
    : [];
  return { text: text || (files.length ? "" : "Done."), files };
}

export async function runMainBridge(text: string, meta?: MainBridgeMeta): Promise<MainBridgeReply> {
  const port = Number(process.env.DASHBOARD_PORT ?? "3141");
  const token = process.env.DASHBOARD_TOKEN ?? "";
  const agentTimeoutMs = Number(process.env.AGENT_TIMEOUT_MS ?? 900_000);
  const waitMs = agentTimeoutMs * 2 + 60_000;
  const body = JSON.stringify({ text, ...(meta ?? {}) });

  const { status, data } = await new Promise<{ status: number; data: string }>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/agent/main-turn",
        method: "POST",
        // Bearer header, not ?token=: keeps the token out of URLs and logs.
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        let chunks = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { chunks += c; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, data: chunks }));
        res.on("error", reject);
      },
    );
    const timer = setTimeout(() => req.destroy(new Error(`main-bridge timed out after ${Math.round(waitMs / 1000)}s`)), waitMs);
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.end(body);
  });

  if (status < 200 || status >= 300) {
    throw new Error(`main-bridge HTTP ${status} ${data.slice(0, 200)}`);
  }
  return parseMainBridgeReply(data);
}

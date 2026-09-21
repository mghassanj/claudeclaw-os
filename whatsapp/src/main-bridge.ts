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

export async function runMainBridge(text: string): Promise<string> {
  const port = Number(process.env.DASHBOARD_PORT ?? "3141");
  const token = process.env.DASHBOARD_TOKEN ?? "";
  const agentTimeoutMs = Number(process.env.AGENT_TIMEOUT_MS ?? 900_000);
  const waitMs = agentTimeoutMs * 2 + 60_000;
  const body = JSON.stringify({ text });

  const { status, data } = await new Promise<{ status: number; data: string }>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: `/api/agent/main-turn?token=${encodeURIComponent(token)}`,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
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
  const parsed = JSON.parse(data || "{}") as { text?: string };
  return (parsed.text ?? "").trim() || "Done.";
}

// Self-chat approvals for the outbound gateway: Mohamed replies
// "YES AB12" / "NO AB12" in his WhatsApp self-chat and it is forwarded to
// the main process (POST /api/outbound/decide), which executes the exact
// approved action once. Only strict "YES|NO <4-char code>" messages are
// candidates, and a code that matches no pending action falls through to
// the normal main-agent bridge, so ordinary chat ("no idea") is unaffected.
import http from "node:http";

export interface ApprovalReply { decision: "approve" | "reject"; code: string }

export function parseApprovalReply(text: string): ApprovalReply | null {
  const m = text.trim().match(/^(yes|no|✅|❌)[\s:#-]*([A-Za-z0-9]{4})[.!]?$/iu);
  if (!m) return null;
  const w = m[1].toLowerCase();
  return { decision: w === "yes" || w === "✅" ? "approve" : "reject", code: m[2].toUpperCase() };
}

export interface ForwardResult { handled: boolean; message: string }

export async function forwardApprovalDecision(reply: ApprovalReply): Promise<ForwardResult> {
  const port = Number(process.env.DASHBOARD_PORT ?? "3141");
  const token = process.env.DASHBOARD_TOKEN ?? "";
  const body = JSON.stringify({ code: reply.code, decision: reply.decision, via: "whatsapp" });
  const { status, data } = await new Promise<{ status: number; data: string }>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1", port, method: "POST",
        path: "/api/outbound/decide",
        // Bearer header, not ?token=: keeps the dashboard token out of URLs/logs.
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
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
    const timer = setTimeout(() => req.destroy(new Error("outbound decide timed out")), 120_000);
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.end(body);
  });
  if (status < 200 || status >= 300) throw new Error(`outbound decide HTTP ${status} ${data.slice(0, 200)}`);
  const parsed = JSON.parse(data || "{}") as { ok?: boolean; notFound?: boolean; message?: string };
  if (parsed.notFound) return { handled: false, message: parsed.message ?? "" };
  return { handled: true, message: parsed.message ?? (parsed.ok ? "Done." : "Not applied.") };
}

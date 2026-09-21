// Bridge the WhatsApp self-chat to the MAIN agent in the dashboard process
// (loopback HTTP) so the self-chat shares one conversation + memory with
// Telegram main, instead of the standalone Jisr-support persona.
export async function runMainBridge(text: string): Promise<string> {
  const port = process.env.DASHBOARD_PORT ?? "3141";
  const token = process.env.DASHBOARD_TOKEN ?? "";
  const url = `http://127.0.0.1:${port}/api/agent/main-turn?token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(920_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`main-bridge HTTP ${res.status} ${detail.slice(0, 200)}`);
  }
  const data = (await res.json()) as { text?: string };
  return (data.text ?? "").trim() || "Done.";
}

import http from "node:http";
import { sendMediaFromPath, sendVoice } from "./tools/send.js";
import type { ClientState } from "./client.js";
import {
  checkBearer, readJson, findContacts, chatMessages,
  validateSendAsMe, sendAsMe, validateRevoke, revokeAsMe,
} from "./wa-api.js";

// Local API on 127.0.0.1 (WHATSAPP_QR_PORT, default 9334).
// /health and /qr are open (healthcheck timer, QR re-scan tunnel). Every
// other route requires "Authorization: Bearer $WA_API_TOKEN" and fails
// closed with 503 when the token isn't configured: any local process
// (including an agent's Bash) used to be able to send as the bot.
function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function startHealthServer(state: ClientState, port: number): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const route = url.pathname;

    if (route === "/health") {
      json(res, 200, { state: state.state });
      return;
    }
    if (route === "/qr") {
      if (state.lastQrPng) {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(state.lastQrPng);
      } else {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end(`no QR pending (state=${state.state})`);
      }
      return;
    }

    const auth = checkBearer(req.headers.authorization, process.env.WA_API_TOKEN);
    if (auth !== "ok") {
      console.warn(`[wa-api] ${auth} ${req.method} ${route}`);
      json(res, auth === "unconfigured" ? 503 : 401, {
        ok: false,
        error: auth === "unconfigured" ? "WA_API_TOKEN not configured; API locked" : "unauthorized",
      });
      return;
    }

    try {
      const ready = () => {
        if (state.state !== "READY") throw new Error(`client not ready (state=${state.state})`);
      };

      // GET /contacts/find?q=
      if (req.method === "GET" && route === "/contacts/find") {
        ready();
        const q = url.searchParams.get("q") ?? "";
        if (!q.trim()) throw new Error("q required");
        json(res, 200, { ok: true, matches: await findContacts(state.client, q) });
        return;
      }
      // GET /chats/:id/messages?since=&limit=
      const m = route.match(/^\/chats\/([^/]+)\/messages$/);
      if (req.method === "GET" && m) {
        ready();
        const since = url.searchParams.get("since");
        const limit = Number(url.searchParams.get("limit") ?? "20") || 20;
        const messages = await chatMessages(state.client, decodeURIComponent(m[1]), since ? Number(since) : undefined, limit);
        json(res, 200, { ok: true, messages });
        return;
      }
      // POST /send-as-me {chatId, text, idempotencyKey, actionId}: gateway only.
      if (req.method === "POST" && route === "/send-as-me") {
        ready();
        const input = validateSendAsMe(await readJson(req));
        const r = await sendAsMe(state.client, input);
        console.log(`[wa-api] send-as-me action=${input.actionId ?? "?"} chat=${input.chatId} chars=${input.text.length} msg=${r.messageId ?? "?"}${r.duplicate ? " DUPLICATE-REFUSED" : ""}`);
        json(res, 200, { ok: true, messageId: r.messageId, timestamp: r.timestamp, duplicate: r.duplicate });
        return;
      }
      // POST /revoke-as-me {chatId, messageId, idempotencyKey, actionId}: gateway only.
      if (req.method === "POST" && route === "/revoke-as-me") {
        ready();
        const input = validateRevoke(await readJson(req));
        const r = await revokeAsMe(state.client, input);
        console.log(`[wa-api] revoke-as-me action=${input.actionId ?? "?"} chat=${input.chatId} msg=${input.messageId}${r.duplicate ? " DUPLICATE-REFUSED" : ""}`);
        json(res, 200, { ok: true, messageId: r.messageId, timestamp: r.timestamp, duplicate: r.duplicate });
        return;
      }
      // POST /send  { chatId, text }: bot replies, prefixed with 🤖 so the
      // loop-prevention filter in service.ts skips them.
      if (req.method === "POST" && route === "/send") {
        ready();
        const { chatId, text } = await readJson(req);
        if (!chatId || !text) throw new Error("chatId and text required");
        await state.client.sendMessage(chatId, `🤖 ${text}`);
        console.log(`[wa-api] send (bot) chat=${chatId} chars=${String(text).length}`);
        json(res, 200, { ok: true });
        return;
      }
      // POST /send-media  { chatId, filePath, caption? }
      if (req.method === "POST" && route === "/send-media") {
        ready();
        const { chatId, filePath, caption } = await readJson(req);
        if (!chatId || !filePath) throw new Error("chatId and filePath required");
        await sendMediaFromPath(state.client, chatId, filePath, caption);
        json(res, 200, { ok: true });
        return;
      }
      // POST /send-voice  { chatId, filePath }
      if (req.method === "POST" && route === "/send-voice") {
        ready();
        const { chatId, filePath } = await readJson(req);
        if (!chatId || !filePath) throw new Error("chatId and filePath required");
        await sendVoice(state.client, chatId, filePath);
        json(res, 200, { ok: true });
        return;
      }
    } catch (err: any) {
      console.warn(`[wa-api] ${req.method} ${route} failed: ${err?.message ?? err}`);
      json(res, 500, { ok: false, error: err?.message ?? String(err) });
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  server.listen(port, "127.0.0.1");
  console.log(`[wa] health/qr/api server on http://127.0.0.1:${port}`);
  return server;
}

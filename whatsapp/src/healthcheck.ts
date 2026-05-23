import http from "node:http";
import { sendMediaFromPath, sendVoice } from "./tools/send.js";
import type { ClientState } from "./client.js";

export function startHealthServer(state: ClientState, port: number): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ state: state.state }));
      return;
    }
    if (req.url === "/qr") {
      if (state.lastQrPng) {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(state.lastQrPng);
      } else {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end(`no QR pending (state=${state.state})`);
      }
      return;
    }
    // POST /send  { chatId, text }
    if (req.method === "POST" && req.url === "/send") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        try {
          const { chatId, text } = JSON.parse(body);
          if (!chatId || !text) throw new Error("chatId and text required");
          if (state.state !== "READY") throw new Error(`client not ready (state=${state.state})`);
          // Prefix with 🤖 so the loop-prevention filter in service.ts skips it
          await state.client.sendMessage(chatId, `🤖 ${text}`);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err: any) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }
    // POST /send-media  { chatId, filePath, caption? }
    if (req.method === "POST" && req.url === "/send-media") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        try {
          const { chatId, filePath, caption } = JSON.parse(body);
          if (!chatId || !filePath) throw new Error("chatId and filePath required");
          if (state.state !== "READY") throw new Error(`client not ready (state=${state.state})`);
          await sendMediaFromPath(state.client, chatId, filePath, caption);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err: any) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }
    // POST /send-voice  { chatId, filePath }
    if (req.method === "POST" && req.url === "/send-voice") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        try {
          const { chatId, filePath } = JSON.parse(body);
          if (!chatId || !filePath) throw new Error("chatId and filePath required");
          if (state.state !== "READY") throw new Error(`client not ready (state=${state.state})`);
          await sendVoice(state.client, chatId, filePath);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err: any) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  server.listen(port, "127.0.0.1");
  console.log(`[wa] health/qr server on http://127.0.0.1:${port}`);
  return server;
}

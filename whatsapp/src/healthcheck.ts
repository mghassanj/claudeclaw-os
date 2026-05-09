import http from "node:http";
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
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  server.listen(port, "127.0.0.1");
  console.log(`[wa] health/qr server on http://127.0.0.1:${port}`);
  return server;
}

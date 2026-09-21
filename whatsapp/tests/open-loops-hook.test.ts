import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  buildInboundPayload,
  catchUpOpenLoops,
  loopMessageText,
  notifyOpenLoops,
} from "../src/open-loops-hook.js";

interface Seen { method: string; url: string; auth: string | undefined; body: any }
const seen: Seen[] = [];
let watchLoops: Array<{ id: number; ids: string[]; since: number }> = [];
let server: http.Server;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/api/loops/watch") res.end(JSON.stringify({ loops: watchLoops }));
      else res.end(JSON.stringify({ fired: [42] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.DASHBOARD_PORT = String((server.address() as AddressInfo).port);
  process.env.DASHBOARD_TOKEN = "tok-123";
});
afterAll(() => { server.close(); });
beforeEach(() => { seen.length = 0; watchLoops = []; });

const msg = (over: Record<string, unknown> = {}) => ({
  id: { _serialized: "false_966500000001@c.us_ABC" },
  from: "966500000001@c.us",
  fromMe: false,
  body: "Thursday works",
  type: "chat",
  timestamp: 1_900_000_000,
  getContact: async () => ({ number: "966500000001", pushname: "Nora", id: { _serialized: "966500000001@c.us" } }),
  ...over,
});

describe("loopMessageText", () => {
  it("uses the body, or a placeholder for media", () => {
    expect(loopMessageText({ body: " hi " })).toBe("hi");
    expect(loopMessageText({ body: "", type: "ptt", hasMedia: true })).toContain("voice note");
    expect(loopMessageText({ body: "", type: "image", hasMedia: true })).toBe("[image attachment]");
  });
});

describe("buildInboundPayload", () => {
  it("collects sender ids (no group ids) and the display name", async () => {
    const p = await buildInboundPayload(msg({ from: "120363@g.us", author: "12345@lid" }) as any, "120363@g.us", true);
    expect(p.senderIds).toEqual(["12345@lid", "966500000001", "966500000001@c.us"]);
    expect(p.senderName).toBe("Nora");
    expect(p.isGroup).toBe(true);
  });

  it("survives contact lookup failures", async () => {
    const p = await buildInboundPayload(msg({ getContact: async () => { throw new Error("r: r"); } }) as any, "x@lid", false);
    expect(p.senderIds).toEqual(["966500000001@c.us"]);
  });
});

describe("notifyOpenLoops", () => {
  it("POSTs to /api/loops/inbound with a Bearer token (no token in the URL)", async () => {
    const fired = await notifyOpenLoops(msg() as any, "966500000001@c.us", false);
    expect(fired).toEqual([42]);
    expect(seen[0].url).toBe("/api/loops/inbound");
    expect(seen[0].auth).toBe("Bearer tok-123");
    expect(seen[0].body).toMatchObject({ chatId: "966500000001@c.us", text: "Thursday works", messageId: "false_966500000001@c.us_ABC", timestamp: 1_900_000_000 });
  });

  it("skips the account's own messages", async () => {
    expect(await notifyOpenLoops(msg({ fromMe: true }) as any, "966500000001@c.us", false)).toEqual([]);
    expect(seen).toHaveLength(0);
  });
});

describe("catchUpOpenLoops", () => {
  it("sends one combined trigger with the messages newer than the loop", async () => {
    watchLoops = [{ id: 42, ids: ["966500000001@c.us"], since: 1_900_000_000 }];
    const chat = {
      id: { _serialized: "966500000001@c.us" },
      isGroup: false,
      fetchMessages: async () => [
        msg({ body: "old", timestamp: 1_899_999_000 }),
        msg({ body: "first", timestamp: 1_900_000_100, id: { _serialized: "m1" } }),
        msg({ body: "mine", fromMe: true, timestamp: 1_900_000_150 }),
        msg({ body: "second", timestamp: 1_900_000_200, id: { _serialized: "m2" } }),
      ],
    };
    await catchUpOpenLoops({ getChatById: async () => chat });
    const posts = seen.filter((s) => s.url === "/api/loops/inbound");
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ text: "first\nsecond", messageId: "m2", catchUp: true, timestamp: 1_900_000_200 });
  });

  it("does nothing when no chat has new messages", async () => {
    watchLoops = [{ id: 42, ids: ["966500000001"], since: 1_900_000_000 }];
    const chat = { id: { _serialized: "966500000001@c.us" }, isGroup: false, fetchMessages: async () => [msg({ timestamp: 1 })] };
    let asked = "";
    await catchUpOpenLoops({ getChatById: async (id: string) => { asked = id; return chat; } });
    expect(asked).toBe("966500000001@c.us");
    expect(seen.filter((s) => s.url === "/api/loops/inbound")).toHaveLength(0);
  });
});

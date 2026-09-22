import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  checkBearer, matchContacts, onceByKey, _resetIdempotency, sendAsMe, revokeAsMe, validateSendAsMe,
  findContacts, cachedContactList, chatsAsContacts,
} from "../src/wa-api.js";
import { consumeExpectedOutgoing, wasSentByBot } from "../src/sent-registry.js";
import { parseApprovalReply } from "../src/outbound-approval.js";
import { startHealthServer } from "../src/healthcheck.js";

const KEY = "a".repeat(64);

describe("checkBearer", () => {
  it("fails closed when no token is configured", () => {
    expect(checkBearer("Bearer x", undefined)).toBe("unconfigured");
    expect(checkBearer("Bearer x", "")).toBe("unconfigured");
  });
  it("accepts only the exact bearer token", () => {
    expect(checkBearer("Bearer s3cret", "s3cret")).toBe("ok");
    expect(checkBearer("bearer s3cret", "s3cret")).toBe("ok");
    expect(checkBearer("Bearer s3cre", "s3cret")).toBe("denied");
    expect(checkBearer(undefined, "s3cret")).toBe("denied");
    expect(checkBearer("s3cret", "s3cret")).toBe("denied");
  });
});

describe("matchContacts", () => {
  const list = [
    { id: { _serialized: "me@c.us" }, name: "Nora me", isMe: true },
    { id: { _serialized: "966500000001@c.us" }, name: "Nora Alharbi", number: "966500000001", isMyContact: true },
    { id: { _serialized: "966500000002@c.us" }, pushname: "nora", number: "966500000002" },
    { id: { _serialized: "123@g.us" }, name: "Nora team", isGroup: true },
    { id: { _serialized: "966500000009@c.us" }, name: "Ali", number: "966500000009" },
  ];
  it("matches names case-insensitively, skips self, ranks exact names then saved contacts first", () => {
    const m = matchContacts(list, "NORA");
    expect(m.map((x) => x.id)).toEqual(["966500000002@c.us", "966500000001@c.us", "123@g.us"]);
    expect(m[2].isGroup).toBe(true);
  });
  it("matches phone digits (>= 4)", () => {
    expect(matchContacts(list, "+966 50 000 0009").map((x) => x.id)).toEqual(["966500000009@c.us"]);
    expect(matchContacts(list, "00")).toEqual([]);
  });
});

describe("findContacts cache", () => {
  const contacts = [
    { id: { _serialized: "966500000001@c.us" }, name: "Nora Alharbi", number: "966500000001", isMyContact: true },
  ];
  const chats = [
    { id: { _serialized: "120363000000000001@g.us" }, name: "Payroll Squad", isGroup: true },
    { id: { _serialized: "966500000001@c.us" }, name: "Nora Alharbi" },
    { id: { _serialized: "966500000007@c.us" }, formattedTitle: "Abu Fahad" },
  ];
  const makeClient = () => ({
    getContacts: vi.fn(async () => contacts),
    getChats: vi.fn(async () => chats),
  });
  const saved = process.env.WA_CONTACTS_CACHE_MS;
  afterEach(() => { if (saved === undefined) delete process.env.WA_CONTACTS_CACHE_MS; else process.env.WA_CONTACTS_CACHE_MS = saved; });

  it("second lookup is served from the cache without calling getContacts again", async () => {
    const client = makeClient();
    expect((await findContacts(client as any, "nora")).map((m) => m.id)).toEqual(["966500000001@c.us"]);
    expect((await findContacts(client as any, "alharbi")).map((m) => m.id)).toEqual(["966500000001@c.us"]);
    expect(client.getContacts).toHaveBeenCalledTimes(1);
    expect(client.getChats).toHaveBeenCalledTimes(1);
  });

  it("matches chat titles (group subjects, formattedTitle) and de-dupes against contacts", async () => {
    const client = makeClient();
    const g = await findContacts(client as any, "payroll");
    expect(g).toEqual([{ id: "120363000000000001@g.us", name: "Payroll Squad", number: undefined, isGroup: true, isMyContact: false }]);
    expect((await findContacts(client as any, "abu fahad")).map((m) => m.id)).toEqual(["966500000007@c.us"]);
    const nora = await findContacts(client as any, "Nora");
    expect(nora).toHaveLength(1);
    expect(nora[0]).toMatchObject({ number: "966500000001", isMyContact: true });
  });

  it("serves stale data immediately and refreshes once in the background after the TTL", async () => {
    process.env.WA_CONTACTS_CACHE_MS = "1000";
    const client = makeClient();
    await cachedContactList(client as any);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const updated = [...contacts, { id: { _serialized: "966500000002@c.us" }, name: "Nora B", number: "966500000002" }];
    client.getContacts.mockImplementationOnce(async () => { await gate; return updated; });
    const later = Date.now() + 5_000;
    const stale = await cachedContactList(client as any, later);
    const stale2 = await cachedContactList(client as any, later);
    expect(stale.some((c) => c.id._serialized === "966500000002@c.us")).toBe(false);
    expect(stale2).toBe(stale);
    expect(client.getContacts).toHaveBeenCalledTimes(2); // one background refresh, not two
    release();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const fresh = await cachedContactList(client as any);
    expect(fresh.some((c) => c.id._serialized === "966500000002@c.us")).toBe(true);
  });

  it("a failed first load is not cached; a getChats failure still returns contacts", async () => {
    const client = makeClient();
    client.getContacts.mockRejectedValueOnce(new Error("page crashed"));
    await expect(findContacts(client as any, "nora")).rejects.toThrow("page crashed");
    client.getChats.mockRejectedValueOnce(new Error("no chats"));
    expect((await findContacts(client as any, "nora")).map((m) => m.id)).toEqual(["966500000001@c.us"]);
    expect(client.getContacts).toHaveBeenCalledTimes(2);
  });

  it("chatsAsContacts drops untitled chats", () => {
    expect(chatsAsContacts([{ id: { _serialized: "x@c.us" } }])).toEqual([]);
  });
});

describe("gateway sends", () => {
  beforeEach(() => _resetIdempotency());

  it("onceByKey runs an operation once per key, returning duplicate=true after", async () => {
    const op = vi.fn(async () => ({ messageId: "m1", timestamp: 1, at: Date.now() }));
    const [a, b] = await Promise.all([onceByKey("k", op), onceByKey("k", op)]);
    const c = await onceByKey("k", op);
    expect(op).toHaveBeenCalledTimes(1);
    expect([a.duplicate, b.duplicate, c.duplicate]).toEqual([false, true, true]);
    expect(c.messageId).toBe("m1");
  });

  it("sendAsMe sends the raw text (no 🤖 prefix) once, and registers the echo", async () => {
    const client = {
      sendMessage: vi.fn(async (_chatId: string, _text: string) => ({ id: { _serialized: "true_x@c.us_ID1" }, timestamp: 1700000000 })),
    };
    const input = validateSendAsMe({ chatId: "966500000001@c.us", text: "مرحبا", idempotencyKey: KEY, actionId: 5 });
    const r1 = await sendAsMe(client as any, input);
    const r2 = await sendAsMe(client as any, input);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.sendMessage).toHaveBeenCalledWith("966500000001@c.us", "مرحبا");
    expect(r1).toMatchObject({ messageId: "true_x@c.us_ID1", duplicate: false });
    expect(r2.duplicate).toBe(true);
    expect(wasSentByBot("true_x@c.us_ID1")).toBe(true);
    expect(consumeExpectedOutgoing("966500000001@c.us", "مرحبا")).toBe(true);
    expect(consumeExpectedOutgoing("966500000001@c.us", "مرحبا")).toBe(false);
  });

  it("validates send-as-me input", () => {
    expect(() => validateSendAsMe({ chatId: "Nora", text: "x", idempotencyKey: KEY })).toThrow(/chatId/);
    expect(() => validateSendAsMe({ chatId: "1@c.us", text: " ", idempotencyKey: KEY })).toThrow(/text/);
    expect(() => validateSendAsMe({ chatId: "1@c.us", text: "x" })).toThrow(/idempotencyKey/);
  });

  it("revokeAsMe only deletes Mohamed's own message in the named chat", async () => {
    const del = vi.fn(async () => {});
    const own = { fromMe: true, id: { remote: "966500000001@c.us" }, delete: del };
    const theirs = { fromMe: false, id: { remote: "966500000001@c.us" }, delete: del };
    const client = { getMessageById: vi.fn() };
    client.getMessageById.mockResolvedValueOnce(theirs);
    await expect(revokeAsMe(client as any, { chatId: "966500000001@c.us", messageId: "m", idempotencyKey: KEY })).rejects.toThrow(/own messages/);
    client.getMessageById.mockResolvedValueOnce(own);
    await expect(revokeAsMe(client as any, { chatId: "other@c.us", messageId: "m", idempotencyKey: "b".repeat(64) })).rejects.toThrow(/belongs to/);
    client.getMessageById.mockResolvedValueOnce(own);
    await revokeAsMe(client as any, { chatId: "966500000001@c.us", messageId: "m", idempotencyKey: "c".repeat(64) });
    expect(del).toHaveBeenCalledWith(true);
  });
});

describe("parseApprovalReply", () => {
  it.each([
    ["YES AB12", { decision: "approve", code: "AB12" }],
    ["yes ab12", { decision: "approve", code: "AB12" }],
    ["Yes: K7PQ.", { decision: "approve", code: "K7PQ" }],
    ["NO AB12", { decision: "reject", code: "AB12" }],
    ["✅ AB12", { decision: "approve", code: "AB12" }],
  ])("parses %j", (text, expected) => {
    expect(parseApprovalReply(text)).toEqual(expected);
  });
  it.each(["yes please send it", "ok AB12", "no", "YES AB123", "send AB12", "reply to Nora: yes AB12"])("ignores %j", (text) => {
    expect(parseApprovalReply(text)).toBeNull();
  });
});

describe("local API server auth", () => {
  let server: http.Server;
  let port: number;
  const saved = process.env.WA_API_TOKEN;
  const state = { state: "READY", lastQrPng: null, client: {
    getContacts: vi.fn(async () => [{ id: { _serialized: "966500000001@c.us" }, name: "Nora" }]),
    sendMessage: vi.fn(async () => ({ id: { _serialized: "ID9" }, timestamp: 1 })),
  } } as any;

  const call = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
    new Promise<{ status: number; data: any }>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({ host: "127.0.0.1", port, path, method, headers: { ...headers, ...(payload ? { "content-type": "application/json" } : {}) } }, (res) => {
        let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => {
          let data: any = s; try { data = JSON.parse(s); } catch { /* text */ }
          resolve({ status: res.statusCode ?? 0, data });
        });
      });
      req.on("error", reject);
      req.end(payload);
    });

  beforeEach(async () => {
    _resetIdempotency();
    server = startHealthServer(state, 0);
    await new Promise((r) => server.once("listening", r));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(() => {
    server.close();
    if (saved === undefined) delete process.env.WA_API_TOKEN; else process.env.WA_API_TOKEN = saved;
  });

  it("keeps /health open, locks everything else without a configured token", async () => {
    delete process.env.WA_API_TOKEN;
    expect((await call("GET", "/health")).data).toEqual({ state: "READY" });
    expect((await call("POST", "/send", {}, { chatId: "1@c.us", text: "x" })).status).toBe(503);
    expect((await call("GET", "/contacts/find?q=nora")).status).toBe(503);
    expect(state.client.sendMessage).not.toHaveBeenCalled();
  });

  it("requires the bearer token for send and read routes", async () => {
    process.env.WA_API_TOKEN = "tok";
    expect((await call("POST", "/send-as-me", { authorization: "Bearer nope" }, { chatId: "1@c.us", text: "x", idempotencyKey: KEY })).status).toBe(401);
    expect(state.client.sendMessage).not.toHaveBeenCalled();
    const found = await call("GET", "/contacts/find?q=nora", { authorization: "Bearer tok" });
    expect(found).toMatchObject({ status: 200, data: { ok: true, matches: [{ id: "966500000001@c.us", name: "Nora" }] } });
    const sent = await call("POST", "/send-as-me", { authorization: "Bearer tok" }, { chatId: "1@c.us", text: "hello", idempotencyKey: KEY, actionId: 3 });
    expect(sent).toMatchObject({ status: 200, data: { ok: true, messageId: "ID9", duplicate: false } });
    expect(state.client.sendMessage).toHaveBeenCalledWith("1@c.us", "hello");
  });
});

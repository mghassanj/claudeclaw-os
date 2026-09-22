import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/client.js", () => ({ MessageMedia: class {} }));

import { BRIDGE_FALLBACK_TEXT, bridgeInboundText, deliverBridgeFiles } from "../src/self-chat.js";
import { parseMainBridgeReply } from "../src/main-bridge.js";
import { sendText } from "../src/tools/send.js";
import { wasSentByBot } from "../src/sent-registry.js";

describe("bridgeInboundText", () => {
  it("tags voice notes like Telegram", () => {
    expect(bridgeInboundText("voice", " ذكرني بالاجتماع بكرة ", "")).toBe("[Voice transcribed]: ذكرني بالاجتماع بكرة");
  });
  it("sends only the caption for images and passes text/documents through", () => {
    expect(bridgeInboundText("image", "[image attached — describe…]", " what is this? ")).toBe("what is this?");
    expect(bridgeInboundText("image", "[image attached — describe…]", "")).toBe("");
    expect(bridgeInboundText("text", "hello", "hello")).toBe("hello");
    const doc = "[Document attached: a.pdf, 10 bytes]\n\nExtracted content:\nInvoice total 500";
    expect(bridgeInboundText("document", doc, "")).toBe(doc);
  });
});

describe("BRIDGE_FALLBACK_TEXT", () => {
  it("is bilingual and says not to resend", () => {
    expect(BRIDGE_FALLBACK_TEXT).toMatch(/don't resend/);
    expect(BRIDGE_FALLBACK_TEXT).toMatch(/may still be running/);
    expect(BRIDGE_FALLBACK_TEXT).toContain("للحين شغالة");
    expect(BRIDGE_FALLBACK_TEXT).toContain("لا تعيد ترسلها");
    expect(BRIDGE_FALLBACK_TEXT).not.toMatch(/Couldn.t reach/);
  });
});

describe("parseMainBridgeReply", () => {
  it("reads text + valid files, drops junk", () => {
    const r = parseMainBridgeReply(JSON.stringify({
      text: " hi ",
      files: [{ type: "document", filePath: "/tmp/a.pdf", caption: "A" }, { type: "exe", filePath: "/x" }, null, { type: "photo" }],
    }));
    expect(r).toEqual({ text: "hi", files: [{ type: "document", filePath: "/tmp/a.pdf", caption: "A" }] });
  });
  it("works with an older server that only returns {text}", () => {
    expect(parseMainBridgeReply(JSON.stringify({ text: "ok" }))).toEqual({ text: "ok", files: [] });
    expect(parseMainBridgeReply("{}")).toEqual({ text: "Done.", files: [] });
  });
  it("allows a files-only reply", () => {
    expect(parseMainBridgeReply(JSON.stringify({ text: "", files: [{ type: "photo", filePath: "/tmp/p.png" }] })).text).toBe("");
  });
});

describe("deliverBridgeFiles", () => {
  it("sends existing local files and notes missing or non-local ones", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-files-"));
    const good = path.join(dir, "report.pdf");
    fs.writeFileSync(good, "x");
    const sendMedia = vi.fn(async () => "msg-1");
    const notes: string[] = [];
    const out = await deliverBridgeFiles(
      [
        { type: "document", filePath: good, caption: "Report" },
        { type: "document", filePath: path.join(dir, "missing.pdf") },
        { type: "photo", filePath: "https://example.com/p.png" },
      ],
      sendMedia,
      async (t) => { notes.push(t); },
    );
    expect(sendMedia).toHaveBeenCalledWith(good, "Report");
    expect(out.sent).toEqual([good]);
    expect(out.failed).toHaveLength(2);
    expect(out.firstMsgId).toBe("msg-1");
    expect(notes[0]).toMatch(/not found/);
    expect(notes[1]).toMatch(/not a local path/);
  });

  it("keeps going when one send throws", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-files-"));
    const a = path.join(dir, "a.png"); fs.writeFileSync(a, "x");
    const b = path.join(dir, "b.png"); fs.writeFileSync(b, "x");
    const sendMedia = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("msg-b");
    const out = await deliverBridgeFiles([{ type: "photo", filePath: a }, { type: "photo", filePath: b }], sendMedia, async () => {});
    expect(out.sent).toEqual([b]);
    expect(out.failed).toEqual([a]);
  });
});

describe("sendText", () => {
  it("formats, splits long replies, prefixes every part, quotes only the first", async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const client = { sendMessage: vi.fn(async () => ({ id: { _serialized: `id-${++n}` } })) };
      const para = (i: number) => `**Point ${i}** ` + "كلمة ".repeat(120).trim();
      const text = Array.from({ length: 4 }, (_, i) => para(i)).join("\n\n");
      const p = sendText(client as never, "self@lid", text, "quoted-1");
      await vi.runAllTimersAsync();
      const first = await p;
      const calls = client.sendMessage.mock.calls as unknown as Array<[string, string, { quotedMessageId?: string }]>;
      expect(calls.length).toBeGreaterThan(1);
      expect(first).toBe("id-1");
      calls.forEach(([chat, body, opts], i) => {
        expect(chat).toBe("self@lid");
        expect(body.startsWith("\u{1F916} ")).toBe(true);
        expect(body).not.toContain("**");
        expect(Array.from(body).length).toBeLessThanOrEqual(1500 + 3);
        expect(opts.quotedMessageId).toBe(i === 0 ? "quoted-1" : undefined);
      });
      for (let i = 1; i <= calls.length; i++) expect(wasSentByBot(`id-${i}`)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

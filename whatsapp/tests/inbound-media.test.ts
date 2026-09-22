import { describe, it, expect, vi } from "vitest";
import {
  describeInbound, fitAttachments, formatLocation, formatPoll, formatVCards, isSkippable,
  type InboundMsg, type MediaDeps,
} from "../src/inbound-media.js";

const b64 = (s: string) => Buffer.from(s).toString("base64");

function deps(over: Partial<MediaDeps> = {}): MediaDeps {
  return {
    transcribe: vi.fn(async () => "hello from audio"),
    extractDocument: vi.fn(async () => "Invoice total 500 SAR, due 30 September, payable to Jisr"),
    ocrPdf: vi.fn(async () => ({ text: "فاتورة رقم ١٢", pages: [Buffer.from("PAGE1"), Buffer.from("PAGE2")] })),
    toMp3: vi.fn(async () => Buffer.from("MP3")),
    videoFrames: vi.fn(async () => ({ frames: [Buffer.from("F1"), Buffer.from("F2"), Buffer.from("F3")], seconds: 12.4 })),
    stickerToPng: vi.fn(async () => Buffer.from("PNG")),
    ...over,
  };
}

function msg(over: Partial<InboundMsg> & { file?: { data: string; mimetype: string; filename?: string } }): InboundMsg {
  const { file, ...rest } = over;
  return { type: "chat", body: "", hasMedia: !!file, downloadMedia: async () => file, ...rest };
}

describe("describeInbound", () => {
  it("passes plain text through", async () => {
    expect(await describeInbound(msg({ body: "hi" }), deps())).toEqual({ kind: "text", text: "hi", attachments: [] });
  });

  it("skips reactions, deletions and system messages", async () => {
    for (const type of ["revoked", "reaction", "e2e_notification", "album"]) {
      expect(await describeInbound(msg({ type }), deps())).toBeNull();
    }
    expect(isSkippable("chat")).toBe(false);
  });

  it("transcribes voice notes without forwarding the audio", async () => {
    const r = await describeInbound(msg({ type: "ptt", file: { data: b64("OGG"), mimetype: "audio/ogg; codecs=opus" } }), deps());
    expect(r).toMatchObject({ kind: "voice", text: "hello from audio", attachments: [] });
  });

  it("transcodes and transcribes audio files, keeping the original", async () => {
    const d = deps();
    const r = await describeInbound(msg({ type: "audio", body: "listen", file: { data: b64("AMR"), mimetype: "audio/amr", filename: "call.amr" } }), d);
    expect(d.toMp3).toHaveBeenCalled();
    expect(r?.kind).toBe("audio");
    expect(r?.text).toContain("Transcript: hello from audio");
    expect(r?.text).toContain("Message: listen");
    expect(r?.attachments[0]).toMatchObject({ role: "original", filename: "call.amr" });
  });

  it("extracts documents and forwards the original", async () => {
    const r = await describeInbound(msg({ type: "document", body: "what's due?", file: { data: b64("%PDF"), mimetype: "application/pdf", filename: "inv.pdf" } }), deps());
    expect(r?.kind).toBe("document");
    expect(r?.text).toContain("Invoice total 500 SAR");
    expect(r?.text).toContain("Message with the document: what's due?");
    expect(r?.attachments).toHaveLength(1);
  });

  it("OCRs a scanned PDF and attaches page images", async () => {
    const d = deps({ extractDocument: vi.fn(async () => "  \n ") });
    const r = await describeInbound(msg({ type: "document", file: { data: b64("%PDF"), mimetype: "application/pdf", filename: "scan.pdf" } }), d);
    expect(d.ocrPdf).toHaveBeenCalled();
    expect(r?.text).toContain("فاتورة رقم ١٢");
    expect(r?.text).toContain("OCR");
    expect(r?.attachments.map((a) => a.filename)).toEqual(["scan.pdf", "page-1.png", "page-2.png"]);
    expect(r?.image?.mime).toBe("image/png");
  });

  it("reads plain-text documents directly and still answers unsupported types", async () => {
    const txt = await describeInbound(msg({ type: "document", file: { data: b64("a,b\n1,2"), mimetype: "text/csv", filename: "t.csv" } }), deps());
    expect(txt?.text).toContain("a,b\n1,2");
    const d = deps({ extractDocument: vi.fn(async () => { throw new Error("unsupported document mimetype"); }) });
    const pptx = await describeInbound(msg({ type: "document", file: { data: b64("PK"), mimetype: "application/vnd.ms-powerpoint", filename: "deck.ppt" } }), d);
    expect(pptx?.text).toContain("Text extraction not available");
    expect(pptx?.attachments[0].filename).toBe("deck.ppt");
  });

  it("treats images sent as documents as images", async () => {
    const r = await describeInbound(msg({ type: "document", file: { data: b64("JPG"), mimetype: "image/jpeg", filename: "photo.jpg" } }), deps());
    expect(r?.kind).toBe("image");
    expect(r?.image).toEqual({ base64: b64("JPG"), mime: "image/jpeg" });
  });

  it("describes videos with frames and a transcript", async () => {
    const r = await describeInbound(msg({ type: "video", body: "see this", file: { data: b64("MP4"), mimetype: "video/mp4" } }), deps());
    expect(r?.kind).toBe("video");
    expect(r?.text).toContain("12s");
    expect(r?.text).toContain("Audio transcript: hello from audio");
    expect(r?.attachments.map((a) => a.role)).toEqual(["original", "derived", "derived", "derived"]);
    expect(r?.image?.base64).toBe(Buffer.from("F2").toString("base64"));
  });

  it("does not transcribe GIFs", async () => {
    const d = deps();
    const r = await describeInbound(msg({ type: "gif", file: { data: b64("MP4"), mimetype: "video/mp4" } }), d);
    expect(d.transcribe).not.toHaveBeenCalled();
    expect(r?.text).toContain("GIF");
  });

  it("converts stickers to PNG for vision", async () => {
    const r = await describeInbound(msg({ type: "sticker", file: { data: b64("WEBP"), mimetype: "image/webp" } }), deps());
    expect(r).toMatchObject({ kind: "sticker", image: { mime: "image/png" } });
  });

  it("explains a failed download instead of throwing", async () => {
    const m = msg({ type: "document", hasMedia: true, downloadMedia: async () => { throw new Error("media expired"); } });
    const r = await describeInbound(m, deps());
    expect(r?.text).toContain("couldn't be downloaded: media expired");
    const empty = await describeInbound(msg({ type: "image", hasMedia: true, downloadMedia: async () => undefined }), deps());
    expect(empty?.text).toContain("may have expired");
  });

  it("describes locations, contacts, polls and other types", async () => {
    const loc = await describeInbound(msg({ type: "location", location: { latitude: "24.7", longitude: 46.6, name: "Jisr HQ" } }), deps());
    expect(loc?.text).toContain("https://maps.google.com/?q=24.7,46.6");
    const card = await describeInbound(msg({ type: "vcard", body: "BEGIN:VCARD\nFN:Sara Ali\nTEL;type=CELL:+966500000000\nEND:VCARD" }), deps());
    expect(card?.text).toContain("Sara Ali");
    const poll = await describeInbound(msg({ type: "poll_creation", pollName: "Lunch?", pollOptions: [{ name: "Yes" }, { name: "No" }] }), deps());
    expect(poll?.text).toBe("[Poll: Lunch?]\n1. Yes\n2. No");
    const other = await describeInbound(msg({ type: "product" }), deps());
    expect(other?.kind).toBe("other");
  });
});

describe("formatters", () => {
  it("formats a location without coordinates", () => {
    expect(formatLocation({})).toContain("no coordinates");
  });
  it("parses multi vCards with N and item-prefixed TEL", () => {
    const t = formatVCards(["BEGIN:VCARD\nN:Ali;Omar;;;\nitem1.TEL:+1 555\nEMAIL:o@x.com\nORG:Acme;\nEND:VCARD", "BEGIN:VCARD\nFN:B\nEND:VCARD"]);
    expect(t).toContain("Contact cards (2)");
    expect(t).toContain("Omar Ali");
    expect(t).toContain("Phone: +1 555");
    expect(t).toContain("Org: Acme");
  });
  it("formats a poll with string options", () => {
    expect(formatPoll(undefined, ["a"])).toBe("[Poll: (no question)]\n1. a");
  });
});

describe("fitAttachments", () => {
  it("keeps files in order until the budget runs out", () => {
    const a = (n: number, name: string) => ({ base64: "A".repeat(n), mime: "x/y", filename: name, role: "original" as const });
    const { kept, dropped } = fitAttachments([a(400, "big"), a(40, "s1"), a(40, "s2")], 330);
    expect(kept.map((k) => k.filename)).toEqual(["big", "s1"]);
    expect(dropped.map((d) => d.filename)).toEqual(["s2"]);
  });
});

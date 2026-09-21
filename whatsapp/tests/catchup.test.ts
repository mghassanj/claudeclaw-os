import { describe, it, expect } from "vitest";
import { selectMissed, isSelfChatCandidate, type CatchUpMsg } from "../src/catchup.js";

const m = (ts: number, body: string, fromMe = true): CatchUpMsg => ({
  timestamp: ts, fromMe, body, id: { _serialized: `id-${ts}` },
});
const isBot = (x: CatchUpMsg) => x.fromMe && (x.body ?? "").startsWith("\u{1F916}");

describe("selectMissed", () => {
  const opts = { cutoff: 100, readyAt: 1000, isBotMsg: isBot };

  it("replays only messages after the last bot reply, inside the window, before READY", () => {
    const recent = [
      m(50, "too old"),
      m(200, "answered"),
      m(300, "\u{1F916} reply"),
      m(400, "missed 1"),
      m(500, "missed 2"),
      m(1200, "after ready"),
    ];
    expect(selectMissed(recent, opts).map((x) => x.body)).toEqual(["missed 1", "missed 2"]);
  });

  it("an interim note excluded from isBotMsg does not hide the message it was about", () => {
    const recent = [
      m(300, "\u{1F916} reply"),
      m(400, "long task"),
      m(460, "\u{1F916} Still working on it…"),
    ];
    const isReply = (x: CatchUpMsg) => isBot(x) && !(x.body ?? "").includes("Still working on it");
    const out = selectMissed(recent, { ...opts, isBotMsg: isReply }).filter((x) => !isBot(x));
    expect(out.map((x) => x.body)).toEqual(["long task"]);
    // With the plain bot filter (group behavior) it would be hidden.
    expect(selectMissed(recent, opts)).toEqual([]);
  });
});

describe("isSelfChatCandidate", () => {
  const self = { selfId: "966500000000@c.us", selfUser: "966500000000", selfLids: ["123456789"] };
  it("matches the @lid self chat via WHATSAPP_SELF_LIDS", () => {
    expect(isSelfChatCandidate({ isGroup: false, id: { _serialized: "123456789@lid", user: "123456789" } }, self)).toBe(true);
  });
  it("matches own wid / phone user and contact.isMe", () => {
    expect(isSelfChatCandidate({ isGroup: false, id: { _serialized: "966500000000@c.us", user: "966500000000" } }, self)).toBe(true);
    expect(isSelfChatCandidate({ isGroup: false, id: { _serialized: "x@lid", user: "x" } }, { ...self, contactIsMe: true })).toBe(true);
  });
  it("rejects other DMs and groups", () => {
    expect(isSelfChatCandidate({ isGroup: false, id: { _serialized: "966511111111@c.us", user: "966511111111" } }, self)).toBe(false);
    expect(isSelfChatCandidate({ isGroup: true, id: { _serialized: "123456789@g.us", user: "123456789" } }, self)).toBe(false);
  });
});

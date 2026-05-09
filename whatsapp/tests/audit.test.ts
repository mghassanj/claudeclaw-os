import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { recordInbound, recordReply, alreadyReplied, close as closeAudit } from "../src/audit.js";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const SUFFIX = `test-${Date.now()}`;

describe("audit", () => {
  afterAll(async () => {
    await pool.query("DELETE FROM whatsapp_exchanges WHERE group_id LIKE $1", [`${SUFFIX}%`]);
    await pool.end();
    await closeAudit();
  });

  it("recordInbound creates a row, idempotent on (group_id, message_id)", async () => {
    const msgId = `msg-${Date.now()}`;
    const groupId = `${SUFFIX}-group`;
    await recordInbound({
      groupId, groupName: "Test", senderNumber: "+1", senderName: "T",
      messageId: msgId, inboundText: "hello", inboundType: "text",
      inboundLang: "en", inboundAt: new Date(),
    });
    // second call with same key is no-op
    await recordInbound({
      groupId, groupName: "Test", senderNumber: "+1", senderName: "T",
      messageId: msgId, inboundText: "hello again (ignored)", inboundType: "text",
      inboundLang: "en", inboundAt: new Date(),
    });
    const r = await pool.query(
      "SELECT count(*) AS n, max(inbound_text) AS txt FROM whatsapp_exchanges WHERE group_id=$1 AND message_id=$2",
      [groupId, msgId],
    );
    expect(parseInt(r.rows[0].n, 10)).toBe(1);
    expect(r.rows[0].txt).toBe("hello");
  });

  it("recordReply updates the row", async () => {
    const msgId = `msg-rep-${Date.now()}`;
    const groupId = `${SUFFIX}-group`;
    await recordInbound({
      groupId, groupName: "Test", senderNumber: "+1", senderName: "T",
      messageId: msgId, inboundText: "Q?", inboundType: "text",
      inboundLang: "en", inboundAt: new Date(),
    });
    await recordReply({
      groupId, messageId: msgId, chosenTier: "1",
      toolsCalled: ["search_enterprise_kb"], sourcesCited: ["qiwa-sa"],
      replyText: "🤖 answer", replyMediaUrl: null, replyAt: new Date(), replyMsgId: "out-1",
      durationMs: 1234, costEstimate: 0.001, error: null,
    });
    const r = await pool.query(
      "SELECT chosen_tier, reply_text, sources_cited FROM whatsapp_exchanges WHERE group_id=$1 AND message_id=$2",
      [groupId, msgId],
    );
    expect(r.rows[0].chosen_tier).toBe("1");
    expect(r.rows[0].reply_text).toBe("🤖 answer");
    expect(r.rows[0].sources_cited).toEqual(["qiwa-sa"]);
  });

  it("alreadyReplied returns true after recordReply", async () => {
    const msgId = `msg-ar-${Date.now()}`;
    const groupId = `${SUFFIX}-group`;
    await recordInbound({
      groupId, groupName: "Test", senderNumber: "+1", senderName: "T",
      messageId: msgId, inboundText: "Q?", inboundType: "text",
      inboundLang: "en", inboundAt: new Date(),
    });
    expect(await alreadyReplied(groupId, msgId)).toBe(false);
    await recordReply({
      groupId, messageId: msgId, chosenTier: "1",
      toolsCalled: [], sourcesCited: [],
      replyText: "ok", replyMediaUrl: null, replyAt: new Date(), replyMsgId: "out-2",
      durationMs: 100, costEstimate: 0, error: null,
    });
    expect(await alreadyReplied(groupId, msgId)).toBe(true);
  });
});

import { Pool } from "pg";

let _pool: Pool | null = null;
function pool(): Pool {
  if (!_pool) _pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return _pool;
}

export interface InboundRecord {
  groupId: string;
  groupName: string | null;
  senderNumber: string | null;
  senderName: string | null;
  messageId: string;
  inboundText: string;
  inboundType: "text" | "voice" | "image";
  inboundLang: "ar" | "en" | "unknown" | null;
  inboundAt: Date;
}

export async function recordInbound(r: InboundRecord): Promise<void> {
  await pool().query(
    `INSERT INTO whatsapp_exchanges
       (group_id, group_name, sender_number, sender_name, message_id,
        inbound_text, inbound_type, inbound_lang, inbound_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (group_id, message_id) DO NOTHING`,
    [r.groupId, r.groupName, r.senderNumber, r.senderName, r.messageId,
     r.inboundText, r.inboundType, r.inboundLang, r.inboundAt],
  );
}

export interface ReplyRecord {
  groupId: string;
  messageId: string;
  chosenTier: string;
  toolsCalled: string[];
  sourcesCited: string[];
  replyText: string | null;
  replyMediaUrl: string | null;
  replyAt: Date;
  replyMsgId: string | null;
  durationMs: number;
  costEstimate: number;
  error: string | null;
}

export async function recordReply(r: ReplyRecord): Promise<void> {
  await pool().query(
    `UPDATE whatsapp_exchanges SET
       chosen_tier=$3, tools_called=$4, sources_cited=$5,
       reply_text=$6, reply_media_url=$7, reply_at=$8, reply_msg_id=$9,
       duration_ms=$10, cost_estimate=$11, error=$12
     WHERE group_id=$1 AND message_id=$2`,
    [r.groupId, r.messageId,
     r.chosenTier, r.toolsCalled, r.sourcesCited,
     r.replyText, r.replyMediaUrl, r.replyAt, r.replyMsgId,
     r.durationMs, r.costEstimate, r.error],
  );
}

export async function alreadyReplied(groupId: string, messageId: string): Promise<boolean> {
  const r = await pool().query(
    "SELECT reply_at IS NOT NULL AS done FROM whatsapp_exchanges WHERE group_id=$1 AND message_id=$2",
    [groupId, messageId],
  );
  return r.rows.length > 0 && r.rows[0].done === true;
}

export async function close(): Promise<void> {
  if (_pool) { await _pool.end(); _pool = null; }
}

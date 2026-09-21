import type { WAClient } from "../client.js";
import { MessageMedia } from "../client.js";
import fs from "node:fs/promises";
import { markSent } from "../sent-registry.js";
import { formatForWhatsApp, prepareWhatsAppMessages } from "./format.js";

const PREFIX = "🤖";
const THROTTLE_MS = 3000;
let lastSendAt = 0;

async function throttle() {
  const wait = Math.max(0, THROTTLE_MS - (Date.now() - lastSendAt));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastSendAt = Date.now();
}

// The message is already delivered by the time we read its id back. If the id
// is missing (whatsapp-web.js returns undefined when WA Web changes its
// internals), log it instead of throwing: a throw here used to trigger the
// caller's error path and send a second, false "failed" message.
function recordSent(sent: { id?: { _serialized?: string } } | undefined | null): string | null {
  const id = sent?.id?._serialized ?? null;
  if (id) markSent(id);
  else console.warn("[wa] message sent but no id was returned");
  return id;
}

/**
 * Send a bot reply. The text is converted from Markdown to WhatsApp syntax
 * (tools/format.ts) and, when long, split at paragraph boundaries into several
 * consecutive messages. Every part carries the 🤖 prefix (loop prevention);
 * only the first part quotes the inbound message. Returns the first part's id.
 */
export async function sendText(
  client: WAClient, chatId: string, text: string, replyToMsgId?: string,
): Promise<string | null> {
  const parts = prepareWhatsAppMessages(text);
  if (parts.length === 0) parts.push(text.trim() || "…");
  let firstId: string | null = null;
  for (let i = 0; i < parts.length; i++) {
    await throttle();
    const sent = await client.sendMessage(chatId, `${PREFIX} ${parts[i]}`, {
      quotedMessageId: i === 0 ? replyToMsgId : undefined,
    });
    const id = recordSent(sent);
    if (i === 0) firstId = id;
  }
  return firstId;
}

export async function sendInterim(
  client: WAClient, chatId: string, text: string, replyToMsgId?: string,
): Promise<string | null> {
  await throttle();
  const sent = await client.sendMessage(chatId, `${PREFIX} ${text}`, {
    quotedMessageId: replyToMsgId,
  });
  return recordSent(sent);
}

export async function sendMediaFromPath(
  client: WAClient, chatId: string, filePath: string, caption?: string, replyToMsgId?: string,
): Promise<string | null> {
  await throttle();
  const media = MessageMedia.fromFilePath(filePath);
  const sent = await client.sendMessage(chatId, media, {
    caption: caption ? `${PREFIX} ${formatForWhatsApp(caption)}` : undefined,
    quotedMessageId: replyToMsgId,
  });
  return recordSent(sent);
}

export async function sendMediaFromUrl(
  client: WAClient, chatId: string, url: string, caption?: string, replyToMsgId?: string,
): Promise<string | null> {
  await throttle();
  const media = await MessageMedia.fromUrl(url, { unsafeMime: true });
  const sent = await client.sendMessage(chatId, media, {
    caption: caption ? `${PREFIX} ${formatForWhatsApp(caption)}` : undefined,
    quotedMessageId: replyToMsgId,
  });
  return recordSent(sent);
}

export async function sendVoice(
  client: WAClient, chatId: string, audioFilePath: string, replyToMsgId?: string,
): Promise<string | null> {
  await throttle();
  const data = await fs.readFile(audioFilePath, { encoding: "base64" });
  const media = new MessageMedia("audio/ogg; codecs=opus", data);
  const sent = await client.sendMessage(chatId, media, {
    sendAudioAsVoice: true,
    quotedMessageId: replyToMsgId,
  });
  return recordSent(sent);
}

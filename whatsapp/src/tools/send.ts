import type { WAClient } from "../client.js";
import { MessageMedia } from "../client.js";
import fs from "node:fs/promises";

const PREFIX = "🤖";
const THROTTLE_MS = 3000;
let lastSendAt = 0;

async function throttle() {
  const wait = Math.max(0, THROTTLE_MS - (Date.now() - lastSendAt));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastSendAt = Date.now();
}

export async function sendText(
  client: WAClient, chatId: string, text: string, replyToMsgId?: string,
): Promise<string> {
  await throttle();
  const sent = await client.sendMessage(chatId, `${PREFIX} ${text}`, {
    quotedMessageId: replyToMsgId,
  });
  return sent.id._serialized;
}

export async function sendInterim(
  client: WAClient, chatId: string, text: string, replyToMsgId?: string,
): Promise<string> {
  await throttle();
  const sent = await client.sendMessage(chatId, `${PREFIX} ${text}`, {
    quotedMessageId: replyToMsgId,
  });
  return sent.id._serialized;
}

export async function sendMediaFromPath(
  client: WAClient, chatId: string, filePath: string, caption?: string, replyToMsgId?: string,
): Promise<string> {
  await throttle();
  const media = MessageMedia.fromFilePath(filePath);
  const sent = await client.sendMessage(chatId, media, {
    caption: caption ? `${PREFIX} ${caption}` : undefined,
    quotedMessageId: replyToMsgId,
  });
  return sent.id._serialized;
}

export async function sendMediaFromUrl(
  client: WAClient, chatId: string, url: string, caption?: string, replyToMsgId?: string,
): Promise<string> {
  await throttle();
  const media = await MessageMedia.fromUrl(url, { unsafeMime: true });
  const sent = await client.sendMessage(chatId, media, {
    caption: caption ? `${PREFIX} ${caption}` : undefined,
    quotedMessageId: replyToMsgId,
  });
  return sent.id._serialized;
}

export async function sendVoice(
  client: WAClient, chatId: string, audioFilePath: string, replyToMsgId?: string,
): Promise<string> {
  await throttle();
  const data = await fs.readFile(audioFilePath, { encoding: "base64" });
  const media = new MessageMedia("audio/ogg; codecs=opus", data);
  const sent = await client.sendMessage(chatId, media, {
    sendAudioAsVoice: true,
    quotedMessageId: replyToMsgId,
  });
  return sent.id._serialized;
}

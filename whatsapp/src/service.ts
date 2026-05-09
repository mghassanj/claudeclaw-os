import "dotenv/config";
import fs from "node:fs/promises";
import { buildClient } from "./client.js";
import { startHealthServer } from "./healthcheck.js";
import { currentConfig, reloadConfig } from "./config.js";
import { detectLang } from "./lang.js";
import { composeReply } from "./reply-composer.js";
import {
  recordInbound, recordReply, alreadyReplied,
} from "./audit.js";
import {
  sendText, sendMediaFromPath,
} from "./tools/send.js";
import { transcribeVoice } from "./tools/transcribe.js";

const cfg0 = currentConfig();
console.log("[wa] starting, enabled=", cfg0.enabled, "groups=", cfg0.allowedGroups);

if (!cfg0.enabled) {
  console.log("[wa] WHATSAPP_ENABLED=false — passive mode (will receive but not reply)");
}

const state = buildClient();
startHealthServer(state, cfg0.qrPort);

state.client.on("message", async (msg) => {
  let chatId = "";
  try {
    const cfg = currentConfig();
    const chat = await msg.getChat();
    if (!chat.isGroup) return;
    chatId = chat.id._serialized;
    const groupName = (chat as any).name ?? "";
    if (!cfg.isGroupAllowed(groupName)) return;

    if (await alreadyReplied(chatId, msg.id._serialized)) return;

    let inboundText = msg.body ?? "";
    let inboundType: "text" | "voice" | "image" = "text";

    if (msg.hasMedia && (msg.type === "audio" || msg.type === "ptt")) {
      const media = await msg.downloadMedia();
      const buf = Buffer.from(media.data, "base64");
      const t = await transcribeVoice(buf, media.mimetype);
      inboundText = t.text;
      inboundType = "voice";
    } else if (msg.hasMedia && msg.type === "image") {
      inboundType = "image";
      inboundText = msg.body ?? "[image]";
    }

    const inboundLang = detectLang(inboundText);
    const contact = await msg.getContact();
    const sender = (contact as any).pushname ?? msg.author ?? "unknown";

    await recordInbound({
      groupId: chatId,
      groupName,
      senderNumber: msg.author ?? msg.from,
      senderName: sender,
      messageId: msg.id._serialized,
      inboundText,
      inboundType,
      inboundLang,
      inboundAt: new Date(),
    });

    if (!cfg.enabled) {
      console.log("[wa] passive: logged. msg=", inboundText.slice(0, 60));
      return;
    }

    const threadMsgs = await chat.fetchMessages({ limit: 8 });
    const threadContext = await Promise.all(threadMsgs.map(async (m: any) => {
      const c = await m.getContact();
      return { sender: (c as any).pushname ?? "unknown", text: m.body ?? "" };
    }));

    const result = await composeReply({
      inboundText, inboundLang, threadContext, groupName, config: cfg,
    });

    let replyMsgId: string | null = null;
    let replyMediaUrl: string | null = null;

    if (!result.replyText) {
      await recordReply({
        groupId: chatId, messageId: msg.id._serialized,
        chosenTier: result.chosenTier, toolsCalled: result.toolsCalled,
        sourcesCited: result.sourcesCited, replyText: null, replyMediaUrl: null,
        replyAt: new Date(), replyMsgId: null,
        durationMs: result.durationMs, costEstimate: result.costEstimate, error: null,
      });
      return;
    }

    const mediaMatch = result.replyText.match(/MEDIA_PATH:\s*(\S+)/);
    const cleanText = result.replyText.replace(/MEDIA_PATH:.*$/m, "").trim();

    if (mediaMatch && cfg.isTierEnabled(result.chosenTier)) {
      const filePath = mediaMatch[1];
      try {
        await fs.access(filePath);
        replyMsgId = await sendMediaFromPath(
          state.client, chatId, filePath, cleanText, msg.id._serialized,
        );
        replyMediaUrl = filePath;
      } catch {
        replyMsgId = await sendText(
          state.client, chatId,
          `${cleanText}\n\n_(media file unavailable)_`, msg.id._serialized,
        );
      }
    } else {
      replyMsgId = await sendText(
        state.client, chatId, cleanText, msg.id._serialized,
      );
    }

    await recordReply({
      groupId: chatId, messageId: msg.id._serialized,
      chosenTier: result.chosenTier, toolsCalled: result.toolsCalled,
      sourcesCited: result.sourcesCited, replyText: cleanText, replyMediaUrl,
      replyAt: new Date(), replyMsgId,
      durationMs: result.durationMs, costEstimate: result.costEstimate, error: null,
    });
  } catch (e) {
    console.error("[wa] message handler error:", e);
    if (chatId) {
      try {
        await recordReply({
          groupId: chatId, messageId: msg.id._serialized,
          chosenTier: "0", toolsCalled: [], sourcesCited: [],
          replyText: null, replyMediaUrl: null, replyAt: new Date(), replyMsgId: null,
          durationMs: 0, costEstimate: 0,
          error: String(e).slice(0, 500),
        });
      } catch { /* swallow */ }
    }
  }
});

process.on("SIGHUP", () => {
  reloadConfig();
  console.log("[wa] config reloaded");
});

process.on("SIGTERM", async () => {
  console.log("[wa] SIGTERM, destroying client");
  await state.client.destroy();
  process.exit(0);
});

state.client.initialize();

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
import { extractDocument } from "./tools/extract_document.js";

async function safeContactName(msg: any): Promise<string> {
  try {
    const c = await msg.getContact();
    return (c as any).pushname ?? (c as any).name ?? msg.author ?? msg.from ?? "unknown";
  } catch {
    // LID-typed senders (newer WhatsApp identity) sometimes can't be looked up
    return msg.author ?? msg.from ?? "unknown";
  }
}

const cfg0 = currentConfig();
console.log("[wa] starting, enabled=", cfg0.enabled, "groups=", cfg0.allowedGroups);

if (!cfg0.enabled) {
  console.log("[wa] WHATSAPP_ENABLED=false — passive mode (will receive but not reply)");
}

const state = buildClient();
startHealthServer(state, cfg0.qrPort);

state.client.on("message_create", async (msg) => {
  let chatId = "";
  try {
    console.log("[wa] msg event fired");
    const cfg = currentConfig();
    // Loop prevention: skip the bot's own outbound replies
    if (msg.fromMe && (msg.body ?? "").startsWith("\u{1F916}")) return;
    // Self-reply gate: only process Mohamed's own messages if explicitly enabled
    if (msg.fromMe && !cfg.selfReply) return;
    const chat = await msg.getChat();
    console.log("[wa] chat:", chat.isGroup ? "group" : "dm", "name=", (chat as any).name ?? "?");
    if (!chat.isGroup) return;
    chatId = chat.id._serialized;
    const groupName = (chat as any).name ?? "";
    if (!cfg.isGroupAllowed(groupName)) return;
    console.log("[wa] group allowed");

    if (await alreadyReplied(chatId, msg.id._serialized)) return;
    console.log("[wa] not replied yet, processing");

    let inboundText = msg.body ?? "";
    let inboundType: "text" | "voice" | "image" = "text";

    // inlineImage is set for image messages so composeReply can pass it to vision
    let inlineImageBase64: string | undefined;
    let inlineImageMime: string | undefined;

    if (msg.hasMedia && (msg.type === "audio" || msg.type === "ptt")) {
      const media = await msg.downloadMedia();
      const buf = Buffer.from(media.data, "base64");
      const t = await transcribeVoice(buf, media.mimetype);
      inboundText = t.text;
      inboundType = "voice";
    } else if (msg.hasMedia && msg.type === "image") {
      inboundType = "image";
      const media = await msg.downloadMedia();
      inlineImageBase64 = media.data;           // already base64 from whatsapp-web.js
      inlineImageMime = media.mimetype;
      inboundText = (msg.body ?? "").trim() || "[image attached — describe or answer based on its content]";
    } else if (msg.hasMedia && msg.type === "document") {
      // document = PDF / docx / xlsx sent by customer
      inboundType = "image"; // existing enum only has text/voice/image; documents lump under "image"
      const media = await msg.downloadMedia();
      const buf = Buffer.from(media.data, "base64");
      const filename: string = (media as any).filename ?? msg.body ?? "";
      console.log("[wa] document received:", filename, "mime:", media.mimetype, "bytes:", buf.length);
      try {
        const extracted = await extractDocument(buf, media.mimetype, filename);
        const caption = (msg.body ?? "").trim();
        inboundText = [
          `[Document attached: ${filename || media.mimetype}, ${extracted.bytesIn} bytes]`,
          "",
          "Extracted content:",
          extracted.text,
          "",
          caption
            ? `Customer's message with the doc: ${caption}`
            : "Answer the question implied by the document, or summarize it if no question was asked.",
        ].join("\n");
        console.log("[wa] document extracted, chars:", extracted.text.length);
      } catch (e) {
        console.warn("[wa] document extraction failed:", e);
        inboundText = `[Document attached but couldn't extract its text: ${filename || media.mimetype}] Please tell the user the document type is unsupported or corrupted and ask them to share text or a PDF.`;
      }
    }

    console.log("[wa] type:", inboundType, "lang:", detectLang(inboundText));
    const inboundLang = detectLang(inboundText);
    const sender = await safeContactName(msg);

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
    console.log("[wa] inbound recorded");

    if (!cfg.enabled) {
      console.log("[wa] passive: logged. msg=", inboundText.slice(0, 60));
      return;
    }
    console.log("[wa] enabled=true, fetching thread context");

    const threadMsgs = await chat.fetchMessages({ limit: 8 });
    const threadContext = await Promise.all(threadMsgs.map(async (m: any) => ({
      sender: await safeContactName(m),
      text: m.body ?? "",
    })));
    console.log("[wa] thread context size:", threadContext.length);

    console.log("[wa] calling composeReply...");
    const result = await composeReply({
      inboundText,
      inboundLang,
      threadContext,
      groupName,
      config: cfg,
      inlineImage: inlineImageBase64 && inlineImageMime
        ? { base64: inlineImageBase64, mime: inlineImageMime }
        : undefined,
    });
    console.log("[wa] composeReply done. tier=", result.chosenTier, "tools=", result.toolsCalled, "replyText.length=", result.replyText?.length ?? 0);

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

    console.log("[wa] sending via", mediaMatch ? "media" : "text");
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
    console.log("[wa] sent. reply_msg_id=", replyMsgId);

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

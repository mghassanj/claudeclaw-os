import "dotenv/config";
import fs from "node:fs/promises";
import { buildClient } from "./client.js";
import type { Message as WAMessage } from "whatsapp-web.js";
import { startHealthServer } from "./healthcheck.js";
import { currentConfig, reloadConfig } from "./config.js";
import { wasSentByBot } from "./sent-registry.js";
import { runMainBridge } from "./main-bridge.js";
import { detectLang } from "./lang.js";
import { composeReply } from "./reply-composer.js";
import {
  recordInbound, recordReply, alreadyReplied,
} from "./audit.js";
import {
  sendText, sendMediaFromPath,
} from "./tools/send.js";
import { checkVoiceArtifact, isVoiceOrAvatarArtifact } from "./tools/voice-qa.js";
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

const onMessage = async (msg: WAMessage): Promise<void> => {
  let chatId = "";
  try {
    console.log("[wa] msg event fired");
    const cfg = currentConfig();
    // Loop prevention: skip the bot's own outbound replies. The 🤖 text
    // prefix covers text + captioned media; the sent-id registry also covers
    // voice notes and uncaptioned media (which have no body to prefix).
    if (msg.fromMe && (msg.body ?? "").startsWith("\u{1F916}")) return;
    if (msg.fromMe && wasSentByBot(msg.id._serialized)) return;

    let chat: Awaited<ReturnType<typeof msg.getChat>>;
    try {
      chat = await msg.getChat();
    } catch (e) {
      // whatsapp-web.js getChatById throws (minified "r: r") for some 1:1
      // chats addressed by @lid that aren't in the Chat collection yet.
      // Non-group DMs are dropped below by design, so skip those quietly;
      // groups and the self-chat still surface the error.
      const peer = (msg.fromMe ? msg.to : msg.from) ?? "";
      const peerUser = peer.split("@")[0];
      const selfLidList = (process.env.WHATSAPP_SELF_LIDS ?? "").split(",").map((x) => x.trim());
      const maybeSelf = msg.from === msg.to || selfLidList.includes(peerUser);
      if (!peer.endsWith("@g.us") && !maybeSelf) {
        console.log("[wa] skip: chat lookup failed for 1:1 dm (" + (peer.split("@")[1] ?? "?") + ")");
        return;
      }
      throw e;
    }
    chatId = chat.id._serialized;
    const selfId = (state.client.info as any)?.wid?._serialized as string | undefined;
    const selfUser = (state.client.info as any)?.wid?.user as string | undefined;
    const chatUser = (chat.id as any)?.user as string | undefined;
    // The self-chat ("Message Yourself") uses WhatsApp's @lid namespace, whose
    // id is unrelated to the phone number, so id/number comparisons fail.
    // contact.isMe is the account-independent signal; WHATSAPP_SELF_LIDS is an
    // explicit fallback (comma list of lid user-parts known to be self).
    const selfLids = (process.env.WHATSAPP_SELF_LIDS ?? "")
      .split(",").map((x) => x.trim()).filter(Boolean);
    let contactIsMe = false;
    if (!chat.isGroup) {
      try { contactIsMe = !!((await chat.getContact()) as any)?.isMe; } catch { /* ignore */ }
    }
    const isSelfChat = !chat.isGroup && (
      contactIsMe ||
      (!!selfId && chatId === selfId) ||
      (!!selfUser && !!chatUser && selfUser === chatUser) ||
      (!!chatUser && selfLids.includes(chatUser)) ||
      (!!msg.from && msg.from === msg.to)
    );
    console.log("[wa] chat:", chat.isGroup ? "group" : isSelfChat ? "self" : "dm", "name=", (chat as any).name ?? "?");

    if (isSelfChat) {
      // Self-chat ("Message Yourself") — Mohamed's private assistant channel.
      // Gated by WHATSAPP_SELF_CHAT so it can be toggled without a code change.
      if (!cfg.selfChatEnabled) return;
    } else {
      // Group pilot flow: only process Mohamed's own messages if selfReply on.
      if (msg.fromMe && !cfg.selfReply) return;
      if (!chat.isGroup) return;
      if (!cfg.isGroupAllowed((chat as any).name ?? "")) return;
    }
    const groupName = isSelfChat ? "Self Chat" : ((chat as any).name ?? "");
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

    if (isSelfChat) {
      console.log("[wa] self-chat -> main agent bridge");
      const bridgeStart = Date.now();
      let bridged: string;
      try {
        bridged = await runMainBridge(inboundText);
      } catch (e) {
        console.error("[wa] main-bridge failed:", e);
        const fallbackId = await sendText(state.client, chatId, "Couldn\u2019t reach the main agent right now \u2014 try again in a moment.", msg.id._serialized);
        await recordReply({
          groupId: chatId, messageId: msg.id._serialized,
          chosenTier: "self", toolsCalled: [], sourcesCited: [],
          replyText: null, replyMediaUrl: null, replyAt: new Date(), replyMsgId: fallbackId,
          durationMs: Date.now() - bridgeStart, costEstimate: 0,
          error: ("main-bridge: " + String(e)).slice(0, 500),
        });
        return;
      }
      // Outside the try: a send error must not trigger the "couldn't reach"
      // fallback, because the reply may already have been delivered.
      const sentId = await sendText(state.client, chatId, bridged, msg.id._serialized);
      console.log("[wa] self-chat reply sent:", sentId);
      // Mark it replied (reply_at) so a re-fired message_create can't answer twice.
      await recordReply({
        groupId: chatId, messageId: msg.id._serialized,
        chosenTier: "self", toolsCalled: [], sourcesCited: [],
        replyText: bridged, replyMediaUrl: null, replyAt: new Date(), replyMsgId: sentId,
        durationMs: Date.now() - bridgeStart, costEstimate: 0, error: null,
      });
      return;
    }
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
        // Voice/avatar artifact hard gate: re-transcribe via Gemini, compare to script.
        if (isVoiceOrAvatarArtifact(filePath)) {
          const qa = await checkVoiceArtifact(cleanText, filePath);
          if (!qa.passed && qa.hardGateEnabled) {
            console.warn("[wa] voice-artifact-rejected-hallucination", {
              tier: result.chosenTier, filePath, reason: qa.reason,
              similarity: qa.similarity, threshold: qa.threshold,
              script: cleanText.slice(0, 200), transcript: qa.transcript.slice(0, 200),
            });
            replyMsgId = await sendText(
              state.client, chatId,
              `⚠️ ${cleanText}\n\n_(media blocked by QA gate — rendered audio drifted from script: ${qa.reason ?? "low similarity"})_`,
              msg.id._serialized,
            );
            replyMediaUrl = null;
            await recordReply({
              groupId: chatId, messageId: msg.id._serialized,
              chosenTier: result.chosenTier, toolsCalled: result.toolsCalled,
              sourcesCited: result.sourcesCited, replyText: cleanText, replyMediaUrl: null,
              replyAt: new Date(), replyMsgId,
              durationMs: result.durationMs, costEstimate: result.costEstimate,
              error: `voice-artifact-rejected-hallucination: ${qa.reason ?? ""}`.slice(0, 500),
            });
            return;
          }
          if (!qa.passed) {
            console.warn("[wa] voice-qa failed but hard gate disabled — sending anyway", qa.reason);
          }
        }
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
};
state.client.on("message_create", onMessage);

// Catch-up after a restart/outage: whatsapp-web.js only emits messages that
// arrive while we're connected, so anything sent to an allowed group during
// downtime was silently dropped (2026-09-21 10:05:37, during a restart).
// On the first "ready", replay recent unanswered messages through onMessage,
// which still applies every normal rule (group allow-list, selfReply, and the
// alreadyReplied dedup). Only messages that are:
//   - within WA_CATCHUP_MINUTES (default 30; 0 disables),
//   - older than this READY (newer ones go through the live handler),
//   - newer than the bot's last reply in that chat.
let catchUpStarted = false;
async function catchUpMissed(): Promise<void> {
  if (catchUpStarted) return;
  catchUpStarted = true;
  await state.patched;
  const minutes = Number(process.env.WA_CATCHUP_MINUTES ?? 30);
  if (!(minutes > 0)) return;
  const readyAt = Date.now() / 1000;
  const cutoff = readyAt - minutes * 60;
  const cfg = currentConfig();
  const isBotMsg = (m: WAMessage) =>
    m.fromMe && ((m.body ?? "").startsWith("\u{1F916}") || wasSentByBot(m.id._serialized));
  const chats = await state.client.getChats();
  for (const chat of chats) {
    if (!chat.isGroup || !cfg.isGroupAllowed((chat as any).name ?? "")) continue;
    const recent = await chat.fetchMessages({ limit: 30 });
    const lastBotTs = recent.filter(isBotMsg).reduce((t, m) => Math.max(t, m.timestamp), 0);
    const missed = recent.filter((m) =>
      m.timestamp >= cutoff && m.timestamp < readyAt && m.timestamp > lastBotTs && !isBotMsg(m));
    console.log(`[wa] catch-up: "${(chat as any).name}": ${missed.length} unanswered in last ${minutes} min`);
    for (const m of missed) await onMessage(m);
  }
}
state.client.on("ready", () => {
  catchUpMissed().catch((e) => console.error("[wa] catch-up failed:", e));
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

// Startup watchdog: whatsapp-web.js can miss WA Web's "synced" signal and sit
// in INITIALIZING forever (seen 2026-09-21: page logged in, "ready" never fired).
// Exit non-zero so systemd (Restart=on-failure) restarts us. QR_REQUIRED is
// left alone: that state waits for a human scan, and a restart wouldn't help.
const READY_TIMEOUT_MS = Number(process.env.WA_READY_TIMEOUT_MS ?? 300_000);
setTimeout(() => {
  if (state.state === "INITIALIZING") {
    console.error(`[wa] not READY after ${Math.round(READY_TIMEOUT_MS / 1000)}s (state=${state.state}); exiting so systemd restarts us`);
    process.exit(1);
  }
}, READY_TIMEOUT_MS).unref();

state.client.initialize().catch((e) => {
  console.error("[wa] client.initialize() failed; exiting so systemd restarts us:", e);
  process.exit(1);
});

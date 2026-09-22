import fs from 'fs';
import path from 'path';

import { runAgentWithRetry, type AgentResult } from './agent.js';
import { getSession, setSession } from './db.js';
import {
  ALLOWED_CHAT_ID,
  MODEL_FALLBACK_CHAIN,
  agentMcpAllowlist,
  AGENT_TIMEOUT_MS,
  EXFILTRATION_GUARD_ENABLED,
  PROTECTED_ENV_VARS,
} from './config.js';
import { getSelectedProviderConfig } from './active-provider.js';
import { buildMemoryContext, evaluateMemoryRelevance, saveConversationTurn } from './memory.js';
import { logger } from './logger.js';
import { messageQueue } from './message-queue.js';
import { scanForSecrets, redactSecrets } from './exfiltration-guard.js';
import { extractFileMarkers, type FileMarker } from './file-markers.js';
import { UPLOADS_DIR, buildPhotoMessage } from './media.js';
import { emitChatEvent, setActiveAbort, setProcessing, type ChatEvent } from './state.js';
import { formatAbortedReply } from './turn-outcome.js';
import { runWithTurnContext, takePendingHandoff } from './session-handoff.js';

const MAIN_AGENT_ID = 'main';

/** Optional channel metadata sent by the bridge (e.g. the WhatsApp self-chat). */
export interface MainTurnMeta {
  /** e.g. 'whatsapp-self'. */
  channel?: string;
  /** Detected language of the inbound message ('ar' | 'en' | 'unknown'). */
  lang?: string;
  inboundType?: InboundType;
  /** Image attached to the inbound message (base64, as whatsapp-web.js gives it). */
  image?: { base64: string; mime: string };
  /** Other files from the message: the original plus derived frames/pages. */
  attachments?: BridgeAttachment[];
}

export const INBOUND_TYPES = [
  'text', 'voice', 'audio', 'image', 'sticker', 'video', 'document',
  'location', 'contact', 'poll', 'event', 'other',
] as const;
export type InboundType = typeof INBOUND_TYPES[number];

export interface BridgeAttachment {
  base64: string;
  mime: string;
  filename: string;
  role: 'original' | 'derived';
}

const MAX_BRIDGE_ATTACHMENTS = 16;

/** Validate the bridge's attachments field; undefined when absent or empty. */
export function parseBridgeAttachments(raw: unknown): BridgeAttachment[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const list = raw
    .filter((a): a is BridgeAttachment => !!a && typeof a === 'object'
      && typeof (a as BridgeAttachment).base64 === 'string' && (a as BridgeAttachment).base64.length > 0
      && typeof (a as BridgeAttachment).mime === 'string'
      && typeof (a as BridgeAttachment).filename === 'string')
    .slice(0, MAX_BRIDGE_ATTACHMENTS)
    .map((a) => ({ base64: a.base64, mime: a.mime.slice(0, 100), filename: a.filename.slice(0, 200), role: a.role === 'derived' ? 'derived' as const : 'original' as const }));
  return list.length ? list : undefined;
}

/** Filesystem-safe name that keeps the extension (and Arabic letters). */
export function safeUploadName(filename: string): string {
  const base = path.basename(filename).replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^\.+/, '').slice(-120);
  return base || 'file';
}

/**
 * Save bridged attachments into the uploads dir (cleaned by cleanupOldUploads)
 * and return the lines telling the agent where they are. Files that fail to
 * save are listed as such, never silently dropped.
 */
export function stageBridgeAttachments(attachments: BridgeAttachment[]): string {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const stamp = Date.now();
  const lines = attachments.map((a, i) => {
    try {
      const localPath = path.join(UPLOADS_DIR, `${stamp}_${i}_whatsapp_${safeUploadName(a.filename)}`);
      fs.writeFileSync(localPath, Buffer.from(a.base64, 'base64'));
      return `- ${a.role === 'original' ? 'Original file' : 'Derived image'}: ${localPath} (${a.filename}, ${a.mime})`;
    } catch (err) {
      logger.warn({ err, filename: a.filename }, 'main-turn bridge: could not stage attachment');
      return `- ${a.filename}: could not be saved`;
    }
  });
  return [
    'Files from this message, saved locally (open them with Read; for Office files use python):',
    ...lines,
    'The original file is authoritative: any extracted text above may be truncated or come from OCR.',
  ].join('\n');
}

/** Reply for the bridge: redacted final answer with [SEND_FILE] markers pulled out. */
export interface MainTurnReply {
  text: string;
  files: FileMarker[];
}

const CHANNEL_LABELS: Record<string, string> = {
  'whatsapp-self': 'WhatsApp self-chat',
  telegram: 'Telegram',
};

const INBOUND_LABELS: Record<string, string> = {
  voice: 'voice note',
  audio: 'audio file',
  image: 'image',
  sticker: 'sticker',
  video: 'video',
  document: 'document',
  location: 'location',
  contact: 'contact card',
  poll: 'poll',
  event: 'event',
};

/**
 * Compact channel tag prepended to the agent prompt so the agent knows where
 * the message came from and formats for it, e.g.
 * `[Channel: WhatsApp self-chat | lang: ar | voice note]`. '' without a channel.
 */
export function buildChannelTag(meta: MainTurnMeta): string {
  if (!meta.channel) return '';
  const parts = [`Channel: ${CHANNEL_LABELS[meta.channel] ?? meta.channel}`];
  if (meta.lang && meta.lang !== 'unknown') parts.push(`lang: ${meta.lang}`);
  const inbound = meta.inboundType ? INBOUND_LABELS[meta.inboundType] : undefined;
  if (inbound) parts.push(inbound);
  return `[${parts.join(' | ')}]`;
}

const IMAGE_EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
};

/**
 * Save a bridged image into the uploads dir (same place Telegram photos go,
 * cleaned by cleanupOldUploads) and return the standard "Photo received…"
 * prompt so the agent can Read it. Returns null if it can't be saved.
 */
export function stageBridgeImage(image: { base64: string; mime: string }, caption: string): string | null {
  try {
    const ext = IMAGE_EXT[(image.mime ?? '').split(';')[0].trim().toLowerCase()] ?? 'jpg';
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const localPath = path.join(UPLOADS_DIR, `${Date.now()}_whatsapp.${ext}`);
    fs.writeFileSync(localPath, Buffer.from(image.base64, 'base64'));
    return buildPhotoMessage(localPath, caption || undefined);
  } catch (err) {
    logger.warn({ err }, 'main-turn bridge: could not stage inbound image');
    return null;
  }
}

/** Same exfiltration guard the Telegram path applies before sending (bot.ts). */
export function redactReply(text: string): string {
  if (!EXFILTRATION_GUARD_ENABLED) return text;
  const protectedValues = PROTECTED_ENV_VARS
    .map((key) => process.env[key])
    .filter((v): v is string => !!v && v.length > 8);
  const matches = scanForSecrets(text, protectedValues);
  if (matches.length === 0) return text;
  logger.warn(
    { matchCount: matches.length, types: matches.map((m) => m.type) },
    'Exfiltration guard: redacted secrets from main-turn bridge reply',
  );
  return redactSecrets(text, matches);
}

/**
 * Pick the text to send back over the bridge. Only the final answer (text
 * after the last tool call), not "Let me check…" narration; falls back to the
 * full turn text when the engine doesn't report a final segment.
 */
export function pickBridgeText(result: Pick<AgentResult, 'text' | 'finalText'>): string {
  return (result.finalText ?? '').trim() || (result.text ?? '').trim() || 'Done.';
}

/**
 * Record the turn the same way the Telegram path does: conversation_log (for
 * /respin, recall and handoffs) + memory ingestion via saveConversationTurn,
 * surfaced-memory relevance feedback, and dashboard chat events.
 */
function recordBridgeTurn(
  chatId: string,
  userText: string,
  reply: string,
  sessionId: string | undefined,
  surfacedMemoryIds: number[],
  surfacedMemorySummaries: Map<number, string>,
  source: ChatEvent['source'],
): void {
  try {
    saveConversationTurn(chatId, userText, reply, sessionId, MAIN_AGENT_ID);
    if (surfacedMemoryIds.length > 0) {
      void evaluateMemoryRelevance(surfacedMemoryIds, surfacedMemorySummaries, userText, reply).catch(() => {});
    }
    emitChatEvent({ type: 'assistant_message', chatId, content: reply, source });
  } catch (err) {
    logger.warn({ err }, 'main-turn bridge: failed to record turn');
  }
}

/**
 * Run one turn of the MAIN agent on the canonical Telegram-main session
 * (ALLOWED_CHAT_ID, agent 'main'). Other channels (e.g. the WhatsApp self-chat)
 * call this so they SHARE one conversation + memory with Telegram: same session
 * id, same memory context, same logging. Returns the reply to send.
 */
export async function runMainTurn(text: string, meta: MainTurnMeta = {}): Promise<MainTurnReply> {
  const chatId = ALLOWED_CHAT_ID;
  if (!chatId) throw new Error('ALLOWED_CHAT_ID not configured');
  const source: ChatEvent['source'] = meta.channel?.startsWith('whatsapp') ? 'whatsapp' : 'dashboard';

  // What the user said, as logged/recalled (an image becomes the standard
  // "Photo received… File saved at" prompt, like Telegram photos).
  const baseText = (meta.image && stageBridgeImage(meta.image, text)) || text || (meta.image ? '[Image attached, but it could not be saved]' : '');
  const userText = meta.attachments?.length
    ? [baseText, stageBridgeAttachments(meta.attachments)].filter(Boolean).join('\n\n')
    : baseText;

  const sessionId = getSession(chatId, MAIN_AGENT_ID);
  const { contextText, surfacedMemoryIds, surfacedMemorySummaries } = await buildMemoryContext(chatId, userText, MAIN_AGENT_ID);
  const handoff = sessionId ? '' : takePendingHandoff(chatId, MAIN_AGENT_ID);
  const channelTag = buildChannelTag(meta);
  const fullMessage = [handoff, contextText, channelTag ? `${channelTag}\n${userText}` : userText]
    .filter(Boolean)
    .join('\n\n');
  const provider = getSelectedProviderConfig();

  emitChatEvent({ type: 'user_message', chatId, content: userText, source });

  const abortCtrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abortCtrl.abort(); }, AGENT_TIMEOUT_MS);
  // Register under the main chat id so Telegram /stop (and the dashboard
  // abort) can cancel a bridged turn exactly like a Telegram-native one.
  // Safe because turns on this chat are serialized by messageQueue.
  // Also mark the chat as processing, like a Telegram turn does, so the
  // dashboard shows the turn, its Stop button works (/api/chat/abort keys off
  // getIsProcessing) and /api/chat/send answers busy instead of stacking.
  const abortKey = String(chatId);
  setActiveAbort(abortKey, abortCtrl);
  setProcessing(abortKey, true);
  try {
    logger.info({ chatId, hasSession: !!sessionId, len: text.length, channel: meta.channel }, 'main-turn bridge: starting');
    const result = await runWithTurnContext({ chatId, agentId: MAIN_AGENT_ID }, () => runAgentWithRetry(
      fullMessage,
      sessionId,
      () => {},
      undefined,
      undefined,
      abortCtrl,
      undefined,
      undefined,
      MODEL_FALLBACK_CHAIN.length > 0 ? MODEL_FALLBACK_CHAIN : undefined,
      agentMcpAllowlist,
      provider,
      undefined,
    ));
    if (result.newSessionId) setSession(chatId, result.newSessionId, MAIN_AGENT_ID);
    // Never report an aborted turn as a plain success: label timeout vs /stop
    // and keep any partial text (all of it: there is no "final answer" yet).
    const reply = redactReply(result.aborted
      ? formatAbortedReply(result.text, { timedOut, timeoutMs: AGENT_TIMEOUT_MS })
      : pickBridgeText(result));
    recordBridgeTurn(chatId, userText, reply, result.newSessionId ?? sessionId, surfacedMemoryIds, surfacedMemorySummaries, source);
    const { text: cleanText, files } = extractFileMarkers(reply);
    logger.info({ chatId, replyLen: cleanText.length, files: files.length, aborted: !!result.aborted, timedOut }, 'main-turn bridge: done');
    return { text: cleanText, files };
  } finally {
    clearTimeout(timer);
    setActiveAbort(abortKey, null);
    setProcessing(abortKey, false);
  }
}

/**
 * runMainTurn behind the same per-chat FIFO queue Telegram main uses
 * (messageQueue keyed by ALLOWED_CHAT_ID), so a WhatsApp self-chat turn never
 * runs concurrently with another turn on the shared main session. Without
 * this, two self-chat messages sent while a turn was running started parallel
 * turns that each acted on the same instruction (2026-09-21: two replies to
 * the same contact, two duplicate watchers).
 */
export function runMainTurnQueued(text: string, meta: MainTurnMeta = {}): Promise<MainTurnReply> {
  const chatId = ALLOWED_CHAT_ID;
  if (!chatId) return Promise.reject(new Error('ALLOWED_CHAT_ID not configured'));
  return new Promise<MainTurnReply>((resolve, reject) => {
    messageQueue.enqueue(String(chatId), async () => {
      try {
        resolve(await runMainTurn(text, meta));
      } catch (err) {
        reject(err);
      }
    });
  });
}

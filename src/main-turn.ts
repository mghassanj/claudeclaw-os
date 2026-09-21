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
import { emitChatEvent, setActiveAbort, type ChatEvent } from './state.js';
import { formatAbortedReply } from './turn-outcome.js';
import { runWithTurnContext, takePendingHandoff } from './session-handoff.js';

const MAIN_AGENT_ID = 'main';

/** Optional channel metadata sent by the bridge (e.g. the WhatsApp self-chat). */
export interface MainTurnMeta {
  /** e.g. 'whatsapp-self'. */
  channel?: string;
  /** Detected language of the inbound message ('ar' | 'en' | 'unknown'). */
  lang?: string;
  inboundType?: 'text' | 'voice' | 'image' | 'document';
  /** Image attached to the inbound message (base64, as whatsapp-web.js gives it). */
  image?: { base64: string; mime: string };
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
  image: 'image',
  document: 'document',
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
  const userText = (meta.image && stageBridgeImage(meta.image, text)) || text || '[Image attached, but it could not be saved]';

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
  const abortKey = String(chatId);
  setActiveAbort(abortKey, abortCtrl);
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

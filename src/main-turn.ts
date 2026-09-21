import { runAgentWithRetry } from './agent.js';
import { getSession, setSession } from './db.js';
import { ALLOWED_CHAT_ID, MODEL_FALLBACK_CHAIN, agentMcpAllowlist, AGENT_TIMEOUT_MS } from './config.js';
import { getSelectedProviderConfig } from './active-provider.js';
import { buildMemoryContext } from './memory.js';
import { ingestConversationTurn } from './memory-ingest.js';
import { logger } from './logger.js';
import { messageQueue } from './message-queue.js';
import { setActiveAbort } from './state.js';
import { formatAbortedReply } from './turn-outcome.js';

/**
 * Run one turn of the MAIN agent on the canonical Telegram-main session
 * (ALLOWED_CHAT_ID, agent 'main'). Other channels (e.g. the WhatsApp self-chat)
 * call this so they SHARE one conversation + memory with Telegram: same session
 * id, same memory context, same ingestion. Returns the reply text.
 */
export async function runMainTurn(text: string): Promise<string> {
  const chatId = ALLOWED_CHAT_ID;
  if (!chatId) throw new Error('ALLOWED_CHAT_ID not configured');

  const sessionId = getSession(chatId, 'main');
  const { contextText } = await buildMemoryContext(chatId, text, 'main');
  const fullMessage = contextText ? `${contextText}\n\n${text}` : text;
  const provider = getSelectedProviderConfig();

  const abortCtrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abortCtrl.abort(); }, AGENT_TIMEOUT_MS);
  // Register under the main chat id so Telegram /stop (and the dashboard
  // abort) can cancel a bridged turn exactly like a Telegram-native one.
  // Safe because turns on this chat are serialized by messageQueue.
  const abortKey = String(chatId);
  setActiveAbort(abortKey, abortCtrl);
  try {
    logger.info({ chatId, hasSession: !!sessionId, len: text.length }, 'main-turn bridge: starting');
    const result = await runAgentWithRetry(
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
    );
    if (result.newSessionId) setSession(chatId, result.newSessionId, 'main');
    // Never report an aborted turn as a plain success: label timeout vs /stop
    // and keep any partial text.
    const reply = result.aborted
      ? formatAbortedReply(result.text, { timedOut, timeoutMs: AGENT_TIMEOUT_MS })
      : (result.text ?? '').trim() || 'Done.';
    void ingestConversationTurn(chatId, text, reply).catch(() => {});
    logger.info({ chatId, replyLen: reply.length, aborted: !!result.aborted, timedOut }, 'main-turn bridge: done');
    return reply;
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
export function runMainTurnQueued(text: string): Promise<string> {
  const chatId = ALLOWED_CHAT_ID;
  if (!chatId) return Promise.reject(new Error('ALLOWED_CHAT_ID not configured'));
  return new Promise<string>((resolve, reject) => {
    messageQueue.enqueue(String(chatId), async () => {
      try {
        resolve(await runMainTurn(text));
      } catch (err) {
        reject(err);
      }
    });
  });
}

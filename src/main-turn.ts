import { runAgentWithRetry } from './agent.js';
import { getSession, setSession } from './db.js';
import { ALLOWED_CHAT_ID, MODEL_FALLBACK_CHAIN, agentMcpAllowlist, AGENT_TIMEOUT_MS } from './config.js';
import { getSelectedProviderConfig } from './active-provider.js';
import { buildMemoryContext } from './memory.js';
import { ingestConversationTurn } from './memory-ingest.js';
import { logger } from './logger.js';

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
  const timer = setTimeout(() => abortCtrl.abort(), AGENT_TIMEOUT_MS);
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
    const reply = (result.text ?? '').trim() || 'Done.';
    void ingestConversationTurn(chatId, text, reply).catch(() => {});
    logger.info({ chatId, replyLen: reply.length }, 'main-turn bridge: done');
    return reply;
  } finally {
    clearTimeout(timer);
  }
}

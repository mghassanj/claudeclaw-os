import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  impl: null as null | ((abort: AbortController) => Promise<Record<string, unknown>>),
}));

vi.mock('./config.js', () => ({
  ALLOWED_CHAT_ID: '4242',
  MODEL_FALLBACK_CHAIN: [],
  agentMcpAllowlist: undefined,
  AGENT_TIMEOUT_MS: 50,
  EXFILTRATION_GUARD_ENABLED: true,
  PROTECTED_ENV_VARS: [],
}));
vi.mock('./db.js', () => ({ getSession: vi.fn(() => undefined), setSession: vi.fn() }));
vi.mock('./active-provider.js', () => ({ getSelectedProviderConfig: vi.fn(() => ({ type: 'claude' })) }));
vi.mock('./memory.js', () => ({
  buildMemoryContext: vi.fn(async () => ({ contextText: '', surfacedMemoryIds: [], surfacedMemorySummaries: new Map() })),
  evaluateMemoryRelevance: vi.fn(async () => {}),
  saveConversationTurn: vi.fn(),
}));
vi.mock('./logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./agent.js', () => ({
  runAgentWithRetry: vi.fn(async (...args: unknown[]) => state.impl!(args[5] as AbortController)),
}));

import { runMainTurn } from './main-turn.js';
import { abortActiveQuery } from './state.js';

/** Resolves like runAgent does when its AbortController fires. */
function waitForAbort(partial: string | null) {
  return (abort: AbortController) => new Promise<Record<string, unknown>>((resolve) => {
    abort.signal.addEventListener('abort', () =>
      resolve({ text: partial, newSessionId: undefined, usage: null, aborted: true }));
  });
}

describe('runMainTurn outcome honesty', () => {
  beforeEach(() => { state.impl = null; });

  it('returns the reply unchanged on a normal turn', async () => {
    state.impl = async () => ({ text: 'Here you go', newSessionId: undefined, usage: null });
    expect((await runMainTurn('hi')).text).toBe('Here you go');
  });

  it('labels a timed-out turn instead of returning the partial silently', async () => {
    state.impl = waitForAbort('checked calendar, drafting');
    const reply = (await runMainTurn('do the thing')).text;
    expect(reply.startsWith('⏱ Timed out after 1s — partial result:')).toBe(true);
    expect(reply).toContain('checked calendar, drafting');
  });

  it('never says Done. for an aborted turn with no text', async () => {
    state.impl = waitForAbort(null);
    expect((await runMainTurn('x')).text).toBe('⏱ Timed out after 1s — no result was produced.');
  });

  it('lets Telegram /stop (abortActiveQuery on ALLOWED_CHAT_ID) cancel the bridged turn', async () => {
    state.impl = waitForAbort('partial');
    const p = runMainTurn('long job');
    await Promise.resolve();
    await Promise.resolve();
    expect(abortActiveQuery('4242')).toBe(true);
    expect((await p).text).toBe('Stopped — partial result:\npartial');
    // Cleared afterwards: nothing left to stop.
    expect(abortActiveQuery('4242')).toBe(false);
  });
});

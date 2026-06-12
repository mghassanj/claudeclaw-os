import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from './provider.js';
import { getDueTasks } from './db.js';
import { messageQueue } from './message-queue.js';

const state = vi.hoisted(() => ({
  provider: { type: 'codex' as const, model: 'gpt-5.3-codex' },
  dueTasks: [] as Array<{ id: string; prompt: string; schedule: string }>,
  runAgentCalls: [] as unknown[][],
  enqueued: [] as Array<() => Promise<void>>,
}));

vi.mock('./config.js', () => ({
  AGENT_ID: 'main',
  ALLOWED_CHAT_ID: 'chat-1',
  agentMcpAllowlist: ['filesystem'],
  agentDefaultModel: undefined,
  agentProvider: state.provider,
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./message-queue.js', () => ({
  messageQueue: {
    enqueue: vi.fn((_chatId: string, fn: () => Promise<void>) => {
      state.enqueued.push(fn);
    }),
  },
}));

vi.mock('./db.js', () => ({
  getDueTasks: vi.fn(() => state.dueTasks),
  getSession: vi.fn(() => undefined),
  logConversationTurn: vi.fn(),
  markTaskRunning: vi.fn(),
  updateTaskAfterRun: vi.fn(),
  resetStuckTasks: vi.fn(() => 0),
  claimNextMissionTask: vi.fn(() => null),
  completeMissionTask: vi.fn(),
  resetStuckMissionTasks: vi.fn(() => 0),
  getMissionTask: vi.fn(() => null),
}));

vi.mock('./bot.js', () => ({
  formatForTelegram: vi.fn((text: string) => text),
  splitMessage: vi.fn((text: string) => [text]),
}));

vi.mock('./active-provider.js', () => ({
  getSelectedProviderConfig: vi.fn(() => state.provider),
}));

vi.mock('./agent.js', () => ({
  runAgent: vi.fn(async (...args: unknown[]) => {
    state.runAgentCalls.push(args);
    return { text: 'done', newSessionId: undefined, usage: null };
  }),
}));

describe('scheduler provider selection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.dueTasks = [{ id: 'cron-1', prompt: 'daily briefing', schedule: '0 8 * * 1-5' }];
    state.runAgentCalls.length = 0;
    state.enqueued.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs cron tasks with the current dashboard-selected provider', async () => {
    const { initScheduler } = await import('./scheduler.js');
    const send = vi.fn(async () => {});
    initScheduler(send, 'main');

    await vi.runOnlyPendingTimersAsync();
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(vi.mocked(getDueTasks)).toHaveBeenCalled();
    expect(vi.mocked(messageQueue.enqueue)).toHaveBeenCalled();
    await state.enqueued[0]();
    expect(send).toHaveBeenCalled();
    expect(state.runAgentCalls).toHaveLength(1);
    expect(state.runAgentCalls[0][8]).toEqual({ type: 'codex', model: 'gpt-5.3-codex' } satisfies ProviderConfig);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  dueTasks: [] as Array<Record<string, unknown>>,
  enqueued: [] as Array<{ key: string; fn: () => Promise<void> }>,
  runAgentResult: { text: 'done', newSessionId: undefined, usage: null } as Record<string, unknown>,
  runAgentPrompts: [] as string[],
  interruptedTasks: [] as Array<{ id: string; prompt: string; started_at: number | null }>,
  interruptedMissions: [] as Array<Record<string, unknown>>,
  mission: null as Record<string, unknown> | null,
}));

vi.mock('./config.js', () => ({
  AGENT_ID: 'main',
  ALLOWED_CHAT_ID: 'chat-1',
  agentMcpAllowlist: undefined,
  agentDefaultModel: undefined,
}));
vi.mock('./logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./memory-ingest.js', () => ({ ingestConversationTurn: vi.fn(async () => {}) }));
vi.mock('./message-queue.js', () => ({
  messageQueue: {
    enqueue: vi.fn((key: string, fn: () => Promise<void>) => { state.enqueued.push({ key, fn }); }),
  },
}));
vi.mock('./db.js', () => ({
  getDueTasks: vi.fn(() => state.dueTasks),
  getSession: vi.fn(() => undefined),
  logConversationTurn: vi.fn(),
  markTaskRunning: vi.fn(),
  updateTaskAfterRun: vi.fn(),
  recoverInterruptedTasks: vi.fn(() => state.interruptedTasks),
  claimNextMissionTask: vi.fn(() => { const m = state.mission; state.mission = null; return m; }),
  completeMissionTask: vi.fn(),
  recoverInterruptedMissions: vi.fn(() => state.interruptedMissions),
  getMissionTask: vi.fn(() => null),
}));
vi.mock('./bot.js', () => ({
  formatForTelegram: vi.fn((t: string) => t),
  splitMessage: vi.fn((t: string) => [t]),
}));
vi.mock('./active-provider.js', () => ({ getSelectedProviderConfig: vi.fn(() => ({ type: 'claude' })) }));
vi.mock('./agent.js', () => ({
  runAgent: vi.fn(async (prompt: string) => {
    state.runAgentPrompts.push(prompt);
    return state.runAgentResult;
  }),
}));

import { updateTaskAfterRun } from './db.js';

async function tick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(60_000);
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('scheduler lanes + STATUS honesty', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.mocked(updateTaskAfterRun).mockClear();
    state.enqueued.length = 0;
    state.runAgentPrompts.length = 0;
    state.interruptedTasks = [];
    state.interruptedMissions = [];
    state.mission = null;
    state.dueTasks = [{ id: 't1', prompt: 'scrum digest', schedule: '0 8 * * *', acceptance_check: null, last_status: 'success' }];
    state.runAgentResult = { text: 'done', newSessionId: undefined, usage: null };
  });
  afterEach(() => { vi.useRealTimers(); });

  it('queues scheduled tasks and missions on sched:<agent>, not the user chat', async () => {
    state.mission = { id: 'm1', title: 'T', prompt: 'p' };
    const { initScheduler } = await import('./scheduler.js');
    initScheduler(vi.fn(async () => {}), 'main');
    await tick();
    expect(state.enqueued.map((e) => e.key)).toEqual(['sched:main', 'sched:main']);
  });

  it('wraps the prompt and records blocked from the STATUS line, alerting once', async () => {
    state.runAgentResult = { text: 'Could not reach Jira.\nSTATUS: blocked — Jira token expired', newSessionId: undefined, usage: null };
    const send = vi.fn(async (_t: string) => {});
    const { initScheduler } = await import('./scheduler.js');
    initScheduler(send, 'main');
    await tick();
    await state.enqueued[0].fn();

    expect(state.runAgentPrompts[0]).toContain('scrum digest');
    expect(state.runAgentPrompts[0]).toContain('STATUS: ok|blocked|failed');
    expect(vi.mocked(updateTaskAfterRun)).toHaveBeenCalledWith('t1', expect.any(Number), expect.any(String), 'blocked');
    const alerts = send.mock.calls.map((c) => c[0]).filter((t) => t.includes('Scheduled task blocked'));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('Jira token expired');
  });

  it('does not alert again while the task stays blocked', async () => {
    state.dueTasks[0].last_status = 'blocked';
    state.runAgentResult = { text: 'x\nSTATUS: blocked — still no token', newSessionId: undefined, usage: null };
    const send = vi.fn(async (_t: string) => {});
    const { initScheduler } = await import('./scheduler.js');
    initScheduler(send, 'main');
    await tick();
    await state.enqueued[0].fn();
    expect(vi.mocked(updateTaskAfterRun)).toHaveBeenCalledWith('t1', expect.any(Number), expect.any(String), 'blocked');
    expect(send.mock.calls.some((c) => String(c[0]).includes('Scheduled task blocked'))).toBe(false);
  });

  it('keeps success when no STATUS line is present', async () => {
    const { initScheduler } = await import('./scheduler.js');
    initScheduler(vi.fn(async () => {}), 'main');
    await tick();
    await state.enqueued[0].fn();
    expect(vi.mocked(updateTaskAfterRun)).toHaveBeenCalledWith('t1', expect.any(Number), 'done', 'success');
  });

  it('notifies once at startup about interrupted tasks and missions', async () => {
    state.dueTasks = [];
    state.interruptedTasks = [{ id: 't9', prompt: 'nightly <sync>', started_at: 1 }];
    state.interruptedMissions = [
      { id: 'm1', title: 'Report', attempts: 1, action: 'requeued' },
      { id: 'm2', title: 'Deploy', attempts: 2, action: 'failed' },
    ];
    const send = vi.fn(async (_t: string) => {});
    const { initScheduler } = await import('./scheduler.js');
    initScheduler(send, 'main');
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0];
    expect(msg).toContain('Interrupted by a restart');
    expect(msg).toContain('nightly &lt;sync&gt;');
    expect(msg).toContain('Mission "Report" (attempt 1) re-queued');
    expect(msg).toContain('Mission "Deploy" failed');
  });
});

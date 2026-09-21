import { describe, expect, it, vi } from 'vitest';

vi.mock('./agent.js', () => ({
  runAgent: vi.fn(async (_p: string, _s: unknown, _t: unknown, _pr: unknown, _m: unknown, abort: AbortController) =>
    new Promise((resolve) => {
      abort.signal.addEventListener('abort', () =>
        resolve({ text: 'half a report', newSessionId: undefined, usage: null, aborted: true }));
    })),
}));
vi.mock('./agent-config.js', () => ({
  loadAgentConfig: vi.fn(() => ({ name: 'Research', description: '', model: undefined, mcpServers: undefined })),
  listAgentIds: vi.fn(() => ['research']),
  resolveAgentClaudeMd: vi.fn(() => null),
}));
vi.mock('./config.js', () => ({ PROJECT_ROOT: '/tmp/none' }));
vi.mock('./db.js', () => ({
  logToHiveMind: vi.fn(),
  createInterAgentTask: vi.fn(),
  completeInterAgentTask: vi.fn(),
}));
vi.mock('./logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./memory.js', () => ({ buildMemoryContext: vi.fn(async () => ({ contextText: '' })) }));
vi.mock('./active-provider.js', () => ({ getSelectedProviderConfig: vi.fn(() => ({ type: 'claude' })) }));

import { delegateToAgent, initOrchestrator } from './orchestrator.js';
import { completeInterAgentTask } from './db.js';

describe('delegateToAgent timeout honesty', () => {
  it('records timeout (not completed) and labels the partial result', async () => {
    initOrchestrator();
    const res = await delegateToAgent('research', 'dig', 'chat', 'main', undefined, 20);
    expect(res.aborted).toBe(true);
    expect(res.text).toBe('⏱ Timed out after 1s — partial result:\nhalf a report');
    expect(vi.mocked(completeInterAgentTask)).toHaveBeenCalledWith(
      expect.any(String), 'timeout', 'Timed out after 1s. Partial: half a report');
    expect(vi.mocked(completeInterAgentTask)).not.toHaveBeenCalledWith(expect.any(String), 'completed', expect.anything());
  });
});

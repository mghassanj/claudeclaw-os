import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTurnInput } from './agent-engine/types.js';

const state = vi.hoisted(() => ({
  capturedInputs: [] as AgentTurnInput[],
  activeProvider: { type: 'opencode' as const },
  mainProvider: { type: 'claude' as const, model: 'claude-opus-4-6' },
}));

vi.mock('./config.js', () => ({
  AGENT_MAX_TURNS: 30,
  PROJECT_ROOT: '/tmp/test',
  agentCwd: undefined,
  agentProvider: state.activeProvider,
  agentSystemPrompt: undefined,
  ENABLE_ACP: true,
}));

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

vi.mock('./security.js', () => ({
  getScrubbedSdkEnv: vi.fn(() => ({})),
}));

vi.mock('./kill-switches.js', () => ({
  requireEnabled: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./provider.js', () => ({
  DEFAULT_CLAUDE_MODEL: 'claude-opus-4-6',
  DEFAULT_CODEX_MODEL: 'gpt-5.5',
  getMainProviderConfig: vi.fn(() => state.mainProvider),
  sessionBelongsToProvider: vi.fn(() => false),
  decodeProviderSession: vi.fn((_, sessionId) => sessionId),
  encodeProviderSession: vi.fn((provider, sessionId) => sessionId ? `${provider.type}:${sessionId}` : undefined),
  effectiveSkipPermissions: vi.fn((provider) => provider.dangerouslySkipPermissions ?? provider.type === 'claude'),
}));

vi.mock('./agent-engine/index.js', () => ({
  EngineFactory: {
    forProvider: vi.fn((provider) => ({
      async *invoke(input: AgentTurnInput) {
        state.capturedInputs.push(input);
        yield { type: 'session' as const, sessionId: `${provider.type}-session` };
        yield { type: 'result' as const, text: 'ok', usage: null };
      },
    })),
  },
}));

import { runAgent } from './agent.js';

describe('runAgent provider selection', () => {
  beforeEach(() => {
    state.capturedInputs.length = 0;
  });

  it('uses the active agent provider when no provider is passed', async () => {
    const result = await runAgent('scheduled task', undefined, () => {});

    expect(result.text).toBe('ok');
    expect(state.capturedInputs[0].provider).toEqual({ type: 'opencode' });
    expect(state.capturedInputs[0].model).toBeUndefined();
  });

  it('lets an explicit provider override the active provider', async () => {
    await runAgent('direct task', undefined, () => {}, undefined, undefined, undefined, undefined, undefined, { type: 'claude' });

    expect(state.capturedInputs[0].provider).toEqual({ type: 'claude' });
    expect(state.capturedInputs[0].model).toBe('claude-opus-4-6');
  });

  it('forwards an explicit toolPolicy to the engine', async () => {
    await runAgent(
      'chat msg',
      undefined,
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { type: 'codex' },
      { allowedTools: ['Read', 'Grep', 'Glob'] },
    );

    expect(state.capturedInputs[0].allowedTools).toEqual(['Read', 'Grep', 'Glob']);
    expect(state.capturedInputs[0].disallowedTools).toBeUndefined();
  });

  it('omits allowedTools/disallowedTools when no toolPolicy is passed (mission tasks keep full access)', async () => {
    await runAgent('scheduled task', undefined, () => {});

    expect(state.capturedInputs[0].allowedTools).toBeUndefined();
    expect(state.capturedInputs[0].disallowedTools).toBeUndefined();
  });
});

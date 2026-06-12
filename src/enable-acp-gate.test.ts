// Verifies the ENABLE_ACP feature flag forces Claude on every path when off,
// regardless of saved provider config. This is the gated-state counterpart
// to the existing multi-provider tests that run with the flag on.

import { describe, it, expect, vi } from 'vitest';

vi.mock('./config.js', () => ({
  PROJECT_ROOT: '/tmp/test',
  agentCwd: undefined,
  agentProvider: { type: 'gemini' as const, model: 'gemini-2.5-pro' },
  ENABLE_ACP: false,
  DEFAULT_CLAUDE_MODEL: 'claude-opus-4-8',
  CLAUDE_MODEL_OPUS: 'claude-opus-4-8',
  CLAUDE_MODEL_SONNET: 'claude-sonnet-4-6',
  CLAUDE_MODEL_HAIKU: 'claude-haiku-4-5',
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ClaudeSdkEngineAdapter, EngineFactory } from './agent-engine/index.js';
import { getSelectedProviderConfig } from './active-provider.js';

describe('ENABLE_ACP gate (flag off)', () => {
  it('getSelectedProviderConfig returns Claude even when agentProvider is non-Claude', () => {
    const provider = getSelectedProviderConfig();
    expect(provider.type).toBe('claude');
  });

  it('EngineFactory returns Claude adapter for any provider type', () => {
    for (const type of ['claude', 'gemini', 'codex', 'opencode', 'acp'] as const) {
      const engine = EngineFactory.forProvider({ type });
      expect(engine).toBeInstanceOf(ClaudeSdkEngineAdapter);
    }
  });
});

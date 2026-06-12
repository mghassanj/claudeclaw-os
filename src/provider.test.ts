import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  installed: new Set<string>(),
}));

vi.mock('child_process', () => ({
  spawnSync: vi.fn((_lookup: string, args: string[]) => ({
    status: state.installed.has(args[0]) ? 0 : 1,
  })),
}));

vi.mock('./config.js', () => ({
  STORE_DIR: '/tmp/test',
  DEFAULT_CLAUDE_MODEL: 'claude-opus-4-8',
  CLAUDE_MODEL_OPUS: 'claude-opus-4-8',
  CLAUDE_MODEL_SONNET: 'claude-sonnet-4-6',
  CLAUDE_MODEL_HAIKU: 'claude-haiku-4-5',
}));

import { checkProviderAvailability } from './provider.js';

describe('checkProviderAvailability', () => {
  beforeEach(() => {
    state.installed.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('claude', () => {
    it('reports ok when claude CLI is on PATH', () => {
      state.installed.add('claude');
      const result = checkProviderAvailability({ type: 'claude' });
      expect(result.ok).toBe(true);
    });

    it('reports ok via the bundled SDK even when the claude CLI is not on PATH', () => {
      // The claude-agent-sdk bundles its own Claude Code runtime, so the provider
      // is available whenever the SDK package resolves (it does in this repo)
      // regardless of whether a standalone `claude` is on PATH. This mirrors the
      // realistic daemon case where PATH lacks the global CLI dir.
      const result = checkProviderAvailability({ type: 'claude' });
      expect(result.ok).toBe(true);
    });
  });

  describe('opencode', () => {
    it('reports ok when opencode CLI is on PATH', () => {
      state.installed.add('opencode');
      const result = checkProviderAvailability({ type: 'opencode' });
      expect(result.ok).toBe(true);
    });

    it('returns install command and auth login hint when missing', () => {
      const result = checkProviderAvailability({ type: 'opencode' });
      expect(result.ok).toBe(false);
      expect(result.installCommand).toContain('opencode-ai');
      expect(result.setupHint).toContain('opencode auth login');
    });
  });

  describe('gemini', () => {
    it('reports ok when gemini CLI is on PATH', () => {
      state.installed.add('gemini');
      const result = checkProviderAvailability({ type: 'gemini' });
      expect(result.ok).toBe(true);
    });

    it('returns install command and auth hint when missing', () => {
      const result = checkProviderAvailability({ type: 'gemini' });
      expect(result.ok).toBe(false);
      expect(result.installCommand).toContain('@google/gemini-cli');
      expect(result.setupHint).toMatch(/gemini/i);
    });
  });

  describe('codex', () => {
    it('reports ok when codex CLI is on PATH', () => {
      state.installed.add('codex');
      const result = checkProviderAvailability({ type: 'codex' });
      expect(result.ok).toBe(true);
    });

    it('returns install command and auth hint when missing', () => {
      const result = checkProviderAvailability({ type: 'codex' });
      expect(result.ok).toBe(false);
      expect(result.installCommand).toContain('@openai/codex');
      expect(result.setupHint).toMatch(/codex/i);
    });
  });

  describe('acp (custom)', () => {
    it('reports ok when the custom command is on PATH', () => {
      state.installed.add('my-agent');
      const result = checkProviderAvailability({ type: 'acp', command: 'my-agent', args: ['--acp'] });
      expect(result.ok).toBe(true);
    });

    it('rejects when no command is provided', () => {
      const result = checkProviderAvailability({ type: 'acp' });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/requires a command/i);
    });

    it('rejects when the custom command is not on PATH', () => {
      const result = checkProviderAvailability({ type: 'acp', command: 'missing-tool' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('missing-tool');
      expect(result.setupHint).toBeTruthy();
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';

import { mcpAllowlistFromYaml, expandEnvRefs, envRefNames } from './mcp-allowlist.js';

// ── Host-shaped agent.yaml fixtures (mirrors ~/.claudeclaw/agents/*/agent.yaml
//    on the production host as of 2026-09-21; secrets omitted). ─────────────
const HOST_COMMS = `
name: Comms
description: All human communication -- email, Slack, WhatsApp
telegram_bot_token_env: COMMS_BOT_TOKEN
model: claude-sonnet-4-6
warroom_tools:
- Bash
- Skill
- mcp:gmail
- mcp:claude_ai_Gmail
- mcp:slack
- mcp:jisr-backend-codewiki
- mcp:performance-management-codewiki
- mcp:applicant-tracking-system-codewiki
- mcp:finway-codewiki
- mcp:spend-management-codewiki
- mcp:analytics-codewiki
obsidian:
  vault: /home/ubuntu/vault
  folders:
  - Drafts/
`;

const HOST_CONTENT = `
name: Content
description: YouTube scripts, LinkedIn posts
telegram_bot_token_env: CONTENT_BOT_TOKEN
model: claude-sonnet-4-6

# War-room tool budget
warroom_tools:
  - Skill
  - Write
  - Bash
`;

const HOST_SCRUM = `
name: Scrum Master
telegram_bot_token_env: SCRUM_BOT_TOKEN
model: claude-sonnet-4-6

warroom_tools:
  - Bash
  - Skill
  - mcp:rag
  - mcp:gmail
  - mcp:jisr-backend-codewiki
  - mcp:jisr-frontend-codewiki
`;

describe('mcpAllowlistFromYaml', () => {
  it('derives the allowlist from warroom_tools mcp: entries (host comms shape)', () => {
    const raw = yaml.load(HOST_COMMS) as Record<string, unknown>;
    expect(mcpAllowlistFromYaml(raw)).toEqual([
      'gmail',
      'claude_ai_Gmail',
      'slack',
      'jisr-backend-codewiki',
      'performance-management-codewiki',
      'applicant-tracking-system-codewiki',
      'finway-codewiki',
      'spend-management-codewiki',
      'analytics-codewiki',
    ]);
  });

  it('warroom_tools without any mcp: entry means NO MCP servers (host content shape)', () => {
    const raw = yaml.load(HOST_CONTENT) as Record<string, unknown>;
    expect(mcpAllowlistFromYaml(raw)).toEqual([]);
  });

  it('handles indented list style (host scrum shape)', () => {
    const raw = yaml.load(HOST_SCRUM) as Record<string, unknown>;
    expect(mcpAllowlistFromYaml(raw)).toEqual(['rag', 'gmail', 'jisr-backend-codewiki', 'jisr-frontend-codewiki']);
  });

  it('explicit mcp_servers wins over warroom_tools', () => {
    expect(mcpAllowlistFromYaml({
      mcp_servers: ['heygen', 'heygen'],
      warroom_tools: ['mcp:gmail'],
    })).toEqual(['heygen']);
  });

  it('neither key -> undefined (legacy: all servers)', () => {
    expect(mcpAllowlistFromYaml({ name: 'X' })).toBeUndefined();
    expect(mcpAllowlistFromYaml(null)).toBeUndefined();
  });
});

describe('expandEnvRefs', () => {
  const env: Record<string, string> = { TOK: 'abc123', EMPTY: '' };
  const lookup = (n: string) => env[n];

  it('expands ${VAR} and $VAR', () => {
    expect(expandEnvRefs('Bearer ${TOK}', lookup)).toBe('Bearer abc123');
    expect(expandEnvRefs('$TOK/x', lookup)).toBe('abc123/x');
  });

  it('uses ${VAR:-default} when unset or empty', () => {
    expect(expandEnvRefs('${NOPE:-dflt}', lookup)).toBe('dflt');
    expect(expandEnvRefs('${EMPTY:-dflt}', lookup)).toBe('dflt');
  });

  it('missing var -> empty string + onMissing(name), no throw', () => {
    const missing: string[] = [];
    expect(expandEnvRefs('Bearer ${NOPE}', lookup, (n) => missing.push(n))).toBe('Bearer ');
    expect(missing).toEqual(['NOPE']);
  });

  it('leaves strings without refs untouched', () => {
    expect(expandEnvRefs('https://codewiki.jisr.dev/api/mcp', lookup)).toBe('https://codewiki.jisr.dev/api/mcp');
    expect(envRefNames('no refs')).toEqual([]);
  });
});

// ── loadMcpServers end-to-end: allowlist + expansion from a real settings.json.
const readEnvFileMock = vi.fn((_keys: string[]) => ({} as Record<string, string>));
vi.mock('./env.js', () => ({ readEnvFile: (keys: string[]) => readEnvFileMock(keys) }));
const warn = vi.fn();
vi.mock('./logger.js', () => ({ logger: { info: vi.fn(), warn: (...a: unknown[]) => warn(...a), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

describe('loadMcpServers', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mcp-'));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      mcpServers: {
        heygen: { command: 'uvx', args: ['heygen-mcp'], env: { HEYGEN_API_KEY: '${HEYGEN_API_KEY}' } },
        'jisr-backend-codewiki': { url: 'https://codewiki.example/api/mcp', headers: { Authorization: 'Bearer ${JISR_CODEWIKI_TOKEN}' } },
        'finway-codewiki': { url: 'https://codewiki.example/api/mcp', headers: { Authorization: 'Bearer ${JISR_CODEWIKI_TOKEN}' } },
      },
    }));
    prevHome = process.env.HOME;
    process.env.HOME = home;
    process.env.JISR_CODEWIKI_TOKEN = 'cw-secret';
    delete process.env.HEYGEN_API_KEY;
    readEnvFileMock.mockReset();
    readEnvFileMock.mockImplementation(() => ({}));
    warn.mockReset();
    vi.resetModules(); // fresh warn-once sets per test
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    delete process.env.JISR_CODEWIKI_TOKEN;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('applies a warroom-derived allowlist and expands ${VAR} in headers', async () => {
    const { loadMcpServers } = await import('./agent.js');
    const servers = loadMcpServers(['jisr-backend-codewiki', 'gmail'], home);
    expect(Object.keys(servers)).toEqual(['jisr-backend-codewiki']);
    expect((servers['jisr-backend-codewiki'] as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer cw-secret');
    // phantom 'gmail' is logged by name
    expect(warn.mock.calls.some((c) => (c[0] as { mcpServer?: string }).mcpServer === 'gmail')).toBe(true);
  });

  it('empty allowlist -> no servers; undefined -> all servers', async () => {
    const { loadMcpServers } = await import('./agent.js');
    expect(loadMcpServers([], home)).toEqual({});
    expect(Object.keys(loadMcpServers(undefined, home)).sort()).toEqual(['finway-codewiki', 'heygen', 'jisr-backend-codewiki']);
  });

  it('falls back to the .env file, and a missing var becomes empty + warns (no crash)', async () => {
    const { loadMcpServers } = await import('./agent.js');
    readEnvFileMock.mockImplementation(() => ({}));
    const servers = loadMcpServers(['heygen'], home);
    expect((servers.heygen as { env: Record<string, string> }).env.HEYGEN_API_KEY).toBe('');
    const w = warn.mock.calls.find((c) => (c[0] as { envVar?: string }).envVar === 'HEYGEN_API_KEY');
    expect(w).toBeTruthy();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('cw-secret');

    readEnvFileMock.mockImplementation(() => ({ HEYGEN_API_KEY: 'hg-from-file' }));
    const again = loadMcpServers(['heygen'], home);
    expect((again.heygen as { env: Record<string, string> }).env.HEYGEN_API_KEY).toBe('hg-from-file');
  });
});

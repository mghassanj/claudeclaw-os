import { describe, it, expect, vi, beforeEach } from 'vitest';

// The orchestrator imports a lot of heavy modules (db, SDK, memory).
// We're testing two pure functions in isolation — pickSlashRoster and
// maybeLogWarRoomToHive — so stub everything else to no-ops. The test
// seam parameters mean we never need a real DB or SDK at all.

vi.mock('./config.js', () => ({
  PROJECT_ROOT: '/tmp/test-orchestrator',
  CLAUDECLAW_CONFIG: '/tmp/test-orchestrator/config',
  DEFAULT_CLAUDE_MODEL: 'claude-opus-4-8',
  CLAUDE_MODEL_OPUS: 'claude-opus-4-8',
  CLAUDE_MODEL_SONNET: 'claude-sonnet-4-6',
  CLAUDE_MODEL_HAIKU: 'claude-haiku-4-5',
}));

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

vi.mock('./db.js', () => ({
  addWarRoomTranscript: vi.fn(),
  getSession: vi.fn(),
  setSession: vi.fn(),
  getWarRoomTranscript: vi.fn(),
  getTextMeeting: vi.fn(),
  rememberClientMsgId: vi.fn(),
  getRecentConversation: vi.fn(() => []),
  getMissionTasks: vi.fn(() => []),
  getRecentMissionTasks: vi.fn(() => []),
  saveWarRoomConversationTurn: vi.fn(),
  insertAuditLog: vi.fn(),
  saveTokenUsage: vi.fn(),
  getDashboardSetting: vi.fn(() => null),
  logToHiveMind: vi.fn(),
}));

vi.mock('./memory.js', () => ({
  buildMemoryContext: vi.fn(async () => ''),
}));

vi.mock('./memory-ingest.js', () => ({
  ingestConversationTurn: vi.fn(async () => undefined),
}));

vi.mock('./agent-config.js', () => ({
  resolveAgentDir: (id: string) => `/tmp/test-orchestrator/agents/${id}`,
  loadAgentConfig: () => ({ name: 'stub', description: '', botToken: '', botTokenEnv: '' }),
  listAllAgents: () => [],
}));

vi.mock('./security.js', () => ({
  getScrubbedSdkEnv: () => ({}),
}));

const {
  pickSlashRoster,
  maybeLogWarRoomToHive,
  SLASH_HARD_CAP,
} = await import('./warroom-text-orchestrator.js');

type Roster = Array<{ id: string; name: string; description: string }>;
function buildRoster(ids: string[]): Roster {
  return ids.map((id) => ({
    id,
    name: id[0].toUpperCase() + id.slice(1),
    description: '',
  }));
}

beforeEach(() => {
  // pickSlashRoster keeps a module-level rotation offset map keyed by
  // meetingId. Each test that exercises rotation uses a fresh meetingId
  // so cases don't leak through that map.
});

// ── SLASH_HARD_CAP ↔ UI MAX_CAP regression (F-03) ───────────────────
// If you change SLASH_HARD_CAP, update MAX_CAP in
// web/src/pages/StandupConfig.tsx in the same commit. The test reads
// the .tsx source and re-derives MAX_CAP so the constant cannot drift
// silently between the slider's upper bound and the server's clamp.

describe('SLASH_HARD_CAP ↔ UI MAX_CAP', () => {
  it('matches the value the UI assumes (currently 8)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path');
    expect(SLASH_HARD_CAP).toBe(8);
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', 'web', 'src', 'pages', 'StandupConfig.tsx'),
      'utf8',
    );
    const m = src.match(/const\s+MAX_CAP\s*=\s*(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(SLASH_HARD_CAP);
  });
});

// ── pickSlashRoster ──────────────────────────────────────────────────

describe('pickSlashRoster', () => {
  it('default order with no config: canonical first, others appended', () => {
    const roster = buildRoster(['main', 'comms', 'content', 'ops', 'research', 'meta']);
    const result = pickSlashRoster(roster, {}, () => null);
    // canonical is research, ops, comms, content, main; meta is non-canonical
    expect(result.speakers).toEqual(['research', 'ops', 'comms', 'content', 'main', 'meta']);
    expect(result.skipped).toEqual([]);
    expect(result.adhoc).toBe(false);
  });

  it('respects saved config order, drops disabled', () => {
    const roster = buildRoster(['main', 'comms', 'content', 'ops', 'research', 'meta']);
    const reader = () => ({
      agents: [
        { id: 'meta', enabled: true },
        { id: 'comms', enabled: false },
        { id: 'main', enabled: true },
        { id: 'research', enabled: true },
      ],
      maxSpeakers: 8,
    });
    const result = pickSlashRoster(roster, {}, reader);
    expect(result.speakers).toEqual(['meta', 'main', 'research', 'content', 'ops']);
    // Note: content and ops are newcomers (not in saved config) so they
    // are appended at the bottom. Disabled comms is dropped entirely.
    expect(result.adhoc).toBe(false);
  });

  it('appends newcomers (not in saved config) at the bottom, enabled by default', () => {
    const roster = buildRoster(['main', 'comms', 'newbie']);
    const reader = () => ({
      agents: [
        { id: 'comms', enabled: true },
        { id: 'main', enabled: true },
      ],
      maxSpeakers: 8,
    });
    const result = pickSlashRoster(roster, {}, reader);
    expect(result.speakers).toEqual(['comms', 'main', 'newbie']);
  });

  it('filters out saved config entries that no longer exist in the roster', () => {
    const roster = buildRoster(['main', 'comms']);
    const reader = () => ({
      agents: [
        { id: 'comms', enabled: true },
        { id: 'deleted_agent', enabled: true },
        { id: 'main', enabled: true },
      ],
      maxSpeakers: 8,
    });
    const result = pickSlashRoster(roster, {}, reader);
    expect(result.speakers).toEqual(['comms', 'main']);
    expect(result.speakers).not.toContain('deleted_agent');
  });

  it('dedupes duplicate ids in saved config (Codex T1-1)', () => {
    const roster = buildRoster(['main', 'comms', 'research']);
    const reader = () => ({
      agents: [
        { id: 'comms', enabled: true },
        { id: 'comms', enabled: true },
        { id: 'main', enabled: true },
        { id: 'comms', enabled: true },
      ],
      maxSpeakers: 8,
    });
    const result = pickSlashRoster(roster, {}, reader);
    // comms appears once despite the saved config naming it three times.
    expect(result.speakers.filter((id) => id === 'comms')).toHaveLength(1);
    expect(result.speakers).toEqual(['comms', 'main', 'research']);
  });

  it('cycles past the cap on repeat calls within the same meeting', () => {
    // 12 agents, cap 8 → first batch [0..7], second batch [8..11, 0..3].
    const ids = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10', 'a11', 'a12'];
    const roster = buildRoster(ids);
    const reader = () => ({
      agents: ids.map((id) => ({ id, enabled: true })),
      maxSpeakers: 8,
    });

    const meetingId = `rotation-test-${Date.now()}`;
    const first = pickSlashRoster(roster, { meetingId }, reader);
    expect(first.speakers).toEqual(ids.slice(0, 8));
    expect(first.skipped).toEqual(ids.slice(8));

    const second = pickSlashRoster(roster, { meetingId }, reader);
    // Wraps around: starts at index 8, takes 8 ids, wrapping to the top.
    expect(second.speakers).toEqual([...ids.slice(8), ...ids.slice(0, 4)]);
  });

  it('forceOrder overrides saved config and canonical order', () => {
    const roster = buildRoster(['main', 'comms', 'content', 'ops', 'research']);
    const reader = () => ({
      agents: [{ id: 'main', enabled: true }],
      maxSpeakers: 1,
    });
    const result = pickSlashRoster(
      roster,
      { forceOrder: ['research', 'comms'] },
      reader,
    );
    expect(result.speakers).toEqual(['research', 'comms']);
    expect(result.adhoc).toBe(true);
  });

  it('forceOrder silently drops typoed @ids not in the roster', () => {
    const roster = buildRoster(['main', 'comms']);
    const result = pickSlashRoster(
      roster,
      { forceOrder: ['main', 'totally_made_up', 'comms', 'main'] },
      () => null,
    );
    // dedupe + roster-filter: main once, made-up dropped, comms kept.
    expect(result.speakers).toEqual(['main', 'comms']);
    expect(result.adhoc).toBe(true);
  });

  it('per-agent budget is clamped to [30s, 65s] across speaker counts', () => {
    const roster = buildRoster(['main', 'comms', 'content', 'ops', 'research', 'meta', 'a7', 'a8']);
    // 1 speaker → raw budget 270_000 → clamped down to 65_000
    const one = pickSlashRoster(roster, { forceOrder: ['main'] }, () => null);
    expect(one.budgetMs).toBe(65_000);

    // 8 speakers → raw budget 33_750 → between 30k and 65k unchanged
    const eight = pickSlashRoster(
      roster,
      { forceOrder: ['main', 'comms', 'content', 'ops', 'research', 'meta', 'a7', 'a8'] },
      () => null,
    );
    expect(eight.budgetMs).toBeGreaterThanOrEqual(30_000);
    expect(eight.budgetMs).toBeLessThanOrEqual(65_000);
    // Specifically: 270_000 / 8 = 33_750
    expect(eight.budgetMs).toBe(33_750);

    // Floor: forceOrder accepts more than the cap of 8, so a 12-id push
    // is sliced to 8 first, then budget computed against 8. The clamp
    // floor (30_000) only kicks in if speakerCount were huge — assert
    // that the implementation does NOT exceed the floor for the cap
    // case (sanity check on the floor constant).
    expect(eight.budgetMs).toBeGreaterThan(30_000);
  });
});

// ── maybeLogWarRoomToHive ────────────────────────────────────────────

describe('maybeLogWarRoomToHive', () => {
  it('logs primary reply with action=warroom_reply', () => {
    const log = vi.fn();
    const result = maybeLogWarRoomToHive({
      agentId: 'comms',
      meetingChatId: '12345',
      role: 'primary',
      finalText: 'This is a real reply long enough to clear the floor.',
      incomplete: false,
      assistantInserted: true,
    }, log);
    expect(result.logged).toBe(true);
    expect(result.action).toBe('warroom_reply');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      'comms',
      '12345',
      'warroom_reply',
      'This is a real reply long enough to clear the floor.',
    );
  });

  it('logs intervener reply with action=warroom_chime_in', () => {
    const log = vi.fn();
    const result = maybeLogWarRoomToHive({
      agentId: 'research',
      meetingChatId: '12345',
      role: 'intervener',
      finalText: 'Adding context: this is a chime-in from research.',
      incomplete: false,
      assistantInserted: true,
    }, log);
    expect(result.logged).toBe(true);
    expect(result.action).toBe('warroom_chime_in');
    expect(log).toHaveBeenCalledWith(
      'research',
      '12345',
      'warroom_chime_in',
      expect.any(String),
    );
  });

  it('skips replies under 25 chars (filters "ok" / "noted")', () => {
    const log = vi.fn();
    const result = maybeLogWarRoomToHive({
      agentId: 'comms',
      meetingChatId: '12345',
      role: 'primary',
      finalText: 'noted',
      incomplete: false,
      assistantInserted: true,
    }, log);
    expect(result.logged).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  it('skips when meetingChatId is empty (legacy meeting safety)', () => {
    const log = vi.fn();
    const result = maybeLogWarRoomToHive({
      agentId: 'comms',
      meetingChatId: '',
      role: 'primary',
      finalText: 'A reply long enough to otherwise meet the threshold easily.',
      incomplete: false,
      assistantInserted: true,
    }, log);
    expect(result.logged).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  it('skips on assistantInserted=false (retry replay dedupe)', () => {
    const log = vi.fn();
    const result = maybeLogWarRoomToHive({
      agentId: 'comms',
      meetingChatId: '12345',
      role: 'primary',
      finalText: 'A reply long enough to otherwise meet the threshold easily.',
      incomplete: false,
      assistantInserted: false,
    }, log);
    expect(result.logged).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });
});

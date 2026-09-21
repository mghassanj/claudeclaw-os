import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  decayMemories,
  getDatabaseHandle,
  getRecentHighImportanceMemories,
  pinMemory,
  saveStructuredMemory,
  setSession,
  type HiveMindEntry,
} from './db.js';
import { _resetInjectedMemoryTracking, buildMemoryContext, dedupeTeamActivity } from './memory.js';
import { createLoop } from './open-loops.js';
import { addContact } from './contacts.js';

const db = () => getDatabaseHandle();
const DAY = 86400;
const nowSec = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  _initTestDatabase();
  _resetInjectedMemoryTracking();
});

describe('recent high-importance layer', () => {
  it('orders by importance * salience', () => {
    const a = saveStructuredMemory('c', 'r', 'important but faded', [], [], 1.0);
    const b = saveStructuredMemory('c', 'r', 'medium and fresh', [], [], 0.6);
    db().prepare('UPDATE memories SET salience = 0.2 WHERE id = ?').run(a);
    db().prepare('UPDATE memories SET accessed_at = accessed_at - 100 WHERE id = ?').run(b);
    expect(getRecentHighImportanceMemories('c', 5).map((m) => m.id)).toEqual([b, a]);
  });

  it('skips rows already injected this session and resets on a new session', async () => {
    for (let i = 0; i < 7; i++) saveStructuredMemory('c', 'r', `rule number ${i}`, [], [], 0.9 - i * 0.01);
    setSession('c', 'session-1', 'main');
    const first = await buildMemoryContext('c', 'zzqq unrelated', 'main', { includeTeamActivity: false });
    const second = await buildMemoryContext('c', 'zzqq unrelated', 'main', { includeTeamActivity: false });
    expect(first.surfacedMemoryIds).toHaveLength(5);
    expect(second.surfacedMemoryIds).toHaveLength(2);
    expect(second.surfacedMemoryIds.some((id) => first.surfacedMemoryIds.includes(id))).toBe(false);

    setSession('c', 'session-2', 'main');
    const third = await buildMemoryContext('c', 'zzqq unrelated', 'main', { includeTeamActivity: false });
    expect(third.surfacedMemoryIds).toEqual(first.surfacedMemoryIds);
  });
});

describe('pin + decay', () => {
  it('pinning resets salience to 1.0', () => {
    const id = saveStructuredMemory('c', 'r', 'x', [], [], 0.9);
    db().prepare('UPDATE memories SET salience = 0.05 WHERE id = ?').run(id);
    pinMemory(id);
    const row = db().prepare('SELECT pinned, salience FROM memories WHERE id = ?').get(id) as { pinned: number; salience: number };
    expect(row).toEqual({ pinned: 1, salience: 1.0 });
  });

  it('does not decay rows younger than 30 days', () => {
    const young = saveStructuredMemory('c', 'r', 'young', [], [], 0.6);
    const old = saveStructuredMemory('c', 'r', 'old', [], [], 0.6);
    db().prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(nowSec() - 29 * DAY, young);
    db().prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(nowSec() - 31 * DAY, old);
    decayMemories();
    const sal = (id: number) => (db().prepare('SELECT salience FROM memories WHERE id = ?').get(id) as { salience: number }).salience;
    expect(sal(young)).toBe(1.0);
    expect(sal(old)).toBeCloseTo(0.98, 5);
  });
});

describe('team activity dedupe', () => {
  const e = (agent: string, action: string, summary: string, created_at: number, id = created_at): HiveMindEntry =>
    ({ id, agent_id: agent, chat_id: 'c', action, summary, artifacts: null, created_at });

  it('one line per agent; identical repeated actions collapse into a count', () => {
    const t = 1_000_000;
    const lines = dedupeTeamActivity([
      e('scrum', 'TRIAGE_BLOCKED', 'Jira 401 (latest)', t - 60),
      e('scrum', 'TRIAGE_BLOCKED', 'Jira 401', t - 120),
      e('scrum', 'TRIAGE_BLOCKED', 'Jira 401', t - 180),
      e('research', 'daily_sweep', 'HR-tech sweep', t - 7200),
      e('scrum', 'GMAIL_SCAN', 'Gmail scan', t - 9000),
    ], t);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('- [scrum] 1m ago: Jira 401 (latest) (×3 TRIAGE_BLOCKED)');
    expect(lines[1]).toBe('- [research] 2h ago: HR-tech sweep');
  });
});

describe('PA blocks in buildMemoryContext', () => {
  it('main agent gets [Open loops] and [People]; strict/war-room callers do not', async () => {
    const n = addContact({ display_name: 'Nora', language_pref: 'ar-najdi' });
    createLoop({ kind: 'await_reply', summary: 'Nora reply on Thursday', contact_id: n.id, chat_ref: '966500000001@c.us' });
    const main = await buildMemoryContext('c', 'any news from Nora?', 'main', { includeTeamActivity: false });
    expect(main.contextText).toContain('[Open loops');
    expect(main.contextText).toContain('[People');
    expect(main.contextText).toContain('ar-najdi');
    const other = await buildMemoryContext('c', 'any news from Nora?', 'comms', { includeTeamActivity: false });
    expect(other.contextText).not.toContain('[Open loops');
    const strict = await buildMemoryContext('c', 'any news from Nora?', 'main', { strictAgentId: 'main', includeTeamActivity: false });
    expect(strict.contextText).not.toContain('[People');
  });
});

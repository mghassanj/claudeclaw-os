import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase } from './db.js';
import { addContact } from './contacts.js';
import { getLoop, listLoops } from './open-loops.js';
import { runLoopsCli } from './loops-cli.js';
import { parseArgs, parseWhen } from './pa-cli-util.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('parseWhen', () => {
  const base = Date.UTC(2026, 8, 21, 12, 0, 0);
  it('relative and absolute', () => {
    expect(parseWhen('30m', base)).toBe(base / 1000 + 1800);
    expect(parseWhen('+2h', base)).toBe(base / 1000 + 7200);
    expect(parseWhen('1d', base)).toBe(base / 1000 + 86400);
    expect(parseWhen('2026-09-22T09:00+03:00')).toBe(Date.UTC(2026, 8, 22, 6, 0, 0) / 1000);
    expect(parseWhen('someday')).toBeNull();
  });

  it('parseArgs handles boolean flags and repeats', () => {
    const p = parseArgs(['7', '--force', '--alias', 'a', '--alias=b', 'tail']);
    expect(p.positional).toEqual(['7', 'tail']);
    expect(p.flags.get('force')).toEqual(['true']);
    expect(p.flags.get('alias')).toEqual(['a', 'b']);
  });
});

describe('loops-cli', () => {
  it('adds an await_reply loop for a contact and refuses a duplicate watcher', () => {
    addContact({ display_name: 'Nora', wa_chat_id: '966500000001@c.us' });
    const r = runLoopsCli(['add', '--kind', 'await_reply', '--contact', 'Nora', '--summary', 'Nora reply', '--intent', 'draft + ask', '--origin', 'whatsapp-self'], 'main');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Loop #1 created (await_reply, status waiting)');
    const dup = runLoopsCli(['add', '--kind', 'await_reply', '--chat', '966500000001@c.us', '--summary', 'again']);
    expect(dup.out).toContain('Already watching this chat: loop #1');
    expect(listLoops()).toHaveLength(1);
    expect(runLoopsCli(['add', '--kind', 'await_reply', '--chat', '966500000001@c.us', '--summary', 'again', '--force']).code).toBe(0);
    expect(listLoops()).toHaveLength(2);
  });

  it('validates input', () => {
    expect(runLoopsCli(['add', '--kind', 'poll', '--summary', 'x']).code).toBe(1);
    expect(runLoopsCli(['add', '--kind', 'reminder', '--summary', 'x']).out).toContain('--due is required');
    expect(runLoopsCli(['add', '--kind', 'await_reply', '--summary', 'x']).out).toContain('needs --chat');
    expect(runLoopsCli(['add', '--kind', 'await_reply', '--contact', 'Ghost', '--summary', 'x']).out).toContain('No contact');
    expect(runLoopsCli(['add', '--kind', 'reminder', '--due', 'soonish', '--summary', 'x']).code).toBe(1);
    expect(runLoopsCli(['add', '--kind', 'reminder', '--due', '1h', '--summary', 'x', '--origin', 'email']).code).toBe(1);
  });

  it('close / snooze / drop / confirm / show / list', () => {
    runLoopsCli(['add', '--kind', 'reminder', '--due', '1h', '--summary', 'call bank']);
    expect(runLoopsCli(['snooze', '1', '3h']).code).toBe(0);
    expect(runLoopsCli(['show', '1']).out).toContain('call bank');
    expect(runLoopsCli(['list']).out).toContain('#1 reminder');
    expect(runLoopsCli(['close', '1', 'called', 'them']).code).toBe(0);
    expect(getLoop(1)?.resolution).toBe('called them');
    expect(runLoopsCli(['close', '1']).code).toBe(1);
    expect(runLoopsCli(['list']).out).toBe('No open loops.');
    expect(runLoopsCli(['list', '--all']).out).toContain('[done]');
    runLoopsCli(['add', '--kind', 'promise', '--due', '1d', '--summary', 'send deck']);
    expect(runLoopsCli(['drop', '2', 'not needed']).code).toBe(0);
    expect(runLoopsCli(['confirm', '2']).code).toBe(1);
    expect(runLoopsCli(['snooze', 'x', '1h']).code).toBe(1);
  });
});

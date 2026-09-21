import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, getDatabaseHandle } from './db.js';
import { addContact } from './contacts.js';
import {
  buildOpenLoopsBlock,
  claimDeadlineNudge,
  claimFire,
  closeLoop,
  confirmLoop,
  createLoop,
  dropLoop,
  expireLoops,
  getDueLoops,
  getLoop,
  listLoops,
  matchAwaitReplyLoops,
  snoozeLoop,
} from './open-loops.js';

const now = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  _initTestDatabase();
});

describe('createLoop', () => {
  it('await_reply starts waiting; reminders start open with next_check_at = due', () => {
    const a = createLoop({ kind: 'await_reply', summary: 'Nora reply', chat_ref: '966500000001@c.us' });
    expect(a.status).toBe('waiting');
    expect(a.expires_at).toBeGreaterThan(now() + 6 * 86400);
    const due = now() + 3600;
    const r = createLoop({ kind: 'reminder', summary: 'call bank', due_at: due });
    expect(r.status).toBe('open');
    expect(r.next_check_at).toBe(due);
  });

  it('unconfirmed commitments never get a next check until confirmed', () => {
    const due = now() - 10;
    const c = createLoop({ kind: 'promise', summary: 'send deck', due_at: due, needs_confirmation: true });
    expect(c.next_check_at).toBeNull();
    expect(getDueLoops()).toHaveLength(0);
    expect(confirmLoop(c.id)).toBe(true);
    expect(getDueLoops().map((l) => l.id)).toEqual([c.id]);
  });
});

describe('matchAwaitReplyLoops', () => {
  it('matches a DM reply across @c.us / bare phone forms', () => {
    const l = createLoop({ kind: 'await_reply', summary: 'x', chat_ref: '966500000001@c.us' });
    expect(matchAwaitReplyLoops({ chatId: '12345678901@lid', isGroup: false, senderIds: ['12345678901@lid', '966500000001'] }).map((x) => x.id)).toEqual([l.id]);
  });

  it('a DM-bound loop does not fire on the same person in a group', () => {
    createLoop({ kind: 'await_reply', summary: 'x', chat_ref: '966500000001@c.us' });
    expect(matchAwaitReplyLoops({ chatId: '120363000000@g.us', isGroup: true, senderIds: ['966500000001@c.us'] })).toHaveLength(0);
  });

  it('a group-bound loop fires on any member; a contact-only loop fires on that contact anywhere', () => {
    const g = createLoop({ kind: 'await_reply', summary: 'group', chat_ref: '120363000000@g.us' });
    const nora = addContact({ display_name: 'Nora', wa_chat_id: '966500000001@c.us' });
    const c = createLoop({ kind: 'await_reply', summary: 'contact', contact_id: nora.id });
    const hit = matchAwaitReplyLoops({ chatId: '120363000000@g.us', isGroup: true, senderIds: ['966500000001@c.us'] });
    expect(hit.map((x) => x.id).sort()).toEqual([g.id, c.id].sort());
    expect(matchAwaitReplyLoops({ chatId: '120363000000@g.us', isGroup: true, senderIds: ['966599999999@c.us'] }).map((x) => x.id)).toEqual([g.id]);
  });

  it('ignores closed / fired loops', () => {
    const l = createLoop({ kind: 'await_reply', summary: 'x', chat_ref: '966500000001@c.us' });
    closeLoop(l.id, 'handled');
    expect(matchAwaitReplyLoops({ chatId: '966500000001@c.us', isGroup: false, senderIds: [] })).toHaveLength(0);
  });
});

describe('claimFire', () => {
  it('is atomic: the second claim of a max_fires=1 loop fails', () => {
    const l = createLoop({ kind: 'await_reply', summary: 'x', chat_ref: '966500000001@c.us' });
    const first = claimFire(l.id, 'msg-1', '{}');
    expect(first?.status).toBe('fired');
    expect(first?.pending_trigger).toBe('{}');
    expect(claimFire(l.id, 'msg-2', '{}')).toBeNull();
  });

  it('max_fires > 1 keeps waiting but refuses the same trigger twice', () => {
    const l = createLoop({ kind: 'await_reply', summary: 'x', chat_ref: '966500000001@c.us', max_fires: 3 });
    expect(claimFire(l.id, 'msg-1', '{}')?.status).toBe('waiting');
    expect(claimFire(l.id, 'msg-1', '{}')).toBeNull();
    expect(claimFire(l.id, 'msg-2', '{}')?.fired_count).toBe(2);
  });

  it('deadline nudge does not consume a fire', () => {
    const l = createLoop({ kind: 'await_reply', summary: 'x', chat_ref: '966500000001@c.us', due_at: now() - 5 });
    expect(getDueLoops().map((x) => x.id)).toEqual([l.id]);
    const n = claimDeadlineNudge(l.id, '{}');
    expect(n?.status).toBe('waiting');
    expect(n?.fired_count).toBe(0);
    expect(n?.next_check_at).toBeNull();
    expect(getDueLoops()).toHaveLength(0);
  });
});

describe('lifecycle', () => {
  it('close / drop only affect active loops', () => {
    const l = createLoop({ kind: 'reminder', summary: 'x', due_at: now() + 60 });
    expect(dropLoop(l.id, 'not needed')).toBe(true);
    expect(getLoop(l.id)?.status).toBe('dropped');
    expect(closeLoop(l.id)).toBe(false);
  });

  it('snooze pushes the next check and re-arms a fired loop', () => {
    const l = createLoop({ kind: 'reminder', summary: 'x', due_at: now() - 5 });
    claimFire(l.id, 'due', '{}');
    expect(getLoop(l.id)?.status).toBe('fired');
    const until = now() + 7200;
    expect(snoozeLoop(l.id, until)).toBe(true);
    const s = getLoop(l.id)!;
    expect(s.status).toBe('open');
    expect(s.next_check_at).toBe(until);
    expect(claimFire(l.id, 'due2', '{}')).not.toBeNull();
  });

  it('expireLoops marks each expired loop exactly once', () => {
    const l = createLoop({ kind: 'await_reply', summary: 'x', chat_ref: '966500000001@c.us', expires_at: now() - 1 });
    expect(expireLoops().map((x) => x.id)).toEqual([l.id]);
    expect(expireLoops()).toHaveLength(0);
    expect(getLoop(l.id)?.status).toBe('expired');
  });
});

describe('buildOpenLoopsBlock', () => {
  it('is empty with no loops', () => {
    expect(buildOpenLoopsBlock()).toBe('');
  });

  it('shows overdue first and caps at 8', () => {
    for (let i = 0; i < 9; i++) createLoop({ kind: 'reminder', summary: `future ${i}`, due_at: now() + 3600 * (i + 1) });
    const overdue = createLoop({ kind: 'promise', summary: 'late one', due_at: now() - 7200 });
    const block = buildOpenLoopsBlock(8);
    const lines = block.split('\n').filter((x) => x.startsWith('- '));
    expect(lines[0]).toContain(`#${overdue.id}`);
    expect(lines[0]).toContain('OVERDUE');
    expect(lines).toHaveLength(9); // 8 loops + "…and 2 more"
    expect(block).toContain('and 2 more');
  });

  it('flags unconfirmed commitments', () => {
    createLoop({ kind: 'promise', summary: 'maybe', needs_confirmation: true });
    expect(buildOpenLoopsBlock()).toContain('UNCONFIRMED');
    expect(listLoops()).toHaveLength(1);
  });
});

describe('schema', () => {
  it('rejects unknown kinds/statuses', () => {
    expect(() => getDatabaseHandle().prepare(
      `INSERT INTO open_loops (kind, summary, expires_at, created_at, updated_at) VALUES ('poll', 'x', 1, 1, 1)`,
    ).run()).toThrow();
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import {
  _initTestDatabase,
  createScheduledTask,
  getAllScheduledTasks,
  markTaskRunning,
  recoverInterruptedTasks,
  createMissionTask,
  claimNextMissionTask,
  getMissionTask,
  recoverInterruptedMissions,
  MAX_MISSION_ATTEMPTS,
  INTERRUPTED_TASK_NOTE,
  updateTaskAfterRun,
} from './db.js';

describe('startup recovery records interruptions', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('marks a running scheduled task interrupted (not silently reset) and returns it', () => {
    const now = Math.floor(Date.now() / 1000);
    createScheduledTask('t1', 'morning brief', '0 8 * * *', now - 60, 'main');
    markTaskRunning('t1', now + 86_400);
    createScheduledTask('t2', 'idle', '0 9 * * *', now + 3600, 'main');

    const rec = recoverInterruptedTasks('main');
    expect(rec.map((r) => r.id)).toEqual(['t1']);

    const t1 = getAllScheduledTasks('main').find((t) => t.id === 't1')!;
    expect(t1.status).toBe('active');
    expect(t1.last_status).toBe('interrupted');
    expect(t1.last_result).toBe(INTERRUPTED_TASK_NOTE);
    expect(t1.started_at).toBeNull();
    // next_run stays advanced, so the interrupted run is not re-fired.
    expect(t1.next_run).toBe(now + 86_400);
    // Second startup: nothing left to report (notify once).
    expect(recoverInterruptedTasks('main')).toHaveLength(0);
  });

  it('accepts blocked as a last_status', () => {
    const now = Math.floor(Date.now() / 1000);
    createScheduledTask('t1', 'x', '0 8 * * *', now, 'main');
    updateTaskAfterRun('t1', now + 60, 'no access', 'blocked');
    expect(getAllScheduledTasks('main')[0].last_status).toBe('blocked');
  });

  it('counts mission attempts, re-queues once, then fails instead of looping', () => {
    createMissionTask('m1', 'Draft report', 'do it', 'main');
    const claimed = claimNextMissionTask('main')!;
    expect(claimed.attempts).toBe(1);

    let rec = recoverInterruptedMissions('main');
    expect(rec).toEqual([{ id: 'm1', title: 'Draft report', attempts: 1, action: 'requeued' }]);
    let m = getMissionTask('m1')!;
    expect(m.status).toBe('queued');
    expect(m.error).toMatch(/Interrupted by a restart on attempt 1/);

    expect(claimNextMissionTask('main')!.attempts).toBe(MAX_MISSION_ATTEMPTS);
    rec = recoverInterruptedMissions('main');
    expect(rec[0].action).toBe('failed');
    m = getMissionTask('m1')!;
    expect(m.status).toBe('failed');
    expect(m.error).toMatch(/not re-run automatically/);
    expect(claimNextMissionTask('main')).toBeNull();
  });
});

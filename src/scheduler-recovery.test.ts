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
  retryMissionTask,
  getMissionTaskHistory,
  cancelMissionTask,
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

  it('marks a running mission interrupted (never re-queued automatically) and returns it once', () => {
    createMissionTask('m1', 'Draft report', 'do it', 'main');
    createMissionTask('m2', 'Other agent', 'x', 'research');
    expect(claimNextMissionTask('main')!.attempts).toBe(1);
    claimNextMissionTask('research');

    const rec = recoverInterruptedMissions('main');
    expect(rec).toEqual([{ id: 'm1', title: 'Draft report', attempts: 1 }]);
    const m = getMissionTask('m1')!;
    expect(m.status).toBe('interrupted');
    expect(m.error).toMatch(/Interrupted by a restart on attempt 1; not re-run automatically/);
    expect(m.error).toContain('mission-cli retry m1');
    expect(m.completed_at).not.toBeNull();
    // Not claimable: it does not run again on its own.
    expect(claimNextMissionTask('main')).toBeNull();
    // Notify once: a second startup finds nothing.
    expect(recoverInterruptedMissions('main')).toHaveLength(0);
    // Other agents' missions are untouched.
    expect(getMissionTask('m2')!.status).toBe('running');
    // Shows up in history (terminal until retried).
    expect(getMissionTaskHistory().tasks.map((t) => t.id)).toContain('m1');
  });

  it('retry re-queues only interrupted missions; the retried run is a fresh claim', () => {
    createMissionTask('m1', 'Draft report', 'do it', 'main');
    claimNextMissionTask('main');
    expect(retryMissionTask('m1')).toBeNull(); // running: not retryable
    recoverInterruptedMissions('main');

    const t = retryMissionTask('m1')!;
    expect(t).toMatchObject({ id: 'm1', status: 'queued', error: null, started_at: null, completed_at: null });
    expect(retryMissionTask('m1')).toBeNull(); // already queued
    expect(retryMissionTask('nope')).toBeNull();

    const again = claimNextMissionTask('main')!;
    expect(again.id).toBe('m1');
    expect(again.attempts).toBe(2);
  });

  it('an interrupted mission can be cancelled instead of retried', () => {
    createMissionTask('m1', 'Draft report', 'do it', 'main');
    claimNextMissionTask('main');
    recoverInterruptedMissions('main');
    expect(cancelMissionTask('m1')).toBe(true);
    expect(getMissionTask('m1')!.status).toBe('cancelled');
    expect(retryMissionTask('m1')).toBeNull();
  });
});

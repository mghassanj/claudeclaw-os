import { describe, it, expect, beforeEach } from 'vitest';
import { evaluateAcceptance } from './acceptance.js';
import { _initTestDatabase, createScheduledTask, getAllScheduledTasks } from './db.js';

describe('evaluateAcceptance', () => {
  it('passes when there is no acceptance check (null)', () => {
    expect(evaluateAcceptance(null, 'anything at all')).toBe(true);
  });

  it('passes when the acceptance check is empty/whitespace', () => {
    expect(evaluateAcceptance('   ', 'anything')).toBe(true);
  });

  it('passes when the output contains the check (case-insensitive)', () => {
    expect(evaluateAcceptance('shipped', 'Done — SHIPPED to main')).toBe(true);
  });

  it('fails when the output does not contain the check', () => {
    expect(evaluateAcceptance('shipped', "I'll get to it later")).toBe(false);
  });

  it('fails when output is empty but a check is required', () => {
    expect(evaluateAcceptance('PR opened', '')).toBe(false);
  });
});

describe('scheduled task acceptance_check persistence', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('defaults acceptance_check to null when omitted', () => {
    const nextRun = Math.floor(Date.now() / 1000) + 3600;
    createScheduledTask('t1', 'do something', '0 9 * * *', nextRun, 'main');
    expect(getAllScheduledTasks('main')[0].acceptance_check).toBeNull();
  });

  it('persists a provided acceptance_check', () => {
    const nextRun = Math.floor(Date.now() / 1000) + 3600;
    createScheduledTask('t2', 'ship it', '0 9 * * *', nextRun, 'main', 'PR opened');
    expect(getAllScheduledTasks('main')[0].acceptance_check).toBe('PR opened');
  });
});

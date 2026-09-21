import { describe, it, expect } from 'vitest';
import {
  formatAbortedReply,
  formatTimeoutLabel,
  parseTaskStatus,
  resolveScheduledStatus,
  shouldAlertStatusChange,
  wrapScheduledPrompt,
  escapeHtml,
} from './turn-outcome.js';

describe('formatAbortedReply', () => {
  it('labels a timeout and keeps the partial text', () => {
    expect(formatAbortedReply('half done', { timedOut: true, timeoutMs: 900_000 }))
      .toBe('⏱ Timed out after 15m — partial result:\nhalf done');
  });
  it('says so when a timeout produced nothing', () => {
    expect(formatAbortedReply('  ', { timedOut: true, timeoutMs: 45_000 }))
      .toBe('⏱ Timed out after 45s — no result was produced.');
  });
  it('reports a user stop as Stopped, never Done', () => {
    expect(formatAbortedReply(null, { timedOut: false, timeoutMs: 1 })).toBe('Stopped.');
    expect(formatAbortedReply('draft', { timedOut: false, timeoutMs: 1 })).toBe('Stopped — partial result:\ndraft');
  });
  it('formats timeout labels', () => {
    expect(formatTimeoutLabel(30 * 60_000)).toBe('30m');
    expect(formatTimeoutLabel(500)).toBe('1s');
  });
});

describe('parseTaskStatus', () => {
  it('parses the last-line STATUS with an em-dash reason', () => {
    expect(parseTaskStatus('Report...\n\nSTATUS: blocked — Jira token expired'))
      .toEqual({ status: 'blocked', reason: 'Jira token expired' });
  });
  it('accepts hyphen / colon separators, case and markdown bold', () => {
    expect(parseTaskStatus('x\nstatus: FAILED - api 500')).toEqual({ status: 'failed', reason: 'api 500' });
    expect(parseTaskStatus('x\n**STATUS:** ok')).toEqual({ status: 'ok', reason: '' });
    expect(parseTaskStatus('x\n`STATUS: ok: all good`')).toEqual({ status: 'ok', reason: 'all good' });
  });
  it('returns null when absent or not on the last line', () => {
    expect(parseTaskStatus('all done')).toBeNull();
    expect(parseTaskStatus('STATUS: blocked — x\nmore text after')).toBeNull();
    expect(parseTaskStatus(null)).toBeNull();
    expect(parseTaskStatus('STATUS: maybe')).toBeNull();
  });
});

describe('resolveScheduledStatus', () => {
  it('lets an explicit blocked/failed win over a passing acceptance check', () => {
    expect(resolveScheduledStatus({ status: 'blocked', reason: '' }, true)).toBe('blocked');
    expect(resolveScheduledStatus({ status: 'failed', reason: '' }, true)).toBe('failed');
  });
  it('keeps the acceptance-only behavior without a STATUS line', () => {
    expect(resolveScheduledStatus(null, true)).toBe('success');
    expect(resolveScheduledStatus(null, false)).toBe('failed');
  });
  it('an explicit ok still fails a failed acceptance check', () => {
    expect(resolveScheduledStatus({ status: 'ok', reason: '' }, false)).toBe('failed');
  });
});

describe('shouldAlertStatusChange', () => {
  it('alerts on transition into blocked/failed only', () => {
    expect(shouldAlertStatusChange('success', 'blocked')).toBe(true);
    expect(shouldAlertStatusChange(null, 'failed')).toBe(true);
    expect(shouldAlertStatusChange('blocked', 'failed')).toBe(true);
    expect(shouldAlertStatusChange('blocked', 'blocked')).toBe(false);
    expect(shouldAlertStatusChange('failed', 'failed')).toBe(false);
    expect(shouldAlertStatusChange('blocked', 'success')).toBe(false);
  });
});

describe('misc', () => {
  it('wraps the scheduled prompt with the STATUS instruction', () => {
    const w = wrapScheduledPrompt('Run the scrum digest');
    expect(w.startsWith('Run the scrum digest\n\n')).toBe(true);
    expect(w).toContain('STATUS: ok|blocked|failed');
  });
  it('escapes HTML', () => {
    expect(escapeHtml('<a & b>')).toBe('&lt;a &amp; b&gt;');
  });
});

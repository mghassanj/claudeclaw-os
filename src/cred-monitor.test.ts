import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('./logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { _initTestDatabase, getCredHealth, getDashboardSetting } from './db.js';
import {
  ProbeContext,
  runAllProbes,
  runCredCheck,
  recordResults,
  formatDailySummary,
  credHealthSnapshot,
  probeGmail,
  probeRailway,
  isAuthDefinitive,
  SUMMARY_DAY_KEY,
  _resetCredMonitorState,
} from './cred-monitor.js';

const SECRETS = {
  TELEGRAM_BOT_TOKEN: 'tg-main-SECRET',
  OPS_BOT_TOKEN: 'tg-ops-SECRET',
  CLAUDE_CODE_OAUTH_TOKEN: 'claude-SECRET',
  JIRA_BASE_URL: 'https://jira.example',
  JIRA_USER_EMAIL: 'me@example.com',
  JIRA_API_TOKEN: 'jira-SECRET',
  JISR_CODEWIKI_TOKEN: 'cw-SECRET',
  RAILWAY_API_TOKEN: 'rw-SECRET',
  OPENAI_API_KEY: 'oa-SECRET',
  GOOGLE_API_KEY: 'g-SECRET',
  VOYAGE_API_KEY: 'vo-SECRET',
  WHATSAPP_ENABLED: 'true',
} as Record<string, string>;

type Handler = (url: string, init?: RequestInit) => { status: number; body?: unknown } | Error;

function makeCtx(env: Record<string, string>, handler: Handler, homeDir = os.tmpdir()) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = handler(url, init);
    if (r instanceof Error) throw r;
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
    return new Response(text, { status: r.status });
  }) as unknown as typeof fetch;
  const ctx: ProbeContext = {
    env: (k) => env[k] || undefined,
    envKeys: () => Object.keys(env),
    fetch: fetchImpl,
    timeoutMs: 1000,
    homeDir,
  };
  return { ctx, calls };
}

const allOk: Handler = (url) => {
  if (url.includes('api.telegram.org')) return { status: 200, body: { ok: true } };
  if (url.includes('railway')) return { status: 200, body: { data: { projects: { edges: [] } } } };
  if (url.includes('127.0.0.1')) return { status: 200, body: { state: 'READY' } };
  return { status: 200, body: {} };
};

beforeEach(() => {
  _initTestDatabase();
  _resetCredMonitorState();
});

describe('probes', () => {
  it('all configured probes ok; gmail skipped without token.json; detail has no secrets', async () => {
    const { ctx, calls } = makeCtx(SECRETS, allOk, fs.mkdtempSync(path.join(os.tmpdir(), 'cm-home-')));
    const results = await runAllProbes(ctx);
    const byName = Object.fromEntries(results.map((r) => [r.name, r]));
    expect(byName['telegram:TELEGRAM_BOT_TOKEN'].status).toBe('ok');
    expect(byName['telegram:OPS_BOT_TOKEN'].status).toBe('ok');
    for (const n of ['claude-oauth', 'jira', 'codewiki', 'railway', 'openai', 'google-api-key', 'voyage', 'whatsapp']) {
      expect(byName[n]?.status, n).toBe('ok');
    }
    expect(byName.gmail.status).toBe('skip');
    const serialized = JSON.stringify(results);
    for (const v of Object.values(SECRETS)) {
      if (v.includes('SECRET')) expect(serialized).not.toContain(v);
    }
    // Google key goes in a header, not the URL.
    const g = calls.find((c) => c.url.includes('generativelanguage'))!;
    expect(g.url).not.toContain('g-SECRET');
    // Railway uses the projects query, not `me`.
    const rw = calls.find((c) => c.url.includes('railway'))!;
    expect(String(rw.init?.body)).toContain('projects');
    expect(String(rw.init?.body)).not.toMatch(/\bme\b/);
  });

  it('missing env -> skip rows, no network calls', async () => {
    const { ctx, calls } = makeCtx({}, allOk, fs.mkdtempSync(path.join(os.tmpdir(), 'cm-home-')));
    const results = await runAllProbes(ctx);
    expect(results.every((r) => r.status === 'skip')).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('401 / timeout / network map to fail with a code only', async () => {
    const { ctx } = makeCtx(SECRETS, (url) => {
      if (url.includes('openai')) return { status: 401, body: { error: { message: 'Incorrect API key oa-SECRET' } } };
      if (url.includes('atlassian') || url.includes('jira')) {
        const e = new Error('timed out'); e.name = 'TimeoutError'; return e;
      }
      if (url.includes('127.0.0.1')) return Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      return allOk(url);
    });
    const results = await runAllProbes(ctx);
    const byName = Object.fromEntries(results.map((r) => [r.name, r]));
    expect(byName.openai).toMatchObject({ status: 'fail', detail: 'http 401' });
    expect(byName.jira).toMatchObject({ status: 'fail', detail: 'timeout' });
    expect(byName.whatsapp).toMatchObject({ status: 'fail', detail: 'network:ECONNREFUSED' });
    expect(JSON.stringify(results)).not.toContain('oa-SECRET');
  });

  it('railway graphql errors on HTTP 200 are a fail', async () => {
    const { ctx } = makeCtx(SECRETS, () => ({ status: 200, body: { errors: [{ message: 'Not Authorized' }] } }));
    expect(await probeRailway(ctx)).toMatchObject({ status: 'fail', detail: 'http 200 graphql errors' });
  });

  it('gmail refresh reports invalid_grant', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-home-'));
    fs.mkdirSync(path.join(home, '.config', 'gmail'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'gmail', 'token.json'), JSON.stringify({
      client_id: 'cid', client_secret: 'csec-SECRET', refresh_token: 'rt-SECRET', token_uri: 'https://oauth2.googleapis.com/token',
    }));
    const { ctx, calls } = makeCtx({}, () => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }), home);
    const r = await probeGmail(ctx);
    expect(r).toEqual({ name: 'gmail', status: 'fail', detail: 'http 400 invalid_grant' });
    expect(String(calls[0].init?.body)).toContain('grant_type=refresh_token');
  });
});

describe('transitions + alerting', () => {
  it('alerts once on ok->fail, stays quiet while failing, alerts on recovery', async () => {
    let failOpenAI = false;
    const handler: Handler = (url) => (failOpenAI && url.includes('openai') ? { status: 401 } : allOk(url));
    const { ctx } = makeCtx(SECRETS, handler, fs.mkdtempSync(path.join(os.tmpdir(), 'cm-home-')));
    const sent: string[] = [];
    const sender = async (t: string) => { sent.push(t); };
    const noon = new Date('2026-09-21T12:00:00Z');

    await runCredCheck(sender, ctx, noon);
    expect(sent).toHaveLength(0); // first run, all ok

    failOpenAI = true;
    await runCredCheck(sender, ctx, new Date('2026-09-21T12:30:00Z'));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('openai');
    expect(sent[0]).toContain('failing');

    await runCredCheck(sender, ctx, new Date('2026-09-21T13:00:00Z'));
    await runCredCheck(sender, ctx, new Date('2026-09-21T13:30:00Z'));
    expect(sent).toHaveLength(1); // no repeats

    failOpenAI = false;
    await runCredCheck(sender, ctx, new Date('2026-09-21T14:00:00Z'));
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('recovered');

    const row = getCredHealth().find((r) => r.name === 'openai')!;
    expect(row.status).toBe('ok');
    expect(row.last_ok_at).toBe(Math.floor(new Date('2026-09-21T14:00:00Z').getTime() / 1000));
    expect(row.last_change_at).toBe(row.last_ok_at);
  });

  it('first-ever observation of a failure alerts (prev unknown)', () => {
    const o = recordResults([{ name: 'gmail', status: 'fail', detail: 'http 400 invalid_grant' }]);
    expect(o.newlyFailing.map((r) => r.name)).toEqual(['gmail']);
    const again = recordResults([{ name: 'gmail', status: 'fail', detail: 'http 400 invalid_grant' }]);
    expect(again.newlyFailing).toHaveLength(0);
  });

  it('daily summary only when something is failing, once per day at the summary hour', async () => {
    const { ctx } = makeCtx({ ...SECRETS, CRED_MONITOR_SUMMARY_HOUR_UTC: '5' }, (url) => (url.includes('openai') ? { status: 401 } : allOk(url)), fs.mkdtempSync(path.join(os.tmpdir(), 'cm-home-')));
    const sent: string[] = [];
    const sender = async (t: string) => { sent.push(t); };
    await runCredCheck(sender, ctx, new Date('2026-09-21T04:30:00Z')); // transition alert
    expect(sent).toHaveLength(1);
    await runCredCheck(sender, ctx, new Date('2026-09-21T05:00:00Z')); // summary
    await runCredCheck(sender, ctx, new Date('2026-09-21T05:30:00Z')); // same day: none
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('1 failing');

    expect(formatDailySummary([{ name: 'x', status: 'ok', detail: '', checked_at: 1, last_ok_at: 1, last_change_at: 1, fail_streak: 0 }])).toBeNull();
  });

  it('snapshot counts failing rows (shape consumed by /api/cred-health and heartbeat.sh)', () => {
    recordResults([
      { name: 'a', status: 'ok', detail: 'http 200' },
      { name: 'b', status: 'fail', detail: 'http 401' },
      { name: 'c', status: 'skip', detail: 'not set' },
    ]);
    const snap = credHealthSnapshot();
    expect(snap.failing).toBe(1);
    expect(snap.checks.map((c) => c.name)).toEqual(['a', 'b', 'c']);
    expect(JSON.stringify(snap)).toMatch(/"failing":1/);
  });
});

describe('debounce (CRED_MONITOR_FAIL_THRESHOLD)', () => {
  const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cm-home-'));
  const at = (hhmm: string) => new Date(`2026-09-21T${hhmm}:00Z`);

  it('classifies auth-definitive failures', () => {
    expect(isAuthDefinitive({ status: 'fail', detail: 'http 401' })).toBe(true);
    expect(isAuthDefinitive({ status: 'fail', detail: 'http 403' })).toBe(true);
    expect(isAuthDefinitive({ status: 'fail', detail: 'http 400 invalid_grant' })).toBe(true);
    expect(isAuthDefinitive({ status: 'fail', detail: 'http 500' })).toBe(false);
    expect(isAuthDefinitive({ status: 'fail', detail: 'timeout' })).toBe(false);
    expect(isAuthDefinitive({ status: 'fail', detail: 'http 4010' })).toBe(false);
    expect(isAuthDefinitive({ status: 'ok', detail: 'http 401' })).toBe(false);
  });

  it('a single transient failure (timeout / 5xx) does not alert; the second consecutive one does', async () => {
    let mode: 'ok' | 'timeout' | '500' = 'ok';
    const { ctx } = makeCtx(SECRETS, (url) => {
      if (url.includes('openai')) {
        if (mode === 'timeout') { const e = new Error('t'); e.name = 'TimeoutError'; return e; }
        if (mode === '500') return { status: 500 };
      }
      return allOk(url);
    }, home());
    const sent: string[] = [];
    const sender = async (t: string) => { sent.push(t); };

    await runCredCheck(sender, ctx, at('12:00'));
    const okAt = getCredHealth().find((r) => r.name === 'openai')!.last_ok_at;

    mode = 'timeout';
    await runCredCheck(sender, ctx, at('12:30'));
    expect(sent).toHaveLength(0);
    const blip = getCredHealth().find((r) => r.name === 'openai')!;
    expect(blip.status).toBe('ok'); // unconfirmed: previous status kept
    expect(blip.detail).toBe('timeout (unconfirmed, 1/2)');
    expect(blip.fail_streak).toBe(1);
    expect(blip.last_ok_at).toBe(okAt); // a failed probe is not an ok observation

    mode = 'ok'; // blip cleared: streak resets, still no alert
    await runCredCheck(sender, ctx, at('13:00'));
    expect(sent).toHaveLength(0);
    expect(getCredHealth().find((r) => r.name === 'openai')!.fail_streak).toBe(0);

    mode = '500';
    await runCredCheck(sender, ctx, at('13:30'));
    expect(sent).toHaveLength(0);
    await runCredCheck(sender, ctx, at('14:00'));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('openai');
    expect(sent[0]).toContain('http 500');
    expect(getCredHealth().find((r) => r.name === 'openai')!.status).toBe('fail');

    await runCredCheck(sender, ctx, at('14:30'));
    expect(sent).toHaveLength(1); // stays failed: no repeat

    mode = 'ok'; // recovery alerts after one ok
    await runCredCheck(sender, ctx, at('15:00'));
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('recovered');
  });

  it('auth-definitive failures alert on the first observation', async () => {
    const { ctx } = makeCtx(SECRETS, (url) => (url.includes('openai') ? { status: 403 } : allOk(url)), home());
    const sent: string[] = [];
    await runCredCheck(async (t) => { sent.push(t); }, ctx, at('12:00'));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('http 403');
  });

  it('the streak survives a restart (it lives in cred_health, not memory)', () => {
    recordResults([{ name: 'jira', status: 'ok', detail: 'http 200' }], 100);
    expect(recordResults([{ name: 'jira', status: 'fail', detail: 'timeout' }], 200).newlyFailing).toHaveLength(0);
    _resetCredMonitorState(); // process restart
    expect(recordResults([{ name: 'jira', status: 'fail', detail: 'timeout' }], 300).newlyFailing.map((r) => r.name)).toEqual(['jira']);
  });

  it('first-ever unconfirmed failure is stored as skip, not fail', () => {
    const o = recordResults([{ name: 'voyage', status: 'fail', detail: 'http 502' }], 100);
    expect(o.newlyFailing).toHaveLength(0);
    expect(getCredHealth()[0]).toMatchObject({ name: 'voyage', status: 'skip', detail: 'http 502 (unconfirmed, 1/2)', last_ok_at: null });
  });

  it('CRED_MONITOR_FAIL_THRESHOLD is honoured', async () => {
    const { ctx } = makeCtx({ ...SECRETS, CRED_MONITOR_FAIL_THRESHOLD: '3' }, (url) => (url.includes('openai') ? { status: 503 } : allOk(url)), home());
    const sent: string[] = [];
    const sender = async (t: string) => { sent.push(t); };
    await runCredCheck(sender, ctx, at('12:00'));
    await runCredCheck(sender, ctx, at('12:30'));
    expect(sent).toHaveLength(0);
    await runCredCheck(sender, ctx, at('13:00'));
    expect(sent).toHaveLength(1);
  });

  it('daily summary marker is persisted: a restart in the summary hour does not resend it', async () => {
    const { ctx } = makeCtx({ ...SECRETS, CRED_MONITOR_SUMMARY_HOUR_UTC: '5' }, (url) => (url.includes('openai') ? { status: 401 } : allOk(url)), home());
    const sent: string[] = [];
    const sender = async (t: string) => { sent.push(t); };
    await runCredCheck(sender, ctx, at('04:30')); // transition alert
    await runCredCheck(sender, ctx, at('05:00')); // summary
    expect(sent).toHaveLength(2);
    expect(getDashboardSetting(SUMMARY_DAY_KEY)).toBe('2026-09-21');
    _resetCredMonitorState(); // process restart
    await runCredCheck(sender, ctx, at('05:30'));
    expect(sent).toHaveLength(2);
    await runCredCheck(sender, ctx, new Date('2026-09-22T05:00:00Z')); // next day
    expect(sent).toHaveLength(3);
  });
});

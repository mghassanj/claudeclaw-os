/**
 * Credential health monitor.
 *
 * Every CRED_MONITOR_INTERVAL_MIN (default 30) the main process probes each
 * configured credential with a short timeout and records ok | fail | skip in
 * the `cred_health` table. A Telegram alert is sent once on ok->fail and once
 * on fail->ok (never repeated while a probe stays failed), plus a daily
 * summary at CRED_MONITOR_SUMMARY_HOUR_UTC (default 5 = 08:00 Riyadh) only
 * when something is failing. The "summary sent on <day>" marker lives in the
 * DB so a restart inside the summary hour can't send it twice.
 *
 * Debounce: a probe only counts as failing after CRED_MONITOR_FAIL_THRESHOLD
 * (default 2) consecutive failed probes, so a single timeout / 5xx blip does
 * not page. Auth-definitive failures (HTTP 401/403, invalid_grant) are not
 * blips and alert on the first observation. One ok probe is a recovery.
 *
 * Probe details carry an HTTP status code or a provider error code such as
 * `invalid_grant` -- never a token, key, or response body.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import {
  getCredHealth,
  getCredHealthRow,
  getDashboardSetting,
  recordCredHealth,
  setDashboardSetting,
  type CredHealthRow,
} from './db.js';

export type ProbeStatus = 'ok' | 'fail' | 'skip';

export interface ProbeResult {
  name: string;
  status: ProbeStatus;
  detail: string;
}

export interface ProbeContext {
  env: (key: string) => string | undefined;
  envKeys: () => string[];
  fetch: typeof fetch;
  timeoutMs: number;
  homeDir: string;
}

type Sender = (text: string) => Promise<void>;

const DEFAULT_TIMEOUT_MS = 8_000;

// ── helpers ─────────────────────────────────────────────────────────────

function envFileKeys(): string[] {
  try {
    const content = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf-8');
    const keys: string[] = [];
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq > 0) keys.push(t.slice(0, eq).trim());
    }
    return keys;
  } catch {
    return [];
  }
}

export function defaultProbeContext(): ProbeContext {
  return {
    env: (k) => {
      const v = process.env[k];
      if (v) return v;
      return readEnvFile([k])[k] || undefined;
    },
    envKeys: () => Array.from(new Set([...Object.keys(process.env), ...envFileKeys()])),
    fetch: globalThis.fetch.bind(globalThis),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    homeDir: os.homedir(),
  };
}

function describeError(err: unknown): string {
  const e = err as { name?: string; code?: string; cause?: { code?: string } };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'timeout';
  const code = e?.cause?.code ?? e?.code;
  return code ? `network:${code}` : 'network error';
}

async function http(
  ctx: ProbeContext,
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; json: () => Promise<unknown>; text: () => Promise<string> } | { error: string }> {
  try {
    const res = await ctx.fetch(url, { ...init, signal: AbortSignal.timeout(ctx.timeoutMs) });
    return { status: res.status, json: () => res.json(), text: () => res.text() };
  } catch (err) {
    return { error: describeError(err) };
  }
}

/** Plain 2xx -> ok, anything else -> fail "http <code>". */
async function simple(name: string, ctx: ProbeContext, url: string, init?: RequestInit): Promise<ProbeResult> {
  const r = await http(ctx, url, init);
  if ('error' in r) return { name, status: 'fail', detail: r.error };
  return r.status >= 200 && r.status < 300
    ? { name, status: 'ok', detail: `http ${r.status}` }
    : { name, status: 'fail', detail: `http ${r.status}` };
}

const skip = (name: string, why: string): ProbeResult => ({ name, status: 'skip', detail: why });

// ── probes ──────────────────────────────────────────────────────────────

export async function probeTelegram(ctx: ProbeContext): Promise<ProbeResult[]> {
  const keys = ctx.envKeys()
    .filter((k) => k === 'TELEGRAM_BOT_TOKEN' || /^[A-Z0-9_]+_BOT_TOKEN$/.test(k))
    .filter((k) => !!ctx.env(k))
    .sort();
  if (keys.length === 0) return [skip('telegram', 'no *_BOT_TOKEN set')];
  return Promise.all(keys.map(async (k): Promise<ProbeResult> => {
    const name = `telegram:${k}`;
    const r = await http(ctx, `https://api.telegram.org/bot${ctx.env(k)}/getMe`);
    if ('error' in r) return { name, status: 'fail', detail: r.error };
    if (r.status !== 200) return { name, status: 'fail', detail: `http ${r.status}` };
    try {
      const body = (await r.json()) as { ok?: boolean };
      return body.ok ? { name, status: 'ok', detail: 'http 200' } : { name, status: 'fail', detail: 'ok:false' };
    } catch {
      return { name, status: 'fail', detail: 'bad json' };
    }
  }));
}

/** Claude OAuth: count_tokens is free (no generation billed). */
export async function probeClaude(ctx: ProbeContext): Promise<ProbeResult> {
  const tok = ctx.env('CLAUDE_CODE_OAUTH_TOKEN');
  if (!tok) return skip('claude-oauth', 'CLAUDE_CODE_OAUTH_TOKEN not set');
  return simple('claude-oauth', ctx, 'https://api.anthropic.com/v1/messages/count_tokens', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tok}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'ping' }] }),
  });
}

export async function probeJira(ctx: ProbeContext): Promise<ProbeResult> {
  const base = ctx.env('JIRA_BASE_URL');
  const email = ctx.env('JIRA_USER_EMAIL');
  const tok = ctx.env('JIRA_API_TOKEN');
  if (!base || !email || !tok) return skip('jira', 'JIRA_BASE_URL/JIRA_USER_EMAIL/JIRA_API_TOKEN not all set');
  return simple('jira', ctx, `${base.replace(/\/+$/, '')}/rest/api/3/myself`, {
    headers: {
      authorization: `Basic ${Buffer.from(`${email}:${tok}`).toString('base64')}`,
      accept: 'application/json',
    },
  });
}

export async function probeCodewiki(ctx: ProbeContext): Promise<ProbeResult> {
  const tok = ctx.env('JISR_CODEWIKI_TOKEN');
  if (!tok) return skip('codewiki', 'JISR_CODEWIKI_TOKEN not set');
  const url = ctx.env('CODEWIKI_MCP_URL') || 'https://codewiki.jisr.dev/api/mcp';
  return simple('codewiki', ctx, url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tok}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'claudeclaw-cred-monitor', version: '1' },
      },
    }),
  });
}

/** Railway workspace token: `me` is not allowed for workspace tokens. */
export async function probeRailway(ctx: ProbeContext): Promise<ProbeResult> {
  const tok = ctx.env('RAILWAY_API_TOKEN');
  if (!tok) return skip('railway', 'RAILWAY_API_TOKEN not set');
  const name = 'railway';
  const r = await http(ctx, 'https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query: '{ projects { edges { node { id } } } }' }),
  });
  if ('error' in r) return { name, status: 'fail', detail: r.error };
  if (r.status < 200 || r.status >= 300) return { name, status: 'fail', detail: `http ${r.status}` };
  try {
    const body = (await r.json()) as { errors?: unknown[]; data?: unknown };
    if (body.errors && body.errors.length) return { name, status: 'fail', detail: `http ${r.status} graphql errors` };
    return { name, status: 'ok', detail: `http ${r.status}` };
  } catch {
    return { name, status: 'fail', detail: 'bad json' };
  }
}

export async function probeOpenAI(ctx: ProbeContext): Promise<ProbeResult> {
  const tok = ctx.env('OPENAI_API_KEY');
  if (!tok) return skip('openai', 'OPENAI_API_KEY not set');
  return simple('openai', ctx, 'https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${tok}` } });
}

export async function probeGoogleApiKey(ctx: ProbeContext): Promise<ProbeResult> {
  const key = ctx.env('GOOGLE_API_KEY');
  if (!key) return skip('google-api-key', 'GOOGLE_API_KEY not set');
  // Key in a header, not the URL, so it can't end up in any request log.
  return simple('google-api-key', ctx, 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', {
    headers: { 'x-goog-api-key': key },
  });
}

/** One-word embedding: ~1 token, fractions of a cent per month at 48/day. */
export async function probeVoyage(ctx: ProbeContext): Promise<ProbeResult> {
  const key = ctx.env('VOYAGE_API_KEY');
  if (!key) return skip('voyage', 'VOYAGE_API_KEY not set');
  return simple('voyage', ctx, 'https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ input: ['ok'], model: ctx.env('VOYAGE_PROBE_MODEL') || 'voyage-3-large' }),
  });
}

export async function probeWhatsApp(ctx: ProbeContext): Promise<ProbeResult> {
  const enabled = (ctx.env('WHATSAPP_ENABLED') || '').toLowerCase();
  if (enabled !== 'true' && enabled !== '1') return skip('whatsapp', 'WHATSAPP_ENABLED not true');
  const port = ctx.env('WHATSAPP_QR_PORT') || '9334';
  const name = 'whatsapp';
  const r = await http(ctx, `http://127.0.0.1:${port}/health`);
  if ('error' in r) return { name, status: 'fail', detail: r.error };
  let text = '';
  try { text = await r.text(); } catch { /* empty */ }
  if (r.status === 200 && text.includes('READY')) return { name, status: 'ok', detail: 'READY' };
  let state = '';
  try { state = String((JSON.parse(text) as { state?: unknown }).state ?? ''); } catch { /* not json */ }
  return { name, status: 'fail', detail: `http ${r.status}${state ? ` state:${state.slice(0, 32)}` : ''}` };
}

/** Gmail: refresh-token grant against the stored OAuth token file. */
export async function probeGmail(ctx: ProbeContext): Promise<ProbeResult> {
  const file = ctx.env('GMAIL_TOKEN_PATH') || path.join(ctx.homeDir, '.config', 'gmail', 'token.json');
  const name = 'gmail';
  if (!fs.existsSync(file)) return skip(name, 'no token.json');
  let tok: { client_id?: string; client_secret?: string; refresh_token?: string; token_uri?: string };
  try {
    tok = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return { name, status: 'fail', detail: 'token.json unreadable' };
  }
  if (!tok.client_id || !tok.client_secret || !tok.refresh_token) {
    return { name, status: 'fail', detail: 'token.json missing client_id/client_secret/refresh_token' };
  }
  const r = await http(ctx, tok.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: tok.client_id,
      client_secret: tok.client_secret,
      refresh_token: tok.refresh_token,
    }).toString(),
  });
  if ('error' in r) return { name, status: 'fail', detail: r.error };
  if (r.status === 200) return { name, status: 'ok', detail: 'http 200' };
  let code = '';
  try { code = String((await r.json() as { error?: unknown }).error ?? ''); } catch { /* not json */ }
  // Google's `error` is a fixed code (invalid_grant, invalid_client, ...).
  const safe = /^[a-z_]{1,40}$/.test(code) ? code : '';
  return { name, status: 'fail', detail: `http ${r.status}${safe ? ` ${safe}` : ''}` };
}

export async function runAllProbes(ctx: ProbeContext = defaultProbeContext()): Promise<ProbeResult[]> {
  const guarded = async <T extends ProbeResult | ProbeResult[]>(label: string, p: () => Promise<T>): Promise<ProbeResult[]> => {
    try {
      const r = await p();
      return Array.isArray(r) ? r : [r];
    } catch (err) {
      return [{ name: label, status: 'fail', detail: `probe crashed: ${describeError(err)}` }];
    }
  };
  const groups = await Promise.all([
    guarded('telegram', () => probeTelegram(ctx)),
    guarded('claude-oauth', () => probeClaude(ctx)),
    guarded('jira', () => probeJira(ctx)),
    guarded('codewiki', () => probeCodewiki(ctx)),
    guarded('railway', () => probeRailway(ctx)),
    guarded('openai', () => probeOpenAI(ctx)),
    guarded('google-api-key', () => probeGoogleApiKey(ctx)),
    guarded('voyage', () => probeVoyage(ctx)),
    guarded('whatsapp', () => probeWhatsApp(ctx)),
    guarded('gmail', () => probeGmail(ctx)),
  ]);
  return groups.flat();
}

// ── recording + alerting ────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface CheckOutcome {
  results: ProbeResult[];
  newlyFailing: ProbeResult[];
  recovered: ProbeResult[];
}

export const DEFAULT_FAIL_THRESHOLD = 2;

/** Failures that a retry can't fix: the credential itself was rejected. */
export function isAuthDefinitive(r: Pick<ProbeResult, 'status' | 'detail'>): boolean {
  if (r.status !== 'fail') return false;
  return /^http (401|403)\b/.test(r.detail) || /\binvalid_grant\b/.test(r.detail);
}

export function failThreshold(env: ProbeContext['env']): number {
  const n = parseInt(env('CRED_MONITOR_FAIL_THRESHOLD') || '', 10);
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_FAIL_THRESHOLD;
}

/**
 * Record results and work out transitions. A raw failure is only stored (and
 * alerted) as 'fail' once `threshold` consecutive probes failed, or at once
 * when it is auth-definitive; until then the previous status is kept and the
 * detail is marked unconfirmed. Alert on ok/skip/unknown -> fail and on
 * fail -> ok. A probe that stays failed produces nothing.
 */
export function recordResults(
  results: ProbeResult[],
  nowSec = Math.floor(Date.now() / 1000),
  threshold = DEFAULT_FAIL_THRESHOLD,
): CheckOutcome {
  const newlyFailing: ProbeResult[] = [];
  const recovered: ProbeResult[] = [];
  for (const r of results) {
    const prevRow = getCredHealthRow(r.name);
    const streak = r.status === 'fail' ? (prevRow?.fail_streak ?? 0) + 1 : 0;
    let status = r.status;
    let detail = r.detail;
    if (r.status === 'fail' && prevRow?.status !== 'fail' && streak < threshold && !isAuthDefinitive(r)) {
      status = prevRow?.status ?? 'skip';
      detail = `${r.detail} (unconfirmed, ${streak}/${threshold})`;
    }
    const prev = recordCredHealth(r.name, status, detail, nowSec, streak, r.status);
    if (status === 'fail' && prev !== 'fail') newlyFailing.push(r);
    else if (status === 'ok' && prev === 'fail') recovered.push(r);
  }
  return { results, newlyFailing, recovered };
}

export function formatTransitionAlert(o: CheckOutcome): string | null {
  if (o.newlyFailing.length === 0 && o.recovered.length === 0) return null;
  const lines = ['<b>Credential health</b>'];
  for (const r of o.newlyFailing) lines.push(`❌ <b>${esc(r.name)}</b> failing: ${esc(r.detail)}`);
  for (const r of o.recovered) lines.push(`✅ <b>${esc(r.name)}</b> recovered`);
  return lines.join('\n');
}

export function formatDailySummary(rows: CredHealthRow[], nowSec = Math.floor(Date.now() / 1000)): string | null {
  const failing = rows.filter((r) => r.status === 'fail');
  if (failing.length === 0) return null;
  const lines = [`<b>Credential health: ${failing.length} failing</b>`];
  for (const r of failing) {
    const days = Math.floor((nowSec - r.last_change_at) / 86400);
    lines.push(`• <b>${esc(r.name)}</b>: ${esc(r.detail)} (failing ${days > 0 ? `${days}d` : '&lt;1d'})`);
  }
  return lines.join('\n');
}

export function credHealthSnapshot(): { failing: number; checks: CredHealthRow[] } {
  const checks = getCredHealth();
  return { failing: checks.filter((c) => c.status === 'fail').length, checks };
}

let running = false;

/** dashboard_settings key holding the UTC day the last daily summary went out. */
export const SUMMARY_DAY_KEY = 'cred_monitor_summary_day';

export async function runCredCheck(sender: Sender, ctx: ProbeContext = defaultProbeContext(), now = new Date()): Promise<CheckOutcome | null> {
  if (running) return null;
  running = true;
  try {
    const results = await runAllProbes(ctx);
    const outcome = recordResults(results, Math.floor(now.getTime() / 1000), failThreshold(ctx.env));
    logger.info(
      { ok: results.filter((r) => r.status === 'ok').length, fail: results.filter((r) => r.status === 'fail').map((r) => r.name), skip: results.filter((r) => r.status === 'skip').length },
      'Credential health check',
    );
    const alert = formatTransitionAlert(outcome);
    if (alert) await sender(alert).catch((err) => logger.error({ err }, 'cred alert send failed'));

    const summaryHour = parseInt(ctx.env('CRED_MONITOR_SUMMARY_HOUR_UTC') || '5', 10);
    const day = now.toISOString().slice(0, 10);
    if (now.getUTCHours() === summaryHour && getDashboardSetting(SUMMARY_DAY_KEY) !== day) {
      // Mark before sending: a failed send is logged, not retried every tick.
      setDashboardSetting(SUMMARY_DAY_KEY, day);
      const summary = formatDailySummary(getCredHealth(), Math.floor(now.getTime() / 1000));
      if (summary) await sender(summary).catch((err) => logger.error({ err }, 'cred summary send failed'));
    }
    return outcome;
  } catch (err) {
    logger.error({ err }, 'Credential health check failed');
    return null;
  } finally {
    running = false;
  }
}

/** @internal tests only */
export function _resetCredMonitorState(): void {
  running = false;
}

/**
 * Start the periodic monitor in the main process. Disabled with
 * CRED_MONITOR_ENABLED=false; interval via CRED_MONITOR_INTERVAL_MIN.
 */
export function initCredMonitor(sender: Sender): void {
  const ctx = defaultProbeContext();
  if ((ctx.env('CRED_MONITOR_ENABLED') || '').toLowerCase() === 'false') {
    logger.info('Credential monitor disabled (CRED_MONITOR_ENABLED=false)');
    return;
  }
  const minutes = parseInt(ctx.env('CRED_MONITOR_INTERVAL_MIN') || '30', 10);
  const intervalMs = (Number.isFinite(minutes) && minutes >= 5 ? minutes : 30) * 60_000;
  setTimeout(() => void runCredCheck(sender), 60_000);
  setInterval(() => void runCredCheck(sender), intervalMs);
  logger.info({ intervalMin: intervalMs / 60_000 }, 'Credential monitor initialized');
}

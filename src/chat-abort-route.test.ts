import { beforeEach, describe, expect, it, vi } from 'vitest';

// Before config.ts is imported: the abort fallback targets the main chat.
vi.hoisted(() => { process.env.ALLOWED_CHAT_ID = '4242'; });

import { _initTestDatabase } from './db.js';
import { buildDashboardApp } from './dashboard.js';
import { setActiveAbort, setProcessing } from './state.js';

const TOKEN = process.env.DASHBOARD_TOKEN!; // set by test-env-setup.ts
const abort = (app: ReturnType<typeof buildDashboardApp>) =>
  app.request('/api/chat/abort', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } });

beforeEach(() => {
  _initTestDatabase();
  setProcessing('4242', false);
  setActiveAbort('4242', null);
});

describe('POST /api/chat/abort', () => {
  it('aborts the processing chat', async () => {
    const ctrl = new AbortController();
    setActiveAbort('4242', ctrl);
    setProcessing('4242', true);
    const res = await abort(buildDashboardApp());
    expect(await res.json()).toEqual({ ok: true });
    expect(ctrl.signal.aborted).toBe(true);
  });

  it('falls back to the main chat when a turn is registered without the processing flag', async () => {
    const ctrl = new AbortController();
    setActiveAbort('4242', ctrl); // e.g. a bridged main-turn
    const res = await abort(buildDashboardApp());
    expect(await res.json()).toEqual({ ok: true });
    expect(ctrl.signal.aborted).toBe(true);
  });

  it('reports not_processing when nothing is running', async () => {
    const res = await abort(buildDashboardApp());
    expect(await res.json()).toEqual({ ok: false, reason: 'not_processing' });
  });
});

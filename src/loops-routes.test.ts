import { beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase } from './db.js';
import { buildDashboardApp } from './dashboard.js';
import { createLoop, getLoop } from './open-loops.js';
import { _setLoopRuntimeForTests } from './open-loops-runtime.js';

const TOKEN = process.env.DASHBOARD_TOKEN!; // set by test-env-setup.ts
const now = () => Math.floor(Date.now() / 1000);

let runner: ReturnType<typeof vi.fn>;

beforeEach(() => {
  _initTestDatabase();
  runner = vi.fn(async () => 'ok');
  _setLoopRuntimeForTests({ runner, telegram: vi.fn(async () => {}), whatsapp: vi.fn(async () => {}) });
});

describe('/api/loops routes', () => {
  it('require the dashboard token; accept it as a Bearer header', async () => {
    const app = buildDashboardApp();
    expect((await app.request('/api/loops/watch')).status).toBe(401);
    expect((await app.request('/api/loops/watch', { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
    const ok = await app.request('/api/loops/watch', { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ loops: [] });
    // Browsers keep using ?token=.
    expect((await app.request(`/api/loops?token=${TOKEN}`)).status).toBe(200);
  });

  it('POST /api/loops/inbound fires a waiting loop', async () => {
    const l = createLoop({ kind: 'await_reply', summary: 'Nora reply', chat_ref: '966500000001@c.us' });
    const app = buildDashboardApp();
    const res = await app.request('/api/loops/inbound', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: '966500000001@c.us', isGroup: false, senderIds: [], text: 'yes', messageId: 'm1', timestamp: now() + 1 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fired: [l.id] });
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
    expect(getLoop(l.id)?.status).toBe('fired');

    const bad = await app.request('/api/loops/inbound', {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(bad.status).toBe(400);
  });
});

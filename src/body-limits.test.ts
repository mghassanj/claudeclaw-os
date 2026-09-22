import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase } from './db.js';
import { buildDashboardApp } from './dashboard.js';
import {
  bodyLimitFor,
  DEFAULT_API_MAX_BYTES,
  MAIN_TURN_MAX_BYTES,
} from './body-limits.js';

const TOKEN = process.env.DASHBOARD_TOKEN!; // set by test-env-setup.ts
const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

/** A JSON body of roughly `bytes` bytes. */
const jsonOfSize = (bytes: number) => JSON.stringify({ text: '', pad: 'x'.repeat(bytes) });

/** Same body, streamed without Content-Length (chunked). */
function chunked(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const CHUNK = 256 * 1024;
  let off = 0;
  return new ReadableStream({
    pull(ctrl) {
      if (off >= bytes.length) { ctrl.close(); return; }
      ctrl.enqueue(bytes.slice(off, off + CHUNK));
      off += CHUNK;
    },
  });
}

beforeEach(() => _initTestDatabase());

describe('bodyLimitFor', () => {
  it('maps paths to limits', () => {
    expect(bodyLimitFor('/api/agent/main-turn')).toBe(25 * 1024 * 1024);
    expect(bodyLimitFor('/api/agents/research/avatar')).toBe(6 * 1024 * 1024);
    expect(bodyLimitFor('/warroom-music-upload')).toBe(21 * 1024 * 1024);
    expect(bodyLimitFor('/api/loops/inbound')).toBe(1024 * 1024);
    expect(bodyLimitFor('/api/agents/research/avatar/x')).toBe(1024 * 1024);
    expect(bodyLimitFor('/mission')).toBeNull();
  });
});

describe('dashboard body limits', () => {
  it('main-turn: a 2 MB body is accepted (reaches the handler), > 25 MB is 413 JSON', async () => {
    const app = buildDashboardApp();
    const ok = await app.request('/api/agent/main-turn', { method: 'POST', headers: auth, body: jsonOfSize(2 * 1024 * 1024) });
    expect(ok.status).toBe(400); // handler ran: no text / image
    expect(await ok.json()).toEqual({ error: 'text required' });

    const bigBody = jsonOfSize(MAIN_TURN_MAX_BYTES + 10);
    const big = await app.request('/api/agent/main-turn', {
      method: 'POST', headers: { ...auth, 'Content-Length': String(Buffer.byteLength(bigBody)) }, body: bigBody,
    });
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: 'payload too large', maxBytes: MAIN_TURN_MAX_BYTES });
  });

  it('main-turn: an oversized chunked body (no Content-Length) is also 413', async () => {
    const app = buildDashboardApp();
    const res = await app.request('/api/agent/main-turn', {
      method: 'POST',
      headers: auth,
      body: chunked(jsonOfSize(MAIN_TURN_MAX_BYTES + 10)),
      duplex: 'half', // Node's fetch needs this for a stream body
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe('payload too large');
  });

  it('a chunked body under the limit reaches the handler intact', async () => {
    const app = buildDashboardApp();
    const res = await app.request('/api/loops/inbound', {
      method: 'POST',
      headers: auth,
      body: chunked(JSON.stringify({ chatId: 'nobody@c.us', text: 'x'.repeat(600 * 1024) })),
      duplex: 'half', // Node's fetch needs this for a stream body
    } as RequestInit);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fired: [] });
  });

  it('other /api JSON routes cap at 1 MB (chunked: the handler swallows parse errors, still 413)', async () => {
    const app = buildDashboardApp();
    const res = await app.request('/api/loops/inbound', { method: 'POST', headers: auth, body: jsonOfSize(DEFAULT_API_MAX_BYTES + 10) });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload too large', maxBytes: DEFAULT_API_MAX_BYTES });

    const small = await app.request('/api/loops/inbound', { method: 'POST', headers: auth, body: '{}' });
    expect(small.status).toBe(400); // handler ran
  });

  it('auth still comes first: no token -> 401, not 413', async () => {
    const app = buildDashboardApp();
    const res = await app.request('/api/agent/main-turn', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: jsonOfSize(MAIN_TURN_MAX_BYTES + 10),
    });
    expect(res.status).toBe(401);
  });

  it('/warroom-music-upload requires the dashboard token', async () => {
    const app = buildDashboardApp();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array([0x49, 0x44, 0x33])]), 'x.mp3');
    expect((await app.request('/warroom-music-upload', { method: 'POST', body: form })).status).toBe(401);
    const tooBig = await app.request(`/warroom-music-upload?token=${TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=x', 'Content-Length': String(22 * 1024 * 1024) },
      body: 'x',
    });
    expect(tooBig.status).toBe(413);
  });
});

import { describe, it, expect } from 'vitest';

import { requestToken } from './dashboard.js';

const ctx = (headers: Record<string, string>, query: Record<string, string>) => ({
  req: {
    header: (n: string) => headers[n.toLowerCase()],
    query: (n: string) => query[n],
  },
});

describe('dashboard requestToken', () => {
  it('prefers the Authorization bearer header', () => {
    expect(requestToken(ctx({ authorization: 'Bearer hdr' }, { token: 'qs' }))).toBe('hdr');
    expect(requestToken(ctx({ authorization: 'bearer  hdr ' }, {}))).toBe('hdr');
  });
  it('falls back to the legacy ?token= query parameter', () => {
    expect(requestToken(ctx({}, { token: 'qs' }))).toBe('qs');
    expect(requestToken(ctx({ authorization: 'Basic abc' }, { token: 'qs' }))).toBe('qs');
    expect(requestToken(ctx({}, {}))).toBeUndefined();
  });
});

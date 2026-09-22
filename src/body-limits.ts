/**
 * Request body size limits for the dashboard server (Hono's bodyLimit).
 *
 * Without a cap, c.req.json() / parseBody() buffer whatever a caller sends,
 * so one oversized POST (e.g. a huge base64 image to /api/agent/main-turn)
 * can pin the main process's memory. Limits are per path:
 *
 *   POST /api/agent/main-turn     25 MB  (base64 image from the WhatsApp bridge)
 *   PUT  /api/agents/:id/avatar    6 MB  (handler caps the image at 5 MB)
 *   POST /warroom-music-upload    21 MB  (handler caps the MP3 at 20 MB)
 *   any other /api/* body          1 MB
 *
 * Over the limit -> 413 {"error":"payload too large","maxBytes":N}, before
 * the handler runs. A request with Content-Length is judged by the header
 * (Hono's bodyLimit); a chunked body is read here through bodyLimit's capped
 * stream (at most the limit is buffered) and handed on as a buffered Request,
 * so handlers that swallow JSON parse errors can't turn the 413 into a 400.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';

const MB = 1024 * 1024;

export const MAIN_TURN_MAX_BYTES = 25 * MB;
export const AVATAR_MAX_BYTES = 6 * MB;
export const MUSIC_UPLOAD_MAX_BYTES = 21 * MB;
export const DEFAULT_API_MAX_BYTES = 1 * MB;

/** Byte limit for a request path, or null when the path is not limited here. */
export function bodyLimitFor(pathname: string): number | null {
  if (pathname === '/api/agent/main-turn') return MAIN_TURN_MAX_BYTES;
  if (/^\/api\/agents\/[^/]+\/avatar$/.test(pathname)) return AVATAR_MAX_BYTES;
  if (pathname === '/warroom-music-upload') return MUSIC_UPLOAD_MAX_BYTES;
  if (pathname.startsWith('/api/')) return DEFAULT_API_MAX_BYTES;
  return null;
}

export function payloadTooLarge(c: Context, maxBytes?: number): Response {
  return c.json(maxBytes ? { error: 'payload too large', maxBytes } : { error: 'payload too large' }, 413);
}

/** hono/body-limit's error class isn't exported; match it by name. */
export function isBodyLimitError(err: unknown): boolean {
  return err instanceof Error && err.name === 'BodyLimitError';
}

/** One middleware for the whole app, dispatching to a bodyLimit per size. */
export function requestBodyLimits(): MiddlewareHandler {
  const bySize = new Map<number, MiddlewareHandler>();
  return async (c, next) => {
    const max = bodyLimitFor(new URL(c.req.url).pathname);
    if (max === null) return next();
    let mw = bySize.get(max);
    if (!mw) {
      mw = bodyLimit({ maxSize: max, onError: (ctx) => payloadTooLarge(ctx, max) });
      bySize.set(max, mw);
    }
    return mw(c, async () => {
      const raw = c.req.raw;
      const chunked = raw.body && (!raw.headers.has('content-length') || raw.headers.has('transfer-encoding'));
      if (chunked) {
        let buf: ArrayBuffer;
        try {
          buf = await raw.arrayBuffer();
        } catch (err) {
          if (isBodyLimitError(err)) {
            c.res = payloadTooLarge(c, max);
            return;
          }
          throw err;
        }
        const headers = new Headers(raw.headers);
        headers.delete('transfer-encoding');
        c.req.raw = new Request(raw.url, { method: raw.method, headers, body: buf });
      }
      await next();
    });
  };
}

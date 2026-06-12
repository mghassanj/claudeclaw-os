import { useEffect, useState, useRef } from 'preact/hooks';
import { apiGet, ApiError } from './api';

export interface FetchState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

// Module-level stale-while-revalidate cache, keyed by path. Pages that
// hit the same endpoint (e.g. /api/agents from MissionControl and the
// Agents page) share a cached payload, so navigating between them paints
// instantly and only revalidates in the background. Lives for the tab
// session — a hard refresh starts cold.
const _cache = new Map<string, unknown>();

const FETCH_INVALIDATED_EVENT = 'claudeclaw:fetch-invalidated';

export function invalidateFetchCache(prefix?: string): void {
  for (const key of Array.from(_cache.keys())) {
    if (!prefix || key.startsWith(prefix)) _cache.delete(key);
  }
  window.dispatchEvent(new CustomEvent(FETCH_INVALIDATED_EVENT, { detail: { prefix } }));
}

/**
 * Tiny GET-with-polling hook. Re-fetches on `path` change and on a fixed
 * interval if `pollMs` is given. Aborts in-flight requests on unmount /
 * deps change. Hydrates from a process-local cache to avoid the first-
 * paint loading flash on repeat visits.
 */
export function useFetch<T = unknown>(path: string | null, pollMs = 0): FetchState<T> {
  const cached = path !== null ? (_cache.get(path) as T | undefined) : undefined;
  const [data, setData] = useState<T | null>(cached ?? null);
  // Only show loading on a true cold start. If we have cached data the
  // page can render immediately and the revalidate is invisible.
  const [loading, setLoading] = useState<boolean>(path !== null && cached === undefined);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const lastPath = useRef(path);

  useEffect(() => {
    if (path === null) return;
    let cancelled = false;
    const hadCache = _cache.has(path);
    if (!hadCache) setLoading(true);
    apiGet<T>(path).then((d) => {
      if (cancelled) return;
      _cache.set(path, d);
      setData(d);
      setError(null);
    }).catch((e) => {
      if (cancelled) return;
      setError(e instanceof ApiError ? e.message : String(e));
    }).finally(() => {
      if (cancelled) return;
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [path, tick]);

  // Poll separately so the refresh tick is decoupled from path changes.
  useEffect(() => {
    if (!pollMs) return;
    const id = setInterval(() => setTick((t) => t + 1), pollMs);
    return () => clearInterval(id);
  }, [pollMs]);

  useEffect(() => {
    if (path === null) return;
    function onInvalidated(event: Event) {
      const prefix = (event as CustomEvent<{ prefix?: string }>).detail?.prefix;
      if (!prefix || path.startsWith(prefix)) {
        setTick((t) => t + 1);
      }
    }
    window.addEventListener(FETCH_INVALIDATED_EVENT, onInvalidated);
    return () => window.removeEventListener(FETCH_INVALIDATED_EVENT, onInvalidated);
  }, [path]);

  // When the path changes, swap to the new cached value (or null) so we
  // never show stale data from a different endpoint.
  if (lastPath.current !== path) {
    lastPath.current = path;
    if (path === null) {
      setData(null);
      setLoading(false);
      setError(null);
    } else {
      const next = _cache.get(path) as T | undefined;
      setData(next ?? null);
      setLoading(next === undefined);
    }
  }

  return { data, loading, error, refresh: () => setTick((t) => t + 1) };
}

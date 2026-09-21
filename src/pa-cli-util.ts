/** Small argv helpers shared by loops-cli and contacts-cli. */

export interface ParsedArgs {
  positional: string[];
  flags: Map<string, string[]>;
}

/** Flags that never take a value. */
const BOOLEAN_FLAGS = new Set(['all', 'pin', 'unpin', 'force']);

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = (eq > 0 ? a.slice(2, eq) : a.slice(2)).toLowerCase();
      let val: string;
      if (eq > 0) val = a.slice(eq + 1);
      else if (BOOLEAN_FLAGS.has(key) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) val = 'true';
      else val = argv[++i];
      flags.set(key, [...(flags.get(key) ?? []), val]);
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

export function flag(p: ParsedArgs, name: string): string | undefined {
  const v = p.flags.get(name);
  return v ? v[v.length - 1] : undefined;
}

export function flagAll(p: ParsedArgs, name: string): string[] {
  return p.flags.get(name) ?? [];
}

/**
 * Parse a time: relative ("30m", "2h", "3d", "1w", "+2h") or anything
 * Date.parse accepts (use an explicit offset, e.g. 2026-09-22T09:00+03:00;
 * the host runs in UTC). Returns unix seconds, or null if unparseable.
 */
export function parseWhen(input: string, now = Date.now()): number | null {
  const s = input.trim();
  const rel = /^\+?(\d+(?:\.\d+)?)\s*(m|min|mins|h|hr|hrs|d|day|days|w|wk|weeks?)$/i.exec(s);
  if (rel) {
    const n = parseFloat(rel[1]);
    const u = rel[2].toLowerCase()[0];
    const mult = u === 'm' ? 60 : u === 'h' ? 3600 : u === 'd' ? 86400 : 7 * 86400;
    return Math.floor(now / 1000 + n * mult);
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

export function fmtTime(unix: number | null): string {
  if (!unix) return '-';
  return new Date(unix * 1000).toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

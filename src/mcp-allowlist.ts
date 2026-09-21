/**
 * Per-agent MCP allowlist + `${VAR}` expansion helpers.
 *
 * Deliberately dependency-free so both the text bot (agent-config.ts /
 * agent.ts) and the lightweight voice-bridge subprocess can share it.
 */

function stringList(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean);
}

/**
 * Derive the MCP server allowlist from a parsed agent.yaml object.
 *
 *   - `mcp_servers: [name, ...]` wins when present (explicit list).
 *   - otherwise `warroom_tools:` entries prefixed `mcp:` are used
 *     (`mcp:jisr-backend-codewiki` -> `jisr-backend-codewiki`). A
 *     `warroom_tools:` list with no `mcp:` entries yields `[]`, i.e.
 *     the agent gets NO MCP servers (least privilege).
 *   - neither key -> `undefined` (legacy behaviour: every server).
 */
export function mcpAllowlistFromYaml(raw: Record<string, unknown> | null | undefined): string[] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const explicit = stringList(raw['mcp_servers']);
  if (explicit) return Array.from(new Set(explicit));
  const warroom = stringList(raw['warroom_tools']);
  if (warroom) {
    return Array.from(new Set(
      warroom
        .filter((t) => t.startsWith('mcp:'))
        .map((t) => t.slice('mcp:'.length).trim())
        .filter(Boolean),
    ));
  }
  return undefined;
}

const ENV_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** Names of every `${VAR}` / `${VAR:-default}` / `$VAR` reference in `value`. */
export function envRefNames(value: string): string[] {
  const names: string[] = [];
  for (const m of value.matchAll(ENV_REF_RE)) names.push(m[1] ?? m[3]);
  return names;
}

/**
 * Replace `${VAR}`, `${VAR:-default}` and `$VAR` with values from `lookup`.
 * A missing variable (no value, no default) becomes '' and its NAME is
 * passed to `onMissing` — the value is never logged.
 */
export function expandEnvRefs(
  value: string,
  lookup: (name: string) => string | undefined,
  onMissing?: (name: string) => void,
): string {
  return value.replace(ENV_REF_RE, (_m, braced: string | undefined, def: string | undefined, bare: string | undefined) => {
    const name = (braced ?? bare) as string;
    const v = lookup(name);
    if (v !== undefined && v !== '') return v;
    if (def !== undefined) return def;
    onMissing?.(name);
    return '';
  });
}

/** Expand env refs in every string of a string[] / Record<string,string>. */
export function expandEnvInList(list: string[], lookup: (n: string) => string | undefined, onMissing?: (n: string) => void): string[] {
  return list.map((s) => (typeof s === 'string' ? expandEnvRefs(s, lookup, onMissing) : s));
}

export function expandEnvInRecord(
  rec: Record<string, string>,
  lookup: (n: string) => string | undefined,
  onMissing?: (n: string) => void,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    out[k] = typeof v === 'string' ? expandEnvRefs(v, lookup, onMissing) : v;
  }
  return out;
}

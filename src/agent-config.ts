import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

import { CLAUDECLAW_CONFIG, PROJECT_ROOT, STORE_DIR } from './config.js';
import { readEnvFile } from './env.js';
import {
  ProviderConfig,
  readProviderFromYaml,
  writeProviderToYaml,
} from './provider.js';

export const DEFAULT_MAIN_DESCRIPTION = 'Primary ClaudeClaw bot';

/** Capitalize first letter of a string. Used as fallback display name. */
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Resolve display name for an agent. Reads from agent.yaml `name` field,
 * falls back to capitalized id (e.g. "main" -> "Main"). Never throws.
 */
export function resolveAgentDisplayName(agentId: string): string {
  try {
    const cfg = loadAgentConfig(agentId);
    return cfg.name || capitalize(agentId);
  } catch {
    return capitalize(agentId);
  }
}

function mainConfigPath(): string {
  return path.join(STORE_DIR, 'main-config.json');
}

// Shared roster path. Written by Node on startup and any time the agent
// roster changes (new agent, deleted agent). Read by the Python Pipecat
// voice stack so new agents propagate into voice War Room without a
// full bot restart.
export const WARROOM_ROSTER_PATH = '/tmp/warroom-agents.json';

/** Single source of truth for "is this string a syntactically valid
 *  agent id?". Lifted out of the various inline copies in the dashboard
 *  HTTP layer so the avatar / chat / agent-files handlers all share one
 *  definition. Lower-case alphanumerics plus `_` and `-`; `i` flag is
 *  kept for backwards compatibility with the historical regex. */
export const AGENT_ID_RE = /^[a-z0-9_-]+$/i;

/** Cheap "does this agent exist on disk?" check. `main` always exists
 *  (it's the root process); any other id needs an `agent.yaml` next to
 *  resolveAgentDir(id). Returns false for syntactically invalid ids so
 *  callers can use this as the only existence check they need. */
export function agentExists(agentId: string): boolean {
  if (!AGENT_ID_RE.test(agentId)) return false;
  if (agentId === 'main') return true;
  try {
    const dir = resolveAgentDir(agentId);
    return fs.existsSync(path.join(dir, 'agent.yaml'));
  } catch {
    return false;
  }
}

export interface AgentConfig {
  name: string;
  description: string;
  botTokenEnv: string;
  botToken: string;
  model?: string;
  provider: ProviderConfig;
  mcpServers?: string[];
  /** Per-agent war-room tool allowlist. Tokens are SDK tool names
   *  ("Bash", "Write") or "mcp:<name>" entries to opt an MCP server in.
   *  Overrides the defaults in warroom-tool-policy.ts. Unset = use
   *  defaults. */
  warroomTools?: string[];
  obsidian?: {
    vault: string;
    folders: string[];
    readOnly?: string[];
  };
  /** Pika voice id used when this agent joins a video meeting. Falls back
   *  to the Pika preset English_radiant_girl if unset. */
  meetVoiceId?: string;
  /** Display name shown in the meeting ("Your Agent wants to join"). Falls
   *  back to the agent's name or id with first letter capitalized. */
  meetBotName?: string;
}

/**
 * Resolve the directory for a given agent, checking CLAUDECLAW_CONFIG first,
 * then falling back to PROJECT_ROOT/agents/<id>.
 */
export function resolveAgentDir(agentId: string): string {
  const externalDir = path.join(CLAUDECLAW_CONFIG, 'agents', agentId);
  if (fs.existsSync(path.join(externalDir, 'agent.yaml'))) {
    return externalDir;
  }
  return path.join(PROJECT_ROOT, 'agents', agentId);
}

export function resolveInstructionMd(dir: string): string | null {
  const claudePath = path.join(dir, 'CLAUDE.md');
  if (fs.existsSync(claudePath)) return claudePath;
  const agentsPath = path.join(dir, 'AGENTS.md');
  if (fs.existsSync(agentsPath)) return agentsPath;
  return null;
}

export function ensureAgentsMdSymlink(dir: string): boolean {
  const claudePath = path.join(dir, 'CLAUDE.md');
  const agentsPath = path.join(dir, 'AGENTS.md');
  if (!fs.existsSync(claudePath) || fs.existsSync(agentsPath)) return false;

  try {
    fs.symlinkSync('CLAUDE.md', agentsPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the instruction file path for a given agent, checking CLAUDECLAW_CONFIG
 * first, then falling back to PROJECT_ROOT/agents/<id>. CLAUDE.md remains the
 * canonical file for ClaudeClaw, while AGENTS.md is accepted for Codex-style
 * instruction loaders or symlinked setups.
 */
export function resolveAgentClaudeMd(agentId: string): string | null {
  return resolveInstructionMd(path.join(CLAUDECLAW_CONFIG, 'agents', agentId))
    ?? resolveInstructionMd(path.join(PROJECT_ROOT, 'agents', agentId));
}

export function loadAgentConfig(agentId: string): AgentConfig {
  const agentDir = resolveAgentDir(agentId);
  const configPath = path.join(agentDir, 'agent.yaml');

  if (!fs.existsSync(configPath)) {
    throw new Error(`Agent config not found: ${configPath}`);
  }

  const raw = yaml.load(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;

  const name = raw['name'] as string;
  const description = (raw['description'] as string) ?? '';
  const botTokenEnv = (raw['telegram_bot_token_env'] as string) || (agentId === 'main' ? 'TELEGRAM_BOT_TOKEN' : '');
  const model = raw['model'] as string | undefined;
  const provider = readProviderFromYaml(raw);

  if (!name) {
    throw new Error(`Agent config ${configPath} must have 'name'`);
  }
  if (!botTokenEnv && agentId !== 'main') {
    throw new Error(`Agent config ${configPath} must have 'telegram_bot_token_env'`);
  }

  let botToken = '';
  if (botTokenEnv) {
    const env = readEnvFile([botTokenEnv]);
    botToken = process.env[botTokenEnv] || env[botTokenEnv] || '';
    if (!botToken && agentId !== 'main') {
      throw new Error(`Bot token not found: set ${botTokenEnv} in .env`);
    }
  }

  let obsidian: AgentConfig['obsidian'];
  const obsRaw = raw['obsidian'] as Record<string, unknown> | undefined;
  if (obsRaw) {
    const vault = obsRaw['vault'] as string;
    if (vault && !fs.existsSync(vault)) {
      // eslint-disable-next-line no-console
      console.warn(`[${agentId}] WARNING: Obsidian vault path does not exist: ${vault}`);
      console.warn(`[${agentId}] Update obsidian.vault in agent.yaml to your local vault path.`);
    }
    obsidian = {
      vault,
      folders: (obsRaw['folders'] as string[]) ?? [],
      readOnly: (obsRaw['read_only'] as string[]) ?? [],
    };
  }

  const mcpServers = raw['mcp_servers'] as string[] | undefined;
  // War-room tool policy override. If present in agent.yaml, this list
  // overrides the per-agent default in warroom-tool-policy.ts. Tokens
  // can be SDK tool names ("Bash", "Write") or "mcp:<name>" to opt that
  // MCP server into the war-room session.
  const warroomTools = raw['warroom_tools'] as string[] | undefined;
  const meetVoiceId = typeof raw['meet_voice_id'] === 'string' ? (raw['meet_voice_id'] as string) : undefined;
  const meetBotName = typeof raw['meet_bot_name'] === 'string' ? (raw['meet_bot_name'] as string) : undefined;

  return {
    name,
    description,
    botTokenEnv,
    botToken,
    model,
    provider,
    mcpServers,
    warroomTools,
    obsidian,
    meetVoiceId,
    meetBotName,
  };
}

/** Update the model field in an agent's agent.yaml file. */
export function setAgentModel(agentId: string, model: string): void {
  const agentDir = resolveAgentDir(agentId);
  const configPath = path.join(agentDir, 'agent.yaml');
  if (!fs.existsSync(configPath)) throw new Error(`Agent config not found: ${configPath}`);

  const raw = yaml.load(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  raw['model'] = model;
  fs.writeFileSync(configPath, yaml.dump(raw, { lineWidth: -1 }), 'utf-8');
}

/** Update the provider field in an agent's agent.yaml file. */
export function setAgentProvider(agentId: string, provider: ProviderConfig): void {
  const agentDir = resolveAgentDir(agentId);
  const configPath = path.join(agentDir, 'agent.yaml');
  if (!fs.existsSync(configPath)) throw new Error(`Agent config not found: ${configPath}`);

  const raw = yaml.load(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  writeProviderToYaml(raw, provider);
  fs.writeFileSync(configPath, yaml.dump(raw, { lineWidth: -1 }), 'utf-8');
}

/** Update the description field in an agent's agent.yaml file. */
export function setAgentDescription(agentId: string, description: string): void {
  const trimmed = description.trim();
  if (!trimmed) throw new Error('description cannot be empty');

  const agentDir = resolveAgentDir(agentId);
  const configPath = path.join(agentDir, 'agent.yaml');
  if (!fs.existsSync(configPath)) throw new Error(`Agent config not found: ${configPath}`);

  const raw = yaml.load(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  raw['description'] = trimmed;
  fs.writeFileSync(configPath, yaml.dump(raw, { lineWidth: -1 }), 'utf-8');
}

/** Load the description for the main bot (persisted, editable). */
export function getMainDescription(): string {
  const configPath = mainConfigPath();
  try {
    if (!fs.existsSync(configPath)) return DEFAULT_MAIN_DESCRIPTION;
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { description?: string };
    const desc = (raw.description ?? '').trim();
    return desc || DEFAULT_MAIN_DESCRIPTION;
  } catch {
    return DEFAULT_MAIN_DESCRIPTION;
  }
}

/** Persist a description for the main bot. */
export function setMainDescription(description: string): void {
  const trimmed = description.trim();
  if (!trimmed) throw new Error('description cannot be empty');

  if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });

  const configPath = mainConfigPath();
  let raw: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try { raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>; } catch { raw = {}; }
  }
  raw['description'] = trimmed;
  fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
}
/** List all configured agent IDs (directories under agents/ with agent.yaml).
 *  Scans both CLAUDECLAW_CONFIG/agents/ and PROJECT_ROOT/agents/, deduplicating.
 */
export function listAgentIds(): string[] {
  const ids = new Set<string>();

  for (const baseDir of [
    path.join(CLAUDECLAW_CONFIG, 'agents'),
    path.join(PROJECT_ROOT, 'agents'),
  ]) {
    if (!fs.existsSync(baseDir)) continue;
    for (const d of fs.readdirSync(baseDir)) {
      if (d.startsWith('_')) continue;
      const yamlPath = path.join(baseDir, d, 'agent.yaml');
      if (fs.existsSync(yamlPath)) ids.add(d);
    }
  }

  return [...ids];
}

/** Return the capabilities (name + description) for a specific agent. */
export function getAgentCapabilities(
  agentId: string,
): { name: string; description: string } | null {
  try {
    const config = loadAgentConfig(agentId);
    return { name: config.name, description: config.description };
  } catch {
    return null;
  }
}

/**
 * List all configured agents with their descriptions.
 * Unlike `listAgentIds()`, this returns richer metadata and silently
 * skips agents whose config fails to load (e.g. missing token).
 */
export function listAllAgents(): Array<{
  id: string;
  name: string;
  description: string;
  model?: string;
  provider: ProviderConfig;
}> {
  const ids = listAgentIds();
  const result: Array<{
    id: string;
    name: string;
    description: string;
    model?: string;
    provider: ProviderConfig;
  }> = [];

  for (const id of ids) {
    try {
      const config = loadAgentConfig(id);
      result.push({
        id,
        name: config.name,
        description: config.description,
        model: config.model,
        provider: config.provider,
      });
    } catch {
      // Skip agents with broken config
    }
  }

  return result;
}

/**
 * Write the current agent roster to the path the Python Pipecat voice
 * stack reads from. Call this:
 *   - On main-bot startup (index.ts does this already)
 *   - After creating or deleting an agent (agent-create flow)
 *   - Before /warroom/text turns (orchestrator does this cheaply too)
 *
 * The file is read-only metadata: id, name, description. The voice
 * server kills + respawns its subprocess when this changes if callers
 * want the new roster to take effect immediately.
 */
export function refreshWarRoomRoster(): void {
  try {
    const ids = ['main', ...listAgentIds().filter((id) => id !== 'main')];
    const roster = ids.map((id) => {
      try {
        const cfg = loadAgentConfig(id);
        return { id, name: cfg.name || capitalize(id), description: cfg.description || '' };
      } catch {
        return { id, name: capitalize(id), description: '' };
      }
    });
    fs.writeFileSync(WARROOM_ROSTER_PATH, JSON.stringify(roster, null, 2));
  } catch {
    // Non-fatal. Voice stack falls back to the built-in default roster
    // if the file is missing.
  }
}

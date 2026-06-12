import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { readEnvFile } from './env.js';
import type { ProviderConfig } from './provider.js';

const envConfig = readEnvFile([
  'TELEGRAM_BOT_TOKEN',
  'ALLOWED_CHAT_ID',
  'GROQ_API_KEY',
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_VOICE_ID',
  'WHATSAPP_ENABLED',
  'SLACK_USER_TOKEN',
  'CONTEXT_LIMIT',
  'DASHBOARD_PORT',
  'DASHBOARD_TOKEN',
  'DASHBOARD_URL',
  'CLAUDECLAW_CONFIG',
  'DB_ENCRYPTION_KEY',
  'GOOGLE_API_KEY',
  'AGENT_TIMEOUT_MS',
  'AGENT_MAX_TURNS',
  'SECURITY_PIN_HASH',
  'IDLE_LOCK_MINUTES',
  'EMERGENCY_KILL_PHRASE',
  'MODEL_FALLBACK_CHAIN',
  'SMART_ROUTING_ENABLED',
  'SMART_ROUTING_CHEAP_MODEL',
  'SHOW_COST_FOOTER',
  'MEMORY_NOTIFY',
  'DAILY_COST_BUDGET',
  'HOURLY_TOKEN_BUDGET',
  'MEMORY_NUDGE_INTERVAL_TURNS',
  'MEMORY_NUDGE_INTERVAL_HOURS',
  'EXFILTRATION_GUARD_ENABLED',
  'PROTECTED_ENV_VARS',
  'WARROOM_ENABLED',
  'WARROOM_PORT',
  'STREAM_STRATEGY',
  'ENABLE_ACP',
]);

// ── Multi-agent support ──────────────────────────────────────────────
// These are mutable and overridden by index.ts when --agent is passed.
export let AGENT_ID = 'main';
export let activeBotToken =
  process.env.TELEGRAM_BOT_TOKEN || envConfig.TELEGRAM_BOT_TOKEN || '';
export let agentCwd: string | undefined; // undefined = use PROJECT_ROOT
export let agentDefaultModel: string | undefined; // from agent.yaml
export let agentProvider: ProviderConfig | undefined; // from agent.yaml/main-config
export let agentObsidianConfig: { vault: string; folders: string[]; readOnly?: string[] } | undefined;
export let agentSystemPrompt: string | undefined; // loaded from agents/{id}/CLAUDE.md
export let agentMcpAllowlist: string[] | undefined; // from agent.yaml mcp_servers

export function setAgentOverrides(opts: {
  agentId: string;
  botToken: string;
  cwd: string;
  model?: string;
  provider?: ProviderConfig;
  obsidian?: { vault: string; folders: string[]; readOnly?: string[] };
  systemPrompt?: string;
  mcpServers?: string[];
}): void {
  AGENT_ID = opts.agentId;
  activeBotToken = opts.botToken;
  agentCwd = opts.cwd;
  agentDefaultModel = opts.model;
  agentProvider = opts.provider;
  agentObsidianConfig = opts.obsidian;
  agentSystemPrompt = opts.systemPrompt;
  agentMcpAllowlist = opts.mcpServers;
}

/** Update just the system prompt (CLAUDE.md content). Used by the
 *  dashboard's agent-files PUT endpoint after editing main's CLAUDE.md
 *  so the next NEW session in the bot picks up the change without
 *  requiring a process restart. Sub-agents don't need this — the SDK
 *  re-reads CLAUDE.md from cwd via settingSources on every turn. */
export function updateAgentSystemPrompt(next: string | undefined): void {
  agentSystemPrompt = next;
}

/** Update just the active provider for the running process. Dashboard
 * provider changes persist to disk separately; this keeps main hot-switches
 * honest without rebuilding the full agent override object. */
export function updateAgentProvider(next: ProviderConfig | undefined): void {
  agentProvider = next;
}

export const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || envConfig.TELEGRAM_BOT_TOKEN || '';

// Only respond to this Telegram chat ID. Set this after getting your ID via /chatid.
export const ALLOWED_CHAT_ID =
  process.env.ALLOWED_CHAT_ID || envConfig.ALLOWED_CHAT_ID || '';

export const WHATSAPP_ENABLED =
  (process.env.WHATSAPP_ENABLED || envConfig.WHATSAPP_ENABLED || '').toLowerCase() === 'true';

export const SLACK_USER_TOKEN =
  process.env.SLACK_USER_TOKEN || envConfig.SLACK_USER_TOKEN || '';

// Voice — read via readEnvFile, not process.env
export const GROQ_API_KEY = envConfig.GROQ_API_KEY ?? '';
export const ELEVENLABS_API_KEY = envConfig.ELEVENLABS_API_KEY ?? '';
export const ELEVENLABS_VOICE_ID = envConfig.ELEVENLABS_VOICE_ID ?? '';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// PROJECT_ROOT is the claudeclaw/ directory — where CLAUDE.md lives.
// The SDK uses this as cwd, which causes Claude Code to load our CLAUDE.md
// and all global skills from ~/.claude/skills/ via settingSources.
export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');

// ── External config directory ────────────────────────────────────────
// Personal config files (CLAUDE.md, agent.yaml, agent CLAUDE.md) can live
// outside the repo in CLAUDECLAW_CONFIG (default ~/.claudeclaw) so they
// never get committed. The repo ships only .example template files.

/** Expand ~/... to an absolute path. */
export function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

const rawConfigDir =
  process.env.CLAUDECLAW_CONFIG || envConfig.CLAUDECLAW_CONFIG || '~/.claudeclaw';

/**
 * Absolute path to the external config directory.
 * Defaults to ~/.claudeclaw. Set CLAUDECLAW_CONFIG in .env or environment to override.
 */
export const CLAUDECLAW_CONFIG = expandHome(rawConfigDir);

// Telegram limits
export const MAX_MESSAGE_LENGTH = 4096;

// How often to refresh the typing indicator while Claude is thinking (ms).
// Telegram's typing action expires after ~5s, so 4s keeps it continuous.
export const TYPING_REFRESH_MS = 4000;

// Maximum time (ms) an agent query can run before being auto-aborted.
// Safety net for truly stuck commands (e.g. recursive `find /`).
// Default: 15 minutes. Use /stop in Telegram to manually kill a running query.
// Previously 5 min, which caused mid-execution timeouts on bulk API work
// (posting YouTube comments, sending multiple messages) leading to duplicate posts.
export const AGENT_TIMEOUT_MS = parseInt(
  process.env.AGENT_TIMEOUT_MS || envConfig.AGENT_TIMEOUT_MS || '900000',
  10,
);

// Maximum number of agentic turns (tool-use rounds) per query.
// Prevents runaway loops when external services fail (e.g. stale cookies causing
// 40+ sequential Bash retries). 0 = unlimited (SDK default).
// Default: 30 turns, which is generous for complex skills but stops spirals.
export const AGENT_MAX_TURNS = parseInt(
  process.env.AGENT_MAX_TURNS || envConfig.AGENT_MAX_TURNS || '30',
  10,
);

// Fallback context-window limit (tokens). The context gauge and warnings now
// prefer the active model's REAL window as reported by the SDK per turn
// (Opus 4.8 = 1M, Sonnet 4.6 = 200k). This value is only used when the engine
// doesn't report one — e.g. ACP providers, or rows from before the upgrade.
// Override via CONTEXT_LIMIT in .env to change that fallback.
export const CONTEXT_LIMIT = parseInt(
  process.env.CONTEXT_LIMIT || envConfig.CONTEXT_LIMIT || '1000000',
  10,
);

// Dashboard — web UI for monitoring ClaudeClaw state
export const DASHBOARD_PORT = parseInt(
  process.env.DASHBOARD_PORT || envConfig.DASHBOARD_PORT || '3141',
  10,
);
export const DASHBOARD_TOKEN =
  process.env.DASHBOARD_TOKEN || envConfig.DASHBOARD_TOKEN || '';
export const DASHBOARD_URL =
  process.env.DASHBOARD_URL || envConfig.DASHBOARD_URL || '';

// Database encryption key (SQLCipher). Required for encrypted database access.
export const DB_ENCRYPTION_KEY =
  process.env.DB_ENCRYPTION_KEY || envConfig.DB_ENCRYPTION_KEY || '';

// Google API key for Gemini (memory extraction + consolidation)
export const GOOGLE_API_KEY =
  process.env.GOOGLE_API_KEY || envConfig.GOOGLE_API_KEY || '';

// Streaming strategy for progressive Telegram updates.
// 'global-throttle' (default): edits a placeholder message with streamed text,
//   rate-limited to ~24 edits/min per chat to respect Telegram limits.
// 'single-agent-only': streaming disabled when multiple agents are active on same chat.
// 'off': no streaming, wait for full response.
export type StreamStrategy = 'global-throttle' | 'single-agent-only' | 'off';
export const STREAM_STRATEGY: StreamStrategy =
  (process.env.STREAM_STRATEGY || envConfig.STREAM_STRATEGY || 'off') as StreamStrategy;

// ── Security ─────────────────────────────────────────────────────────
// PIN lock: SHA-256 hash of your PIN. Generate: node -e "console.log(require('crypto').createHash('sha256').update('YOUR_PIN').digest('hex'))"
export const SECURITY_PIN_HASH =
  process.env.SECURITY_PIN_HASH || envConfig.SECURITY_PIN_HASH || '';

// Auto-lock after N minutes of inactivity. 0 = disabled. Only active when PIN is set.
export const IDLE_LOCK_MINUTES = parseInt(
  process.env.IDLE_LOCK_MINUTES || envConfig.IDLE_LOCK_MINUTES || '0',
  10,
);

// Emergency kill phrase. Sending this to any bot immediately stops all agents and exits.
export const EMERGENCY_KILL_PHRASE =
  process.env.EMERGENCY_KILL_PHRASE || envConfig.EMERGENCY_KILL_PHRASE || '';

// ── Hermes-inspired enhancements ────────────────────────────────────

// Model fallback chain: comma-separated model IDs. When the primary model
// fails with an overloaded/billing error, try the next model in the chain.
// Example: "claude-sonnet-4-6,claude-haiku-4-5"
export const MODEL_FALLBACK_CHAIN = (
  process.env.MODEL_FALLBACK_CHAIN || envConfig.MODEL_FALLBACK_CHAIN || ''
).split(',').map((s) => s.trim()).filter(Boolean);

// Smart model routing: route simple messages to a cheap model.
// Defaults to false to preserve existing behavior. Opt in via .env.
export const SMART_ROUTING_ENABLED =
  (process.env.SMART_ROUTING_ENABLED || envConfig.SMART_ROUTING_ENABLED || 'false').toLowerCase() === 'true';
export const SMART_ROUTING_CHEAP_MODEL =
  process.env.SMART_ROUTING_CHEAP_MODEL || envConfig.SMART_ROUTING_CHEAP_MODEL || 'claude-haiku-4-5';

// ── Claude model selection ──────────────────────────────────────────
// The /model opus|sonnet|haiku Telegram shortcuts and the fresh-install
// default all resolve through these. Defaults track the current Claude
// lineup; override any of them in .env so a new model release is picked
// up on the next restart WITHOUT a code change or a new release.
// Example: CLAUDE_MODEL_OPUS=claude-opus-4-9
export const CLAUDE_MODEL_OPUS =
  process.env.CLAUDE_MODEL_OPUS || envConfig.CLAUDE_MODEL_OPUS || 'claude-opus-4-8';
export const CLAUDE_MODEL_SONNET =
  process.env.CLAUDE_MODEL_SONNET || envConfig.CLAUDE_MODEL_SONNET || 'claude-sonnet-4-6';
export const CLAUDE_MODEL_HAIKU =
  process.env.CLAUDE_MODEL_HAIKU || envConfig.CLAUDE_MODEL_HAIKU || 'claude-haiku-4-5';
// Default Claude model when no provider/agent model is configured (e.g. fresh installs).
// Falls back to the Opus alias above so it tracks the same single source of truth.
export const DEFAULT_CLAUDE_MODEL =
  process.env.DEFAULT_CLAUDE_MODEL || envConfig.DEFAULT_CLAUDE_MODEL || CLAUDE_MODEL_OPUS;

// Cost footer on every response.
// compact = model only, verbose = model + tokens, cost = model + $, full = everything
export type CostFooterMode = 'off' | 'compact' | 'verbose' | 'cost' | 'full';
export const SHOW_COST_FOOTER: CostFooterMode =
  (process.env.SHOW_COST_FOOTER || envConfig.SHOW_COST_FOOTER || 'compact') as CostFooterMode;

// Memory notifications: send Telegram message when high-importance memories are created.
// Default: 'on'. Set to 'off', 'false', or '0' to disable.
export const MEMORY_NOTIFY: boolean = !['off', 'false', '0'].includes(
  (process.env.MEMORY_NOTIFY || envConfig.MEMORY_NOTIFY || 'on').toLowerCase(),
);

// Daily cost budget in USD. Warns at 80%. Set to 0 to disable (default).
// Only useful for API/pay-per-use users. Subscription users should leave off.
export const DAILY_COST_BUDGET = parseFloat(
  process.env.DAILY_COST_BUDGET || envConfig.DAILY_COST_BUDGET || '0',
);

// Hourly token budget. Warns at 80%. Set to 0 to disable (default).
export const HOURLY_TOKEN_BUDGET = parseInt(
  process.env.HOURLY_TOKEN_BUDGET || envConfig.HOURLY_TOKEN_BUDGET || '0',
  10,
);

// Memory nudge intervals
export const MEMORY_NUDGE_INTERVAL_TURNS = parseInt(
  process.env.MEMORY_NUDGE_INTERVAL_TURNS || envConfig.MEMORY_NUDGE_INTERVAL_TURNS || '10',
  10,
);
export const MEMORY_NUDGE_INTERVAL_HOURS = parseInt(
  process.env.MEMORY_NUDGE_INTERVAL_HOURS || envConfig.MEMORY_NUDGE_INTERVAL_HOURS || '2',
  10,
);

// Secret exfiltration guard
export const EXFILTRATION_GUARD_ENABLED =
  (process.env.EXFILTRATION_GUARD_ENABLED || envConfig.EXFILTRATION_GUARD_ENABLED || 'true').toLowerCase() === 'true';
export const PROTECTED_ENV_VARS = (
  process.env.PROTECTED_ENV_VARS || envConfig.PROTECTED_ENV_VARS ||
  'ANTHROPIC_API_KEY,CLAUDE_CODE_OAUTH_TOKEN,DB_ENCRYPTION_KEY,TELEGRAM_BOT_TOKEN,SLACK_USER_TOKEN,GROQ_API_KEY,ELEVENLABS_API_KEY,GOOGLE_API_KEY'
).split(',').map((s) => s.trim()).filter(Boolean);

// ── Provider Selection (BETA) ───────────────────────────────────────
// Gates the alternate provider (ACP / OpenCode / Gemini / Codex) UI and
// runtime. When false, the dashboard hides the provider picker and the
// engine forces Claude regardless of what's saved in agent.yaml or
// main-config.json. Existing installs without this var see no change.
export const ENABLE_ACP =
  (process.env.ENABLE_ACP || envConfig.ENABLE_ACP || 'false').toLowerCase() === 'true';

// ── War Room (voice meeting via Pipecat WebSocket) ──────────────────
export const WARROOM_ENABLED =
  (process.env.WARROOM_ENABLED || envConfig.WARROOM_ENABLED || 'false').toLowerCase() === 'true';
export const WARROOM_PORT = parseInt(
  process.env.WARROOM_PORT || envConfig.WARROOM_PORT || '7860',
  10,
);

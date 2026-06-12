import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import yaml from 'js-yaml';

import { STORE_DIR, DEFAULT_CLAUDE_MODEL } from './config.js';

export type ProviderType = 'claude' | 'acp' | 'opencode' | 'gemini' | 'codex';
export type ProviderRuntimeMode = string;
export type ProviderThinkingMode = string;

export interface ProviderConfig {
  type: ProviderType;
  /** Optional model override. ACP providers receive this via session/set_model when supported. */
  model?: string;
  /** Provider-specific latency/depth preference. Claude maps known values to effort; ACP uses exact config values. */
  runtimeMode?: ProviderRuntimeMode;
  /** Provider-specific thinking preference. Claude maps known values to thinking; ACP uses exact config values. */
  thinkingMode?: ProviderThinkingMode;
  /** Generic ACP command. Built-in ACP presets supply their own commands. */
  command?: string;
  args?: string[];
  /**
   * Opt-in flag to skip permission prompts and let the provider auto-execute tools.
   * When unset, defaults asymmetrically: Claude keeps its existing permissive
   * behavior (it has months of demonstrated good judgment on Telegram chat
   * conversational vs. coding intent), while ACP providers (codex/gemini/opencode)
   * default to false so a casual Telegram message can't trigger a coding session.
   * Resolve via effectiveSkipPermissions() rather than reading this directly.
   */
  dangerouslySkipPermissions?: boolean;
}

// DEFAULT_CLAUDE_MODEL is resolved from env/config (see config.ts) so model
// upgrades land via .env + restart, not a code change. Re-exported here to keep
// the historical import path (./provider.js) stable for existing call sites.
export { DEFAULT_CLAUDE_MODEL };
export const DEFAULT_PROVIDER: ProviderConfig = { type: 'claude', model: DEFAULT_CLAUDE_MODEL };
export const DEFAULT_CODEX_MODEL = 'gpt-5.5';

export function normalizeProviderConfig(input: unknown, legacyModel?: string): ProviderConfig {
  const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const typeRaw = typeof raw.type === 'string' ? raw.type.toLowerCase() : undefined;

  if (typeRaw === 'claude' || typeRaw === 'acp' || typeRaw === 'opencode' || typeRaw === 'gemini' || typeRaw === 'codex') {
    const cfg: ProviderConfig = { type: typeRaw };
    if (typeof raw.model === 'string' && raw.model.trim()) cfg.model = raw.model.trim();
    if (typeof raw.runtimeMode === 'string' && raw.runtimeMode.trim()) cfg.runtimeMode = raw.runtimeMode.trim();
    if (typeof raw.thinkingMode === 'string' && raw.thinkingMode.trim()) cfg.thinkingMode = raw.thinkingMode.trim();
    if (typeof raw.command === 'string' && raw.command.trim()) cfg.command = raw.command.trim();
    if (Array.isArray(raw.args)) cfg.args = raw.args.filter((v): v is string => typeof v === 'string');
    if (typeof raw.dangerouslySkipPermissions === 'boolean') cfg.dangerouslySkipPermissions = raw.dangerouslySkipPermissions;
    return cfg;
  }

  if (legacyModel?.startsWith('claude-')) {
    return { type: 'claude', model: legacyModel };
  }

  return { ...DEFAULT_PROVIDER };
}

export function providerToYaml(provider: ProviderConfig): Record<string, unknown> {
  const raw: Record<string, unknown> = { type: provider.type };
  if (provider.model) raw.model = provider.model;
  if (provider.runtimeMode) raw.runtimeMode = provider.runtimeMode;
  if (provider.thinkingMode) raw.thinkingMode = provider.thinkingMode;
  if (provider.type === 'acp') {
    if (provider.command) raw.command = provider.command;
    if (provider.args) raw.args = provider.args;
  }
  if (provider.dangerouslySkipPermissions === true) raw.dangerouslySkipPermissions = true;
  return raw;
}

/**
 * Asymmetric default: Claude keeps full tool access (load-bearing for
 * notify.sh, scheduling, mission tasks, memory queries, Obsidian, file
 * sending). ACP providers (codex/gemini/opencode) start locked down because
 * they have no track record on the conversational Telegram path and have
 * demonstrated a tendency to interpret casual prompts as coding tasks.
 * Set provider.dangerouslySkipPermissions explicitly to override.
 */
export function effectiveSkipPermissions(provider: ProviderConfig): boolean {
  return provider.dangerouslySkipPermissions ?? provider.type === 'claude';
}

function mainConfigPath(): string {
  return path.join(STORE_DIR, 'main-config.json');
}

function readMainConfig(): Record<string, unknown> {
  try {
    const configPath = mainConfigPath();
    if (!fs.existsSync(configPath)) return {};
    return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeMainConfig(raw: Record<string, unknown>): void {
  if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFileSync(mainConfigPath(), JSON.stringify(raw, null, 2) + '\n', 'utf-8');
}

export function getMainProviderConfig(): ProviderConfig {
  const raw = readMainConfig();
  return normalizeProviderConfig(raw.provider, typeof raw.model === 'string' ? raw.model : undefined);
}

export function setMainProviderConfig(provider: ProviderConfig): void {
  const raw = readMainConfig();
  raw.provider = providerToYaml(provider);
  delete raw.model;
  writeMainConfig(raw);
}

export function getProviderDisplay(provider: ProviderConfig): string {
  const suffix = [
    provider.model,
    provider.runtimeMode,
    provider.thinkingMode && provider.thinkingMode !== 'auto' ? `thinking ${provider.thinkingMode}` : undefined,
  ].filter(Boolean).join(', ');
  if (provider.type === 'claude') return `Claude${suffix ? ` (${suffix})` : ''}`;
  if (provider.type === 'opencode') return `OpenCode${suffix ? ` (${suffix})` : ' (model from OpenCode config)'}`;
  if (provider.type === 'gemini') return `Gemini CLI${suffix ? ` (${suffix})` : ' (ACP)'}`;
  if (provider.type === 'codex') return `Codex${suffix ? ` (${suffix})` : ' (codex-acp adapter)'}`;
  return `ACP (${provider.command ?? 'custom command'}${provider.args?.length ? ` ${provider.args.join(' ')}` : ''}${suffix ? `; ${suffix}` : ''})`;
}

export function sessionBelongsToProvider(sessionId: string | undefined, provider: ProviderConfig): boolean {
  if (!sessionId) return false;
  if (!sessionId.includes(':')) return provider.type === 'claude';
  return sessionId.startsWith(`${provider.type}:`);
}

export function encodeProviderSession(provider: ProviderConfig, sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  return `${provider.type}:${sessionId}`;
}

export function decodeProviderSession(provider: ProviderConfig, sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  const prefix = `${provider.type}:`;
  if (sessionId.startsWith(prefix)) return sessionId.slice(prefix.length);
  if (!sessionId.includes(':') && provider.type === 'claude') return sessionId;
  return undefined;
}

export function readProviderFromYaml(raw: Record<string, unknown>): ProviderConfig {
  const legacyModel = typeof raw.model === 'string' ? raw.model : undefined;
  return normalizeProviderConfig(raw.provider, legacyModel);
}

export function writeProviderToYaml(raw: Record<string, unknown>, provider: ProviderConfig): Record<string, unknown> {
  raw.provider = providerToYaml(provider);
  delete raw.model;
  return raw;
}

export function parseYamlProvider(filePath: string): ProviderConfig {
  const raw = yaml.load(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  return readProviderFromYaml(raw);
}

export interface ProviderAvailability {
  ok: boolean;
  /** Human-readable description of the problem. Present when ok is false. */
  error?: string;
  /** Shell command the user can copy-paste to install the missing CLI. */
  installCommand?: string;
  /** What to do after installing (e.g. authenticate). */
  setupHint?: string;
  /** Upstream documentation URL for further reading. */
  docsUrl?: string;
}

function commandExists(command: string): boolean {
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(lookup, [command], { stdio: 'pipe' }).status === 0;
}

/**
 * Checks whether the CLI required by the given provider is on PATH for the
 * ClaudeClaw service. Returns structured availability info so callers (wizard,
 * dashboard preflight, status command) can show actionable install hints
 * instead of generic spawn ENOENT errors.
 *
 * Authentication is intentionally not checked here — providers manage their
 * own credentials and a CLI that is installed but unauthenticated is still
 * "available". Auth failures surface later with provider-specific messages
 * from src/errors.ts.
 */
export function checkProviderAvailability(provider: ProviderConfig): ProviderAvailability {
  switch (provider.type) {
    case 'claude': {
      // The claude-agent-sdk bundles its own Claude Code runtime and resolves it
      // internally — it does NOT require a standalone `claude` binary on PATH.
      // Daemon deployments (launchd/systemd/docker) typically run with a minimal
      // PATH that does not include the dir where a globally-installed CLI lives,
      // so gating the claude provider on `which claude` produced false
      // "Claude Code CLI not found on PATH" 400s when switching providers from
      // the dashboard — even though agent turns run fine. Treat the claude
      // provider as available whenever the SDK package resolves; fall back to the
      // PATH check (and its install hint) only when the SDK itself is absent.
      try {
        createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
        return { ok: true };
      } catch { /* SDK not resolvable — fall through to the PATH-based check */ }
      if (!commandExists('claude')) {
        return {
          ok: false,
          error: 'Claude Code SDK not installed and `claude` CLI not found on PATH.',
          installCommand: 'npm install',
          setupHint: 'Run `npm install` to pull the bundled claude-agent-sdk, then `claude login` (free/Pro/Max) or set ANTHROPIC_API_KEY in .env for pay-per-token billing.',
          docsUrl: 'https://docs.claude.com/en/docs/claude-code/overview',
        };
      }
      return { ok: true };
    }
    case 'opencode':
      if (!commandExists('opencode')) {
        return {
          ok: false,
          error: 'OpenCode CLI not found on PATH.',
          installCommand: 'npm install -g opencode-ai',
          setupHint: 'Run `opencode auth login` to add provider credentials (OpenAI, Anthropic, GLM, Qwen, DeepSeek, etc.).',
          docsUrl: 'https://opencode.ai/docs',
        };
      }
      return { ok: true };
    case 'gemini':
      if (!commandExists('gemini')) {
        return {
          ok: false,
          error: 'Gemini CLI not found on PATH.',
          installCommand: 'npm install -g @google/gemini-cli',
          setupHint: 'Run `gemini` once after install to authenticate with your Google account.',
          docsUrl: 'https://github.com/google-gemini/gemini-cli',
        };
      }
      return { ok: true };
    case 'codex':
      if (!commandExists('codex')) {
        return {
          ok: false,
          error: 'Codex CLI not found on PATH (required by the bundled codex-acp adapter).',
          installCommand: 'npm install -g @openai/codex',
          setupHint: 'Run `codex` once after install to authenticate with your OpenAI account.',
          docsUrl: 'https://github.com/openai/codex',
        };
      }
      return { ok: true };
    case 'acp': {
      if (!provider.command?.trim()) {
        return { ok: false, error: 'Custom ACP provider requires a command.' };
      }
      if (!commandExists(provider.command)) {
        return {
          ok: false,
          error: `Custom ACP command "${provider.command}" not found on PATH.`,
          setupHint: 'Install and authenticate the provider, then make sure the command is on PATH for the ClaudeClaw service. Restart with `pm2 restart claudeclaw --update-env` to refresh PATH if you just installed it.',
        };
      }
      return { ok: true };
    }
    default:
      return { ok: true };
  }
}

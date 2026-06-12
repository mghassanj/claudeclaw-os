import { spawn } from 'child_process';
import path from 'path';
import { Readable, Writable } from 'stream';

import * as acp from '@agentclientprotocol/sdk';

import { PROJECT_ROOT } from '../config.js';
import { logger } from '../logger.js';
import type { ProviderConfig } from '../provider.js';
import { getScrubbedSdkEnv } from '../security.js';
import type { AgentEngine, AgentEngineEvent, AgentEngineProgressEvent, AgentTurnInput, McpStdioConfig } from './types.js';
import { emptyUsage } from './types.js';

class ClaudeClawAcpClient {
  private accumulatedText = '';
  private toolTitles = new Map<string, string>();

  constructor(
    private readonly emit: (event: AgentEngineEvent) => void,
    private readonly policy: AcpToolPolicy = {},
  ) {}

  get text(): string {
    return this.accumulatedText;
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update as Record<string, unknown>;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const content = update.content as { type?: string; text?: string } | undefined;
        if (content?.type === 'text' && content.text) {
          this.accumulatedText += content.text;
          this.emit({ type: 'text_delta', delta: content.text, accumulatedText: this.accumulatedText, raw: params });
        }
        break;
      }
      case 'tool_call': {
        const title = typeof update.title === 'string' ? update.title : 'Tool active';
        const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : undefined;
        if (toolCallId) this.toolTitles.set(toolCallId, title);
        this.emitProgress({
          type: 'tool_active',
          description: title,
          status: typeof update.status === 'string' ? update.status : 'pending',
          kind: typeof update.kind === 'string' ? update.kind : undefined,
          toolCallId,
          locations: parseLocations(update.locations),
        }, params);
        break;
      }
      case 'tool_call_update': {
        const status = typeof update.status === 'string' ? update.status : undefined;
        const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : undefined;
        const title = typeof update.title === 'string'
          ? update.title
          : toolCallId ? this.toolTitles.get(toolCallId) : undefined;
        if (toolCallId && title) this.toolTitles.set(toolCallId, title);
        this.emitProgress({
          type: status === 'failed' ? 'task_completed' : 'tool_active',
          description: title ?? (status ? `Tool ${status}` : 'Tool update'),
          status,
          kind: typeof update.kind === 'string' ? update.kind : undefined,
          toolCallId,
          locations: parseLocations(update.locations),
        }, params);
        break;
      }
      case 'plan': {
        const planEntries = parsePlanEntries(update.entries);
        const active = planEntries.find((entry) => entry.status === 'in_progress')
          ?? planEntries.find((entry) => entry.status === 'pending')
          ?? planEntries[0];
        if (active) {
          this.emitProgress({
            type: 'plan',
            description: active.content,
            status: active.status,
            planEntries,
          }, params);
        }
        break;
      }
    }
  }

  async requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    if (!isAcpToolAllowed(params.toolCall, this.policy)) {
      const reject = params.options.find((o) => o.kind === 'reject_once')
        ?? params.options.find((o) => o.kind === 'reject_always');
      if (reject) return { outcome: { outcome: 'selected', optionId: reject.optionId } };
      return { outcome: { outcome: 'cancelled' } };
    }

    const allow = params.options.find((o) => o.kind === 'allow_always')
      ?? params.options.find((o) => o.kind === 'allow_once')
      ?? params.options[0];
    if (!allow) return { outcome: { outcome: 'cancelled' } };
    return { outcome: { outcome: 'selected', optionId: allow.optionId } };
  }

  async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    if (!isAcpClientFsAllowed('read', this.policy)) {
      throw new Error(`ACP file read blocked by tool policy: ${params.path}`);
    }
    const fs = await import('fs');
    return { content: fs.readFileSync(params.path, 'utf-8') };
  }

  async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    if (!isAcpClientFsAllowed('write', this.policy)) {
      throw new Error(`ACP file write blocked by tool policy: ${params.path}`);
    }
    const fs = await import('fs');
    fs.writeFileSync(params.path, params.content, 'utf-8');
    return {};
  }

  private emitProgress(progress: AgentEngineProgressEvent, raw: unknown): void {
    this.emit({ type: 'progress', progress, raw });
  }
}

interface AcpToolPolicy {
  allowedTools?: string[];
  disallowedTools?: string[];
}

function normalizeToolToken(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, '');
}

function acpToolCandidates(toolCall: acp.ToolCallUpdate): string[] {
  const candidates = [
    toolCall.title ?? '',
    toolCall.kind ?? '',
    toolCall.toolCallId ?? '',
  ];
  if (toolCall.kind === 'execute') candidates.push('Bash');
  if (toolCall.kind === 'read') candidates.push('Read');
  if (toolCall.kind === 'search') candidates.push('Grep', 'Glob');
  if (toolCall.kind === 'edit' || toolCall.kind === 'move' || toolCall.kind === 'delete') {
    candidates.push('Edit', 'Write');
  }
  return candidates.filter(Boolean).map(normalizeToolToken);
}

function tokenMatchesTool(token: string, candidates: string[]): boolean {
  const normalized = normalizeToolToken(token);
  return candidates.some((candidate) => candidate === normalized || candidate.includes(normalized));
}

function isAcpToolAllowed(toolCall: acp.ToolCallUpdate, policy: AcpToolPolicy): boolean {
  const allowedTools = policy.allowedTools;
  const disallowedTools = policy.disallowedTools;
  const candidates = acpToolCandidates(toolCall);

  if (allowedTools && allowedTools.some((tool) => tokenMatchesTool(tool, candidates))) return true;
  if (disallowedTools?.includes('*')) return false;
  if (disallowedTools?.some((tool) => tokenMatchesTool(tool, candidates))) return false;
  if (allowedTools && allowedTools.length === 0) return false;
  if (allowedTools && allowedTools.length > 0) return false;
  return true;
}

function isAcpClientFsAllowed(kind: 'read' | 'write', policy: AcpToolPolicy): boolean {
  const toolCall: acp.ToolCallUpdate = {
    toolCallId: `client-fs-${kind}`,
    title: kind === 'read' ? 'Read file' : 'Write file',
    kind: kind === 'read' ? 'read' : 'edit',
  };
  return isAcpToolAllowed(toolCall, policy);
}

function parseLocations(value: unknown): Array<{ path: string; line?: number | null }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const locations: Array<{ path: string; line?: number | null }> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.path !== 'string') continue;
    const location: { path: string; line?: number | null } = { path: raw.path };
    if (typeof raw.line === 'number') location.line = raw.line;
    locations.push(location);
  }
  return locations.length ? locations : undefined;
}

function parsePlanEntries(value: unknown): Array<{ content: string; status: string; priority?: string }> {
  if (!Array.isArray(value)) return [];
  const entries: Array<{ content: string; status: string; priority?: string }> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.content !== 'string' || typeof raw.status !== 'string') continue;
    const entry: { content: string; status: string; priority?: string } = {
      content: raw.content,
      status: raw.status,
    };
    if (typeof raw.priority === 'string') entry.priority = raw.priority;
    entries.push(entry);
  }
  return entries;
}

type RuntimePreference = 'fast' | 'normal' | 'deep';
type ThinkingPreference = 'auto' | 'off' | 'on';
export interface AcpProviderRuntimeChoice {
  id: string;
  label: string;
  current?: boolean;
}

export interface AcpProviderRuntimeOptions {
  provider: ProviderConfig['type'];
  modeOptions: AcpProviderRuntimeChoice[];
  thinkingOptions: AcpProviderRuntimeChoice[];
  rawConfigOptions: acp.SessionConfigOption[];
  source: 'provider' | 'fallback';
  error?: string;
}

function runtimePreferenceFromEffort(effort: AgentTurnInput['effort']): RuntimePreference | undefined {
  if (effort === 'low') return 'fast';
  if (effort === 'medium') return 'normal';
  if (effort === 'high' || effort === 'max') return 'deep';
  return undefined;
}

function thinkingPreferenceFromConfig(thinking: AgentTurnInput['thinking']): ThinkingPreference | undefined {
  if (!thinking) return undefined;
  if (thinking.type === 'disabled') return 'off';
  if (thinking.type === 'enabled') return 'on';
  return 'auto';
}

function flattenConfigOptions(options: acp.SessionConfigSelectOptions): acp.SessionConfigSelectOption[] {
  const out: acp.SessionConfigSelectOption[] = [];
  for (const option of options) {
    if ('value' in option) out.push(option);
    else out.push(...option.options);
  }
  return out;
}

function scoreConfigValue(option: acp.SessionConfigSelectOption, aliases: string[]): number {
  const value = option.value.toLowerCase();
  const name = option.name.toLowerCase();
  for (const [idx, alias] of aliases.entries()) {
    if (value === alias || name === alias) return 100 - idx;
    if (value.includes(alias) || name.includes(alias)) return 50 - idx;
  }
  return 0;
}

function selectConfigValue(
  option: acp.SessionConfigOption,
  aliases: string[],
): string | boolean | undefined {
  if (option.type === 'boolean') {
    if (aliases.includes('off') || aliases.includes('disabled')) return false;
    if (aliases.includes('on') || aliases.includes('enabled')) return true;
    return undefined;
  }
  const ranked = flattenConfigOptions(option.options)
    .map((entry) => ({ entry, score: scoreConfigValue(entry, aliases) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.entry.value;
}

function selectExactConfigValue(
  option: acp.SessionConfigOption,
  selected: string | undefined,
): string | boolean | undefined {
  if (!selected) return undefined;
  const normalized = selected.toLowerCase();
  if (option.type === 'boolean') {
    if (['true', 'on', 'enabled', 'yes'].includes(normalized)) return true;
    if (['false', 'off', 'disabled', 'no'].includes(normalized)) return false;
    return undefined;
  }
  const entry = flattenConfigOptions(option.options).find((choice) => choice.value === selected);
  return entry?.value;
}

function selectFullAccessConfigValue(option: acp.SessionConfigOption): string | undefined {
  if (option.type === 'boolean') return undefined;
  const aliases = ['full-access', 'full_access', 'full access', 'unrestricted', 'danger-full-access'];
  return flattenConfigOptions(option.options).find((choice) => {
    const value = choice.value.toLowerCase();
    const name = choice.name.toLowerCase();
    return aliases.some((alias) => value === alias || name === alias);
  })?.value;
}

function aliasesForRuntime(pref: RuntimePreference): string[] {
  if (pref === 'fast') return ['fast', 'quick', 'low', 'concise'];
  if (pref === 'normal') return ['normal', 'medium', 'default', 'balanced'];
  return ['deep', 'high', 'max', 'thinking', 'thorough'];
}

function aliasesForThinking(pref: ThinkingPreference): string[] {
  if (pref === 'off') return ['off', 'disabled', 'none', 'low'];
  if (pref === 'on') return ['on', 'enabled', 'high', 'deep', 'max'];
  return ['auto', 'adaptive', 'normal', 'medium', 'default'];
}

export function getAcpCommand(provider: ProviderConfig): { command: string; args: string[] } {
  if (provider.type === 'opencode') return { command: 'opencode', args: ['acp'] };
  if (provider.type === 'gemini') return { command: 'gemini', args: ['--acp'] };
  if (provider.type === 'codex') return { command: 'codex-acp', args: [] };
  if (!provider.command) throw new Error('ACP provider requires a command');
  return { command: provider.command, args: provider.args ?? [] };
}

function getAcpEnv(env?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const localBin = path.join(PROJECT_ROOT, 'node_modules', '.bin');
  const base = getScrubbedSdkEnv();
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value === undefined) delete base[key];
    else base[key] = value;
  }
  for (const key of Object.keys(base)) {
    if (isSecretEnvName(key)) delete base[key];
  }
  const inheritedPath = base.PATH ?? process.env.PATH;
  base.PATH = inheritedPath
    ? `${inheritedPath}${path.delimiter}${localBin}`
    : localBin;
  return base as NodeJS.ProcessEnv;
}

function isSecretEnvName(key: string): boolean {
  return [
    'DASHBOARD_TOKEN',
    'DB_ENCRYPTION_KEY',
    'TELEGRAM_BOT_TOKEN',
    'ANTHROPIC_API_KEY',
  ].includes(key)
    || /_API_KEY$/.test(key)
    || /_TOKEN$/.test(key)
    || /_SECRET$/.test(key)
    || /^SECRET_/.test(key);
}

function isLockedDownToolPolicy(input: AgentTurnInput): boolean {
  return input.disallowedTools?.includes('*') === true
    || input.allowedTools?.length === 0
    || input.permissionMode === 'default';
}

function toAcpMcpServers(mcpServers?: AgentTurnInput['mcpServers']): acp.McpServer[] {
  if (!mcpServers) return [];
  return Object.entries(mcpServers)
    // ACP providers only support stdio (command-based) MCP servers. HTTP/SSE
    // configs are Claude-SDK-only; skip them here rather than send a malformed
    // stdio entry with no command.
    .filter((entry): entry is [string, McpStdioConfig] => 'command' in entry[1])
    .map(([name, cfg]) => ({
      name,
      command: cfg.command,
      args: cfg.args ?? [],
      env: Object.entries(cfg.env ?? {}).map(([envName, value]) => ({
        name: envName,
        value,
      })),
    }));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timed = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timed]).finally(() => {
    if (timeout) clearTimeout(timeout);
  }) as Promise<T>;
}

function choicesFromConfigOption(option: acp.SessionConfigOption | undefined): AcpProviderRuntimeChoice[] {
  if (!option) return [];
  if (option.type === 'boolean') {
    return [
      { id: 'true', label: 'On', current: option.currentValue === true },
      { id: 'false', label: 'Off', current: option.currentValue === false },
    ];
  }
  return flattenConfigOptions(option.options).map((choice) => ({
    id: choice.value,
    label: choice.name || choice.value,
    current: choice.value === option.currentValue,
  }));
}

function speedChoicesFromConfigOption(option: acp.SessionConfigOption | undefined): AcpProviderRuntimeChoice[] {
  const speedAliases = ['fast', 'quick', 'speed', 'normal', 'medium', 'balanced', 'deep', 'high', 'thorough', 'max', 'xhigh', 'extra'];
  const blockedAliases = ['read-only', 'readonly', 'full-access', 'full_access', 'permission', 'access', 'plan', 'build', 'auto'];
  return choicesFromConfigOption(option).filter((choice) => {
    const text = `${choice.id} ${choice.label}`.toLowerCase();
    if (blockedAliases.some((alias) => text.includes(alias))) return false;
    return speedAliases.some((alias) => text.includes(alias));
  });
}

export async function inspectAcpProviderRuntimeOptions(
  provider: ProviderConfig,
  cwd = PROJECT_ROOT,
  timeoutMs = 5000,
): Promise<AcpProviderRuntimeOptions> {
  const { command, args } = getAcpCommand(provider);
  const isWindows = process.platform === 'win32';
  // On Windows, absolute paths with spaces fail when shell: true because 
  // cmd.exe splits on the space. We only need the shell for searching 
  // the PATH for non-absolute commands (like 'opencode').
  const useShell = isWindows && !path.isAbsolute(command);
  const child = spawn(command, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: getAcpEnv(),
    shell: useShell,
  });
  const spawnErrorPromise = new Promise<never>((_, reject) => {
    child.once('error', (err: NodeJS.ErrnoException) => {
      const hint = err.code === 'ENOENT'
        ? ` Make sure "${command}" is installed and available on PATH for the ClaudeClaw service.`
        : '';
      reject(new Error(`Failed to start ACP provider command "${command}": ${err.message}.${hint}`));
    });
  });
  const withSpawnError = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, spawnErrorPromise]);

  try {
    const inputStream = Writable.toWeb(child.stdin!);
    const outputStream = Readable.toWeb(child.stdout!);
    const stream = acp.ndJsonStream(inputStream, outputStream);
    const connection = new acp.ClientSideConnection(() => new ClaudeClawAcpClient(() => {}), stream);

    await withTimeout(withSpawnError(connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
      clientInfo: { name: 'ClaudeClaw', version: '1.1.0' },
    })), timeoutMs, 'ACP provider initialize');

    const created = await withTimeout(withSpawnError(connection.newSession({
      cwd,
      mcpServers: [],
    })), timeoutMs, 'ACP provider runtime option probe');
    const rawConfigOptions: acp.SessionConfigOption[] = created.configOptions ?? [];
    return {
      provider: provider.type,
      modeOptions: speedChoicesFromConfigOption(rawConfigOptions.find((cfg) => cfg.category === 'mode')),
      thinkingOptions: choicesFromConfigOption(rawConfigOptions.find((cfg) => cfg.category === 'thought_level')),
      rawConfigOptions,
      source: 'provider',
    };
  } finally {
    child.kill();
  }
}

function isSessionNotFoundError(err: unknown): boolean {
  const data = (err as { data?: unknown })?.data;
  const message = err instanceof Error ? err.message : String(err);
  const dataText = typeof data === 'string'
    ? data
    : data ? JSON.stringify(data) : '';
  return /session not found/i.test(`${message}\n${dataText}`);
}

function isMethodNotFoundError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  const message = err instanceof Error ? err.message : String(err);
  return code === -32601 || /method not found/i.test(message);
}

function isInvalidParamsError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  const message = err instanceof Error ? err.message : String(err);
  return code === -32602 || /invalid params/i.test(message);
}

export class AcpEngineAdapter implements AgentEngine {
  async *invoke(input: AgentTurnInput): AsyncIterable<AgentEngineEvent> {
    const { command, args } = getAcpCommand(input.provider);
    const pending: AgentEngineEvent[] = [];
    const isWindows = process.platform === 'win32';
    // On Windows, absolute paths with spaces fail when shell: true because 
    // cmd.exe splits on the space. We only need the shell for searching 
    // the PATH for non-absolute commands (like 'opencode').
    const useShell = isWindows && !path.isAbsolute(command);
    const child = spawn(command, args, {
      cwd: input.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: getAcpEnv(input.env),
      shell: useShell,
    });
    const spawnErrorPromise = new Promise<never>((_, reject) => {
      child.once('error', (err: NodeJS.ErrnoException) => {
        const hint = err.code === 'ENOENT'
          ? ` Make sure "${command}" is installed and available on PATH for the ClaudeClaw service.`
          : '';
        reject(new Error(`Failed to start ACP provider command "${command}": ${err.message}.${hint}`));
      });
    });
    const withSpawnError = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, spawnErrorPromise]);

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    const client = new ClaudeClawAcpClient((event) => pending.push(event), {
      allowedTools: input.allowedTools,
      disallowedTools: input.disallowedTools,
    });
    const inputStream = Writable.toWeb(child.stdin!);
    const outputStream = Readable.toWeb(child.stdout!);
    const stream = acp.ndJsonStream(inputStream, outputStream);
    const connection = new acp.ClientSideConnection(() => client, stream);

    const abortHandler = () => {
      if (input.sessionId) void connection.cancel({ sessionId: input.sessionId }).catch(() => {});
      child.kill('SIGTERM');
    };
    input.abortController?.signal.addEventListener('abort', abortHandler, { once: true });

    const flush = async function* (): AsyncIterable<AgentEngineEvent> {
      while (pending.length) yield pending.shift()!;
    };

    try {
      const init = await withSpawnError(connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: false,
        },
        clientInfo: { name: 'ClaudeClaw', version: '1.1.0' },
      }));

      logger.info(
        { provider: input.provider.type, protocolVersion: init.protocolVersion, agent: init.agentInfo?.name },
        'ACP provider initialized',
      );

      let activeSessionId = input.sessionId;
      let activeConfigOptions: acp.SessionConfigOption[] = [];
      const capabilities = init.agentCapabilities as Record<string, unknown>;
      const sessionCaps = capabilities.session && typeof capabilities.session === 'object'
        ? capabilities.session as Record<string, unknown>
        : undefined;
      const canResumeSession = sessionCaps?.resume === true;

      if (activeSessionId) {
        if (canResumeSession) {
          try {
            const resumed = await withSpawnError(connection.resumeSession({
              sessionId: activeSessionId,
              cwd: input.cwd,
              mcpServers: toAcpMcpServers(input.mcpServers),
            }));
            activeConfigOptions = resumed.configOptions ?? [];
          } catch (err) {
            if (!isSessionNotFoundError(err)) throw err;
            logger.warn({ provider: input.provider.type, sessionId: activeSessionId }, 'ACP provider could not resume session; starting a new session');
            activeSessionId = undefined;
          }
        } else {
          logger.info({ provider: input.provider.type }, 'ACP provider does not advertise session resume; starting a new session');
          activeSessionId = undefined;
        }
      }

      const setSessionModel = async (sessionIdForModel: string): Promise<AgentEngineEvent | null> => {
        if (!input.model) return null;
        try {
          await withSpawnError(connection.unstable_setSessionModel({
            sessionId: sessionIdForModel,
            modelId: input.model,
          }));
          return {
            type: 'progress' as const,
            progress: { type: 'task_started' as const, description: `${input.provider.type} model set to ${input.model}` },
          };
        } catch (err) {
          if (isMethodNotFoundError(err)) {
            logger.warn({ provider: input.provider.type, model: input.model }, 'ACP provider does not support session/set_model; continuing with provider default');
            return null;
          }
          throw err;
        }
      };

      const applySessionConfig = async (
        sessionIdForConfig: string,
        configOptions: acp.SessionConfigOption[],
      ): Promise<AgentEngineEvent[]> => {
        const events: AgentEngineEvent[] = [];
        const runtimePref = runtimePreferenceFromEffort(input.effort);
        const thinkingPref = thinkingPreferenceFromConfig(input.thinking);
        const targets: Array<{ category: string; exact?: string; aliases: string[]; description: string }> = [];
        if (input.runtimeMode) {
          const runtimeAliases = input.runtimeMode === 'fast' || input.runtimeMode === 'normal' || input.runtimeMode === 'deep'
            ? aliasesForRuntime(input.runtimeMode)
            : [input.runtimeMode.toLowerCase(), input.runtimeMode.toLowerCase().replace(/[\s-]+/g, '_')];
          targets.push({
            category: 'mode',
            exact: input.runtimeMode,
            aliases: runtimeAliases,
            description: `${input.provider.type} mode set to ${input.runtimeMode}`,
          });
        }
        if (runtimePref && !input.runtimeMode) {
          targets.push({
            category: 'mode',
            aliases: aliasesForRuntime(runtimePref),
            description: `${input.provider.type} mode set to ${runtimePref}`,
          });
        }
        if (input.thinkingMode) {
          const thinkingAliases = input.thinkingMode === 'off' || input.thinkingMode === 'on' || input.thinkingMode === 'auto'
            ? aliasesForThinking(input.thinkingMode)
            : [input.thinkingMode.toLowerCase(), input.thinkingMode.toLowerCase().replace(/[\s-]+/g, '_')];
          targets.push({
            category: 'thought_level',
            exact: input.thinkingMode,
            aliases: thinkingAliases,
            description: `${input.provider.type} thinking set to ${input.thinkingMode}`,
          });
        }
        if (thinkingPref && !input.thinkingMode) {
          targets.push({
            category: 'thought_level',
            aliases: aliasesForThinking(thinkingPref),
            description: `${input.provider.type} thinking set to ${thinkingPref}`,
          });
        }

        let appliedModeConfig = false;
        for (const target of targets) {
          const option = configOptions.find((cfg) => cfg.category === target.category);
          if (!option) continue;
          const value = selectExactConfigValue(option, target.exact) ?? selectConfigValue(option, target.aliases);
          if (value === undefined) continue;
          try {
            const response = await withSpawnError(connection.setSessionConfigOption({
              sessionId: sessionIdForConfig,
              configId: option.id,
              ...(typeof value === 'boolean'
                ? { type: 'boolean' as const, value }
                : { value }),
            }));
            activeConfigOptions = response.configOptions ?? activeConfigOptions;
            if (target.category === 'mode') appliedModeConfig = true;
            events.push({
              type: 'progress',
              progress: { type: 'task_started', description: target.description },
            });
          } catch (err) {
            if (isMethodNotFoundError(err) || isInvalidParamsError(err)) {
              logger.warn({ provider: input.provider.type, category: target.category }, 'ACP provider could not apply session config option');
              continue;
            }
            throw err;
          }
        }

        const accessOption = configOptions.find((cfg) => cfg.category === 'mode');
        const fullAccessValue = accessOption ? selectFullAccessConfigValue(accessOption) : undefined;
        if (
          accessOption
          && fullAccessValue
          && !appliedModeConfig
          && input.allowDangerouslySkipPermissions === true
          && !isLockedDownToolPolicy(input)
        ) {
          try {
            const response = await withSpawnError(connection.setSessionConfigOption({
              sessionId: sessionIdForConfig,
              configId: accessOption.id,
              value: fullAccessValue,
            }));
            activeConfigOptions = response.configOptions ?? activeConfigOptions;
          } catch (err) {
            if (isMethodNotFoundError(err) || isInvalidParamsError(err)) {
              logger.warn({ provider: input.provider.type }, 'ACP provider could not apply full-access mode');
            } else {
              throw err;
            }
          }
        }
        return events;
      };

      const createSession = async (): Promise<string> => {
        const created = await withSpawnError(connection.newSession({
          cwd: input.cwd,
          mcpServers: toAcpMcpServers(input.mcpServers),
        }));
        activeConfigOptions = created.configOptions ?? [];
        return created.sessionId;
      };

      if (!activeSessionId) activeSessionId = await createSession();
      const modelEvent = await setSessionModel(activeSessionId);
      if (modelEvent) yield modelEvent;
      for (const event of await applySessionConfig(activeSessionId, activeConfigOptions)) yield event;

      yield { type: 'session', sessionId: activeSessionId };
      yield {
        type: 'progress',
        progress: { type: 'task_started', description: `${input.provider.type} session started` },
      };

      let promptResult: acp.PromptResponse;
      try {
        promptResult = await withSpawnError(connection.prompt({
          sessionId: activeSessionId,
          prompt: [{ type: 'text', text: input.prompt }],
        }));
      } catch (err) {
        if (!isSessionNotFoundError(err)) throw err;
        logger.warn({ provider: input.provider.type, sessionId: activeSessionId }, 'ACP provider rejected stale session; starting a new session');
        activeSessionId = await createSession();
        const retryModelEvent = await setSessionModel(activeSessionId);
        if (retryModelEvent) yield retryModelEvent;
        for (const event of await applySessionConfig(activeSessionId, activeConfigOptions)) yield event;
        yield { type: 'session', sessionId: activeSessionId };
        promptResult = await withSpawnError(connection.prompt({
          sessionId: activeSessionId,
          prompt: [{ type: 'text', text: input.prompt }],
        }));
      }

      for await (const event of flush()) yield event;

      if (promptResult.stopReason === 'cancelled' || input.abortController?.signal.aborted) {
        yield { type: 'aborted', text: client.text || null, sessionId: activeSessionId, usage: emptyUsage() };
        return;
      }

      yield { type: 'result', text: client.text || null, usage: emptyUsage(), raw: promptResult };
    } catch (err) {
      for await (const event of flush()) yield event;
      if (input.abortController?.signal.aborted) {
        yield { type: 'aborted', text: client.text || null, sessionId: input.sessionId, usage: emptyUsage() };
        return;
      }

      const errorMessage = err instanceof Error ? err.message : String(err);
      if (errorMessage.includes('connection closed') && stderr.includes('is not recognized as an internal or external command')) {
        throw new Error(`Failed to start ACP provider command "${command}": ${stderr.trim()}`);
      }

      logger.error({ err, stderr }, 'ACP provider query failed');
      const data = (err as { data?: { details?: unknown } })?.data;
      if (typeof data?.details === 'string') throw new Error(data.details);
      throw err;
    } finally {
      input.abortController?.signal.removeEventListener('abort', abortHandler);
      child.kill();
    }
  }
}

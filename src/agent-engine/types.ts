import type { ProviderConfig } from '../provider.js';

export interface McpStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpHttpConfig {
  type: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
}

/** A configured MCP server: stdio (command-based) or HTTP/SSE (url-based). */
export type McpServerConfig = McpStdioConfig | McpHttpConfig;

export interface AgentEngineUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  totalCostUsd: number;
  didCompact: boolean;
  preCompactTokens: number | null;
  lastCallCacheRead: number;
  lastCallInputTokens: number;
  /**
   * The active model's real context window (tokens), as reported by the SDK in
   * `result.modelUsage[model].contextWindow`. Null when the engine doesn't
   * report one (e.g. ACP providers) — consumers fall back to CONTEXT_LIMIT.
   */
  contextWindow: number | null;
}

export interface AgentEngineProgressEvent {
  type: 'task_started' | 'task_completed' | 'tool_active' | 'plan';
  description: string;
  status?: string;
  kind?: string;
  toolCallId?: string;
  locations?: Array<{ path: string; line?: number | null }>;
  planEntries?: Array<{ content: string; status: string; priority?: string }>;
}

export interface AgentTurnInput {
  prompt: string;
  provider: ProviderConfig;
  sessionId?: string;
  cwd: string;
  model?: string;
  /** Raw provider-specific runtime/mode value selected in the dashboard. */
  runtimeMode?: string;
  /** Raw provider-specific thinking/thought-level value selected in the dashboard. */
  thinkingMode?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  thinking?: { type: 'adaptive' } | { type: 'enabled'; budgetTokens?: number } | { type: 'disabled' };
  /** Claude SDK turn cap. ACP has no portable max-turns request field; ACP callers must also pass an abort timeout. */
  maxTurns?: number;
  permissionMode?: 'default' | 'bypassPermissions' | string;
  allowDangerouslySkipPermissions?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  mcpServers?: Record<string, McpServerConfig>;
  abortController?: AbortController;
  env?: Record<string, string | undefined>;
  settingSources?: string[];
  includePartialMessages?: boolean;
  /**
   * Agent persona (CLAUDE.md) to use as the system prompt. When set, the Claude
   * SDK engine passes it as a plain-string `systemPrompt`, pinning identity and
   * boundaries into the system layer so they are present on every turn and
   * survive compaction. This is the persona alone — no `claude_code` preset is
   * applied (the preset was never part of this runtime). Ignored by engines that
   * don't model a system prompt (e.g. ACP), which must deliver the persona
   * in-band instead.
   */
  systemPrompt?: string;
}

export type AgentEngineEvent =
  | { type: 'session'; sessionId: string; raw?: unknown }
  | { type: 'text_delta'; delta: string; accumulatedText: string; raw?: unknown }
  | { type: 'progress'; progress: AgentEngineProgressEvent; raw?: unknown }
  | { type: 'usage'; usage: AgentEngineUsage; raw?: unknown }
  | { type: 'compact'; preCompactTokens: number | null; trigger?: string; raw?: unknown }
  | { type: 'result'; text: string | null; usage: AgentEngineUsage | null; stopReason?: string; raw?: unknown }
  | { type: 'aborted'; text: string | null; sessionId?: string; usage: AgentEngineUsage | null; raw?: unknown }
  | { type: 'error'; error: unknown; raw?: unknown };

export interface AgentEngine {
  invoke(input: AgentTurnInput): AsyncIterable<AgentEngineEvent>;
}

export function emptyUsage(): AgentEngineUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    totalCostUsd: 0,
    didCompact: false,
    preCompactTokens: null,
    lastCallCacheRead: 0,
    lastCallInputTokens: 0,
    contextWindow: null,
  };
}

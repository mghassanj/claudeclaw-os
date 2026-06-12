# RFC: Agent Provider Engine

## Status

Implemented for current provider paths. Future direct Anthropic SDK backend remains a follow-up.

## Summary

ClaudeClaw now routes provider invocation through `src/agent-engine/`: one turn in,
normalized events out. The shipped engine seam localizes the current Claude Agent SDK
path and all ACP provider paths behind adapters:

- `ClaudeSdkEngineAdapter` wraps `@anthropic-ai/claude-agent-sdk`.
- `AcpEngineAdapter` wraps OpenCode, Gemini CLI, Codex via `codex-acp`, and custom ACP commands.
- `EngineFactory` selects the adapter from `ProviderConfig`.
- `runAgent()` and `runAgentWithRetry()` remain compatibility wrappers over the engine.

The first implementation does **not** replace Claude Code's subprocess model. It creates
the provider seam needed to add a future direct `@anthropic-ai/sdk` backend without
touching Telegram, dashboard, scheduler, mission, war-room, voice, or memory ingestion
callers.

The older direct-SDK design notes below are retained as future-backend context.

## Implemented Interface

The current public engine shape lives in `src/agent-engine/types.ts`:

```typescript
export interface AgentEngine {
  invoke(input: AgentTurnInput): AsyncIterable<AgentEngineEvent>;
}

export interface AgentTurnInput {
  prompt: string;
  provider: ProviderConfig;
  sessionId?: string;
  cwd: string;
  model?: string;
  runtimeMode?: string;
  thinkingMode?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  thinking?: { type: 'adaptive' } | { type: 'enabled'; budgetTokens?: number } | { type: 'disabled' };
  maxTurns?: number;
  permissionMode?: 'default' | 'bypassPermissions' | string;
  allowDangerouslySkipPermissions?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  mcpServers?: Record<string, McpStdioConfig>;
  abortController?: AbortController;
  env?: Record<string, string | undefined>;
  settingSources?: string[];
  includePartialMessages?: boolean;
}

export type AgentEngineEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'text_delta'; delta: string; accumulatedText: string }
  | { type: 'progress'; progress: AgentEngineProgressEvent }
  | { type: 'usage'; usage: AgentEngineUsage }
  | { type: 'compact'; preCompactTokens: number | null; trigger?: string }
  | { type: 'result'; text: string | null; usage: AgentEngineUsage | null }
  | { type: 'aborted'; text: string | null; sessionId?: string; usage: AgentEngineUsage | null }
  | { type: 'error'; error: unknown };
```

## Implemented Provider Flow

```
runAgent / router / gate / warmup / voice bridge / memory ingestion / war-room turn
    │
    ▼
EngineFactory.forProvider(provider)
    │
    ├── claude                 → ClaudeSdkEngineAdapter
    └── opencode/gemini/codex/acp → AcpEngineAdapter
    │
    ▼
AgentEngine.invoke(input)
    │
    ├── session      normalized provider session id
    ├── text_delta   accumulated stream text
    ├── progress     tool, plan, and task progress
    ├── compact      Claude context compaction boundary
    ├── usage        normalized token/cost accounting
    ├── result       final text
    └── aborted      cancellation result
```

ACP command resolution is centralized:

- `opencode` -> `opencode acp`
- `gemini` -> `gemini --acp`
- `codex` -> `codex-acp`
- `acp` -> custom `command` plus `args`

The dashboard also exposes provider configuration through the engine seam:

- `/api/providers/models` lists built-in model choices and accepts provider-specific custom model ids.
- `/api/providers/runtime-options` probes ACP `session/configuration` by starting a no-prompt session and reading advertised `configOptions`.
- Thinking levels are saved as raw provider values, for example Codex `low`, `medium`, `high`, `xhigh`.
- Speed-like modes are shown only when they are actually speed options. ACP access/build/plan modes are not shown in Settings.
- ACP providers are run in full-access mode when they advertise a full-access mode, matching Claude Code's non-interactive `bypassPermissions` behavior.
- Codex defaults to `gpt-5.5` and uses the bundled `@zed-industries/codex-acp` adapter on the local `node_modules/.bin` PATH.

The engine preserves provider-prefixed sessions through the existing `provider.ts`
helpers. Legacy unprefixed Claude sessions remain valid for Claude, while switching
providers starts fresh for the new provider namespace.

---

## Motivation

### 1. Subprocess overhead

Every `runAgent()` call today spawns a `claude` CLI subprocess. On a Mac Mini running
24/7 with scheduled tasks (4x/day mailcheck, dashboard queries), the fork+exec cost
adds 2-5 seconds of startup latency per turn. For quick interactions ("what time is my
next meeting?"), this dominates total response time.

### 2. Per-call cost visibility

The current CLI engine reports token usage via the `result` event, but the numbers are
cumulative across multi-step tool-use turns. The `lastCallInputTokens` /
`lastCallCacheRead` tracking in `agent.ts` is a workaround. With direct API access,
each `messages.create()` call returns exact usage — no heuristics needed.

### 3. Tighter integration with ClaudeClaw internals

The CLI subprocess runs in its own process with its own environment. Passing secrets
requires `env` injection (`sdkEnv` in `agent.ts:117-123`). Reading ClaudeClaw's SQLite
database from within a tool requires the subprocess to know the DB path. With an
in-process engine, tools can directly call `db.ts` functions.

### 4. Testability

The current `runAgent()` is essentially untestable without spawning real CLI processes.
An `SdkEngine` backed by `@anthropic-ai/sdk` can be tested with a mock HTTP client,
enabling unit tests for the tool execution loop, context management, and error handling.

### 5. Foundation for future features

Direct API access enables features that are hard or impossible with the CLI wrapper:
- **Streaming to Telegram**: send partial responses as Claude generates them
- **Custom tool schemas**: define ClaudeClaw-specific tools (e.g., `MemorySearch`,
  `SendTelegram`) without MCP overhead
- **Multi-model routing**: use Haiku for simple queries, Opus for complex ones,
  decided at runtime per-turn rather than per-session
- **Prompt caching control**: explicit cache_control breakpoints for system prompts

---

## Current Implemented Architecture

```
Telegram message
    │
    ▼
bot.ts  handleMessage()
    │
    ├── buildMemoryContext()     → prepends [Memory context] block
    ├── agentSystemPrompt?      → prepends agent CLAUDE.md (for non-main agents)
    │
    ▼
agent.ts  runAgent()
    │
    ├── loads MCP servers and scrubbed provider env
    ├── resolves provider-prefixed session ids
    ├── maps Claude model/effort/thinking options
    ▼
EngineFactory.forProvider(provider)
    │
    ├── ClaudeSdkEngineAdapter
    │   └── @anthropic-ai/claude-agent-sdk query()
    │       └── spawns `claude` CLI subprocess
    │
    └── AcpEngineAdapter
        ├── opencode → `opencode acp`
        ├── gemini   → `gemini --acp`
        ├── codex    → `codex-acp`
        └── acp      → custom command + args
    │
    ▼
Normalized AgentEngineEvent stream:
    ├── session
    ├── text_delta
    ├── progress
    ├── usage
    ├── compact
    ├── result
    └── aborted
```

### Key observations

1. **Provider session management is opaque**: Claude Code and ACP providers manage
   their own session state. ClaudeClaw stores the provider session id string in
   SQLite and prefixes it with the provider type before persistence so switching
   providers starts/resumes the correct provider namespace.

2. **Tool execution remains provider-owned**: ClaudeClaw receives normalized
   progress events but does not execute provider tools itself. Claude Code and
   ACP providers own their tool loops, permissions, and low-level event formats.

3. **Auth is delegated**: Claude Code reads OAuth from `~/.claude/` or uses
   explicit Claude credentials. ACP providers read their own auth/config files.
   ClaudeClaw does not store OpenCode, Gemini, Codex, or custom ACP API keys.

4. **System prompt loading varies by provider**: Claude Code loads CLAUDE.md,
   skills, and MCP settings through the Agent SDK `settingSources` path. ACP
   providers receive cwd, MCP settings, model, thinking, and session config through
   ACP where supported.

---

## Proposed Architecture

```
Telegram message
    │
    ▼
bot.ts  handleMessage()
    │
    ├── buildMemoryContext()
    │
    ▼
agent.ts  runAgent()
    │
    ├── engineFactory(ENGINE config)
    │   ├── ENGINE=cli  →  CliEngine  (current behavior, wraps query())
    │   └── ENGINE=sdk  →  SdkEngine  (new, direct API)
    │
    ▼
engine.invoke(message, options)
    │
    ├── [CliEngine path — unchanged]
    │   └── query() → subprocess → events
    │
    └── [SdkEngine path — new]
        ├── loads system prompt (CLAUDE.md + skills + memory)
        ├── appends user message to session history
        ├── calls Anthropic Messages API directly
        ├── if response contains tool_use blocks:
        │   ├── executes tools in-process
        │   ├── appends tool_results
        │   └── loops (calls API again)
        ├── yields EngineEvents throughout
        └── persists session history to SQLite
```

---

## Design

### Engine Interface

```typescript
// src/engines/engine.ts

export interface EngineOptions {
  /** Session ID to resume, or undefined for new session */
  sessionId?: string;
  /** Working directory for tool execution (Bash, file operations) */
  cwd: string;
  /** System prompt (CLAUDE.md content, memory context, etc.) */
  systemPrompt?: string;
  /** Model to use (e.g., 'claude-opus-4-6', 'claude-sonnet-4-5') */
  model?: string;
  /** AbortController for cancellation */
  abortController?: AbortController;
  /** Environment variables to pass to Bash tool */
  env?: Record<string, string>;
}

export type EngineEvent =
  | { type: 'init'; sessionId: string }
  | { type: 'progress'; tool: string; description: string }
  | { type: 'assistant_text'; text: string }
  | { type: 'compact' }
  | { type: 'result'; text: string; usage: EngineUsageInfo }
  | { type: 'error'; error: Error };

export interface EngineUsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  totalCostUsd: number;
  didCompact: boolean;
  preCompactTokens: number | null;
  lastCallCacheRead: number;
  lastCallInputTokens: number;
}

export interface Engine {
  /**
   * Run a single user message through the engine.
   * Yields events as the engine processes the message (tool use, streaming, etc.).
   * The final event is always 'result' or 'error'.
   */
  invoke(message: string, options: EngineOptions): AsyncIterable<EngineEvent>;
}
```

### CliEngine (wraps current code)

```typescript
// src/engines/cli-engine.ts — ~100 lines

import { query } from '@anthropic-ai/claude-agent-sdk';
import { Engine, EngineEvent, EngineOptions } from './engine.js';

export class CliEngine implements Engine {
  async *invoke(message: string, options: EngineOptions): AsyncIterable<EngineEvent> {
    // Move the current agent.ts query() logic here.
    // The singleTurn() generator, event mapping, and usage tracking
    // all transfer directly.
    //
    // Maps SDK events to EngineEvents:
    //   system/init         → { type: 'init', sessionId }
    //   system/compact      → { type: 'compact' }
    //   tool_progress       → { type: 'progress', tool, description }
    //   assistant           → (internal: track per-call usage)
    //   result              → { type: 'result', text, usage }
  }
}
```

This is a straightforward extraction of the current `runAgent()` body into a class.
The `runAgent()` function in `agent.ts` becomes a thin wrapper that:
1. Selects the engine based on config
2. Sets up the typing interval
3. Iterates over `engine.invoke()` events
4. Returns `AgentResult`

### SdkEngine (new)

```typescript
// src/engines/sdk-engine.ts — ~200 lines (core) + tools

import Anthropic from '@anthropic-ai/sdk';
import { Engine, EngineEvent, EngineOptions, EngineUsageInfo } from './engine.js';
import { SessionStore } from './session-store.js';
import { executeTools } from './tools/index.js';

export class SdkEngine implements Engine {
  private client: Anthropic;
  private sessionStore: SessionStore;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
    this.sessionStore = new SessionStore();
  }

  async *invoke(message: string, options: EngineOptions): AsyncIterable<EngineEvent> {
    // 1. Load or create session
    const session = options.sessionId
      ? this.sessionStore.load(options.sessionId)
      : this.sessionStore.create();

    yield { type: 'init', sessionId: session.id };

    // 2. Build messages array
    session.messages.push({ role: 'user', content: message });

    // 3. Build system prompt
    const systemPrompt = this.buildSystemPrompt(options);

    // 4. Agentic loop
    let totalUsage = { input: 0, output: 0, cacheRead: 0 };
    let lastCallInput = 0;
    let lastCallCacheRead = 0;
    let loopCount = 0;
    const MAX_LOOPS = 25; // safety: prevent infinite tool-use loops

    while (loopCount < MAX_LOOPS) {
      loopCount++;

      const response = await this.client.messages.create({
        model: options.model ?? 'claude-opus-4-6',
        max_tokens: 16384,
        system: systemPrompt,
        messages: session.messages,
        tools: this.getToolDefinitions(),
      });

      // Track usage
      totalUsage.input += response.usage.input_tokens;
      totalUsage.output += response.usage.output_tokens;
      totalUsage.cacheRead += response.usage.cache_read_input_tokens ?? 0;
      lastCallInput = response.usage.input_tokens;
      lastCallCacheRead = response.usage.cache_read_input_tokens ?? 0;

      // Append assistant response to history
      session.messages.push({ role: 'assistant', content: response.content });

      // Check stop reason
      if (response.stop_reason === 'end_turn') {
        // Extract final text
        const textBlocks = response.content.filter(b => b.type === 'text');
        const resultText = textBlocks.map(b => b.text).join('\n');

        // Persist session
        this.sessionStore.save(session);

        yield {
          type: 'result',
          text: resultText,
          usage: {
            inputTokens: totalUsage.input,
            outputTokens: totalUsage.output,
            cacheReadInputTokens: totalUsage.cacheRead,
            totalCostUsd: this.estimateCost(totalUsage, options.model),
            didCompact: false,
            preCompactTokens: null,
            lastCallCacheRead,
            lastCallInputTokens: lastCallInput,
          },
        };
        return;
      }

      if (response.stop_reason === 'tool_use') {
        // Execute tools and collect results
        const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
        const toolResults = [];

        for (const toolUse of toolUseBlocks) {
          yield { type: 'progress', tool: toolUse.name, description: toolUse.name };

          const result = await executeTools(toolUse.name, toolUse.input, {
            cwd: options.cwd,
            env: options.env,
            abortSignal: options.abortController?.signal,
          });

          toolResults.push({
            type: 'tool_result' as const,
            tool_use_id: toolUse.id,
            content: result.output,
            is_error: result.isError,
          });
        }

        // Append tool results to history
        session.messages.push({ role: 'user', content: toolResults });

        // Continue the loop (next API call with tool results)
        continue;
      }

      // Unexpected stop reason
      break;
    }
  }
}
```

### Tool Execution

The SdkEngine needs to implement tool execution for the tools Claude will request.
These are split into tiers based on priority and complexity.

#### Tier 1 — Core (Phase 3, ~200 lines)

| Tool | Implementation | Notes |
|------|---------------|-------|
| **Bash** | `child_process.execFile()` with timeout, cwd, env | Must respect `options.cwd`; timeout 120s default |
| **Read** | `fs.readFileSync()` with line offset/limit | Map line numbers like `cat -n` |
| **Write** | `fs.writeFileSync()` | Create parent dirs if needed |
| **Edit** | String replacement in file | `old_string` → `new_string`, fail if not unique |

```typescript
// src/engines/tools/bash.ts — ~40 lines
import { execFile } from 'child_process';

export async function executeBash(
  input: { command: string; timeout?: number },
  opts: { cwd: string; env?: Record<string, string>; abortSignal?: AbortSignal },
): Promise<{ output: string; isError: boolean }> {
  return new Promise((resolve) => {
    const timeout = input.timeout ?? 120_000;
    const child = execFile(
      '/bin/bash',
      ['-c', input.command],
      { cwd: opts.cwd, env: { ...process.env, ...opts.env }, timeout, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ output: `${stderr}\n${err.message}`.trim(), isError: true });
        } else {
          resolve({ output: stdout + (stderr ? `\n${stderr}` : ''), isError: false });
        }
      },
    );
    opts.abortSignal?.addEventListener('abort', () => child.kill('SIGTERM'));
  });
}
```

#### Tier 2 — Search (Phase 4, ~100 lines)

| Tool | Implementation | Notes |
|------|---------------|-------|
| **Glob** | `node:fs` recursive readdir with minimatch | Or shell out to `find` |
| **Grep** | Shell out to `rg` (ripgrep) | Assume `rg` is installed (it ships with Claude Code) |
| **WebSearch** | HTTP call to search API | Optional; may use a simple provider or skip |
| **WebFetch** | `fetch()` with HTML-to-text | Strip tags, respect timeout |

#### Not supported initially

| Tool | Why deferred |
|------|-------------|
| **Agent** (sub-agents) | Requires recursive engine invocation + task tracking. Major complexity. |
| **MCP tools** (`mcp__*`) | Requires MCP server lifecycle management (start, connect, schema discovery). The CLI handles this automatically. |
| **NotebookEdit** | Niche; Jupyter notebook cell manipulation. Low priority. |
| **AskUserQuestion** | Requires Telegram callback flow. Can be added later. |
| **ToolSearch** | Deferred tool discovery — CLI-specific feature. |

### Tool Schema Definition

The SdkEngine must pass tool schemas to the Anthropic API. These match the Claude Code
tool specifications:

```typescript
// src/engines/tools/schemas.ts

export const TOOL_SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'Bash',
    description: 'Execute a bash command and return its output.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to execute' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default 120000)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'Read',
    description: 'Read a file from the filesystem.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file' },
        offset: { type: 'number', description: 'Line number to start reading from' },
        limit: { type: 'number', description: 'Number of lines to read' },
      },
      required: ['file_path'],
    },
  },
  // ... Write, Edit, Glob, Grep
];
```

### Session Management

The CLI engine manages sessions opaquely — ClaudeClaw only stores the session ID.
The SdkEngine must manage conversation history explicitly.

```typescript
// src/engines/session-store.ts — ~80 lines

import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';

export interface Session {
  id: string;
  messages: Anthropic.MessageParam[];
  createdAt: number;
  updatedAt: number;
}

export class SessionStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    // Uses a separate DB file to avoid schema conflicts with the main claudeclaw.db.
    // Alternatively, could add a table to the main DB.
    this.db = new Database(dbPath ?? 'store/sdk-sessions.db');
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sdk_sessions (
        id         TEXT PRIMARY KEY,
        messages   TEXT NOT NULL,  -- JSON-serialized Anthropic.MessageParam[]
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  create(): Session {
    return {
      id: `sdk-${randomUUID()}`,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  load(sessionId: string): Session {
    const row = this.db
      .prepare('SELECT * FROM sdk_sessions WHERE id = ?')
      .get(sessionId) as { id: string; messages: string; created_at: number; updated_at: number } | undefined;

    if (!row) return this.create(); // session expired or not found — start fresh

    return {
      id: row.id,
      messages: JSON.parse(row.messages),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  save(session: Session): void {
    session.updatedAt = Date.now();
    this.db.prepare(`
      INSERT OR REPLACE INTO sdk_sessions (id, messages, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(session.id, JSON.stringify(session.messages), session.createdAt, session.updatedAt);
  }

  /** Remove sessions older than maxAge (milliseconds). Default: 7 days. */
  prune(maxAge = 7 * 24 * 60 * 60 * 1000): void {
    const cutoff = Date.now() - maxAge;
    this.db.prepare('DELETE FROM sdk_sessions WHERE updated_at < ?').run(cutoff);
  }
}
```

### Context Compaction

The CLI auto-compacts when the context window fills up. The SdkEngine must handle this
explicitly. Strategy:

1. After each API call, check `lastCallInputTokens` against `CONTEXT_LIMIT`.
2. If > 80% full, trigger compaction:
   - Send a special message asking Claude to summarize the conversation so far.
   - Replace the message history with: `[system summary] + last 2 user/assistant pairs`.
   - Yield a `{ type: 'compact' }` event so the bot can warn the user.
3. This is simpler than the CLI's approach but sufficient for personal use.

### System Prompt Construction

The CLI loads CLAUDE.md automatically from `cwd` via `settingSources`. The SdkEngine
must construct the system prompt explicitly:

```typescript
private buildSystemPrompt(options: EngineOptions): string {
  const parts: string[] = [];

  // 1. CLAUDE.md from cwd (same as CLI behavior)
  const claudeMdPath = path.join(options.cwd, 'CLAUDE.md');
  if (fs.existsSync(claudeMdPath)) {
    parts.push(fs.readFileSync(claudeMdPath, 'utf-8'));
  }

  // 2. Agent-specific system prompt (from agentSystemPrompt config)
  if (options.systemPrompt) {
    parts.push(options.systemPrompt);
  }

  // 3. Global user instructions (~/.claude/CLAUDE.md)
  const userClaudeMd = path.join(os.homedir(), '.claude', 'CLAUDE.md');
  if (fs.existsSync(userClaudeMd)) {
    parts.push(fs.readFileSync(userClaudeMd, 'utf-8'));
  }

  // 4. Today's date (Claude Code injects this)
  parts.push(`Current date: ${new Date().toISOString().split('T')[0]}`);

  return parts.join('\n\n---\n\n');
}
```

Note: Skills from `~/.claude/skills/` are NOT loaded automatically. The CLI discovers
and injects skill content based on context. For the SdkEngine, skills would need to be
loaded statically or discovered via a different mechanism. This is an explicit trade-off.

### Configuration

```bash
# .env additions

# Engine backend: "cli" (default, spawns claude subprocess) or "sdk" (direct API)
ENGINE=cli

# Required for ENGINE=sdk (not needed for ENGINE=cli with OAuth)
# ANTHROPIC_API_KEY=sk-ant-...

# Model for SDK engine (CLI uses its own model selection)
# SDK_MODEL=claude-opus-4-6

# Max tool-use loops per turn (safety limit)
# SDK_MAX_TOOL_LOOPS=25
```

```typescript
// Addition to src/config.ts

export const ENGINE = (
  process.env.ENGINE || envConfig.ENGINE || 'cli'
).toLowerCase() as 'cli' | 'sdk';

export const SDK_MODEL =
  process.env.SDK_MODEL || envConfig.SDK_MODEL || 'claude-opus-4-6';

export const SDK_MAX_TOOL_LOOPS = parseInt(
  process.env.SDK_MAX_TOOL_LOOPS || envConfig.SDK_MAX_TOOL_LOOPS || '25',
  10,
);
```

---

## Trade-offs

### Advantages

| # | Advantage | Impact |
|---|-----------|--------|
| 1 | **No subprocess overhead** | 2-5s faster per turn; no fork/exec cost |
| 2 | **Direct API control** | Streaming, prompt caching breakpoints, model routing |
| 3 | **Per-call cost visibility** | Exact token counts from each `messages.create()` |
| 4 | **Testable** | Mock `@anthropic-ai/sdk` in unit tests; test tool loop in isolation |
| 5 | **No CLI binary dependency** | Deploy without `claude` installed; lighter Docker images |
| 6 | **In-process tool access** | Tools can call `db.ts` functions directly, read ClaudeClaw state |

### Disadvantages

| # | Disadvantage | Mitigation |
|---|-------------|------------|
| 1 | **Must implement tool execution loop (~200 lines)** | Well-scoped; each tool is 20-40 lines |
| 2 | **No MCP server support** | Keep CLI engine as default; MCP users stay on CLI |
| 3 | **No automatic skills/CLAUDE.md loading** | Load explicitly in `buildSystemPrompt()` |
| 4 | **Session persistence is our responsibility** | SQLite store; same pattern as existing `sessions` table |
| 5 | **Tool sandbox differs from CLI** | Bash runs as same user (already true for CLI with `bypassPermissions`) |
| 6 | **No sub-agent support** | Sub-agents are a V3 feature used by RC2; can be added in a future phase |
| 7 | **Requires ANTHROPIC_API_KEY** | Cannot use OAuth/Max plan; pay-per-token only |
| 8 | **Context compaction is simpler** | CLI has sophisticated compaction; SDK version is basic but sufficient |

### Risk assessment

**Low risk**: The CLI engine remains the default and is untouched. The SdkEngine is
opt-in via `ENGINE=sdk`. Users who don't set this config see zero behavior change.

**Medium risk**: Tool execution security. The CLI has built-in sandboxing that we bypass
with `permissionMode: 'bypassPermissions'`. The SdkEngine runs tools with the same
privilege level (same user, same filesystem), but without the CLI's safety checks.
Since ClaudeClaw is a personal bot on a trusted machine with `ALLOWED_CHAT_ID` filtering,
this is acceptable. Document the security model clearly.

---

## Implementation Plan

### Phase 1: Engine Interface + CliEngine Wrapper (~100 lines)

**Files:**
- `src/engines/engine.ts` — Interface definitions (`Engine`, `EngineEvent`, `EngineOptions`, `EngineUsageInfo`)
- `src/engines/cli-engine.ts` — Wraps current `agent.ts` `query()` logic in `CliEngine` class
- `src/agent.ts` — Refactor `runAgent()` to use `Engine.invoke()`
- `src/config.ts` — Add `ENGINE` config

**Acceptance criteria:**
- Existing CLI behavior is 100% preserved
- `ENGINE=cli` (default) works identically to current code
- All existing tests pass

### Phase 2: Basic SdkEngine — Text Only (~100 lines)

**Files:**
- `src/engines/sdk-engine.ts` — `SdkEngine` class with `invoke()`, no tool support
- `src/engines/session-store.ts` — SQLite session persistence

**Acceptance criteria:**
- `ENGINE=sdk` with `ANTHROPIC_API_KEY` responds to simple text messages
- Session persistence works (multi-turn conversation)
- Token usage is reported accurately
- No tool use (Claude cannot execute tools yet — it just answers from its training)

### Phase 3: Tool Execution — Core Tools (~200 lines)

**Files:**
- `src/engines/tools/index.ts` — Tool router (`executeTools()`)
- `src/engines/tools/schemas.ts` — Tool schema definitions for the API
- `src/engines/tools/bash.ts` — Bash execution
- `src/engines/tools/read.ts` — File reading with line numbers
- `src/engines/tools/write.ts` — File writing
- `src/engines/tools/edit.ts` — String replacement editing

**Acceptance criteria:**
- Claude can read, write, edit files and run bash commands
- Tool execution loop works (API call → tool_use → execute → tool_result → API call)
- Abort controller cancels in-progress tool execution
- Tool errors are reported back to Claude as `is_error: true`

### Phase 4: Search Tools + Web (~100 lines)

**Files:**
- `src/engines/tools/glob.ts` — File pattern matching
- `src/engines/tools/grep.ts` — Content search (shells out to `rg`)
- `src/engines/tools/web.ts` — WebFetch (HTTP + HTML-to-text)

**Acceptance criteria:**
- Claude can search codebases using Glob and Grep
- Claude can fetch web pages
- Tool schemas match Claude Code's expectations

### Phase 5: Session Persistence + Context Compaction (~100 lines)

**Files:**
- `src/engines/sdk-engine.ts` — Add compaction logic
- `src/engines/session-store.ts` — Add pruning, session metadata

**Acceptance criteria:**
- Sessions survive process restarts
- Old sessions are pruned (7-day default)
- Context compaction triggers at 80% of `CONTEXT_LIMIT`
- Compaction events surface to Telegram as warnings

---

## Files to Create/Modify

### New files

| File | Phase | Lines | Description |
|------|-------|-------|-------------|
| `src/engines/engine.ts` | 1 | ~40 | Interface definitions |
| `src/engines/cli-engine.ts` | 1 | ~100 | Wraps current `query()` logic |
| `src/engines/sdk-engine.ts` | 2-5 | ~250 | Direct API engine |
| `src/engines/session-store.ts` | 2 | ~80 | SQLite session persistence |
| `src/engines/tools/index.ts` | 3 | ~30 | Tool router |
| `src/engines/tools/schemas.ts` | 3 | ~80 | Tool schema definitions |
| `src/engines/tools/bash.ts` | 3 | ~40 | Bash execution |
| `src/engines/tools/read.ts` | 3 | ~30 | File reading |
| `src/engines/tools/write.ts` | 3 | ~20 | File writing |
| `src/engines/tools/edit.ts` | 3 | ~30 | String replacement |
| `src/engines/tools/glob.ts` | 4 | ~30 | File pattern matching |
| `src/engines/tools/grep.ts` | 4 | ~30 | Content search via `rg` |
| `src/engines/tools/web.ts` | 4 | ~40 | WebFetch |

### Modified files

| File | Phase | Changes |
|------|-------|---------|
| `src/agent.ts` | 1 | Refactor `runAgent()` to delegate to `Engine.invoke()` |
| `src/config.ts` | 1 | Add `ENGINE`, `SDK_MODEL`, `SDK_MAX_TOOL_LOOPS` |
| `.env.example` | 1 | Add `ENGINE` option and documentation |
| `package.json` | 2 | Add `@anthropic-ai/sdk` dependency |

### Total: ~600 lines new code, ~50 lines modified

---

## Open Questions

### 1. Should SdkEngine support MCP servers?

**Current lean: No (not in initial implementation).**

MCP support requires: server discovery, process lifecycle management, schema introspection,
and dynamic tool registration. The CLI handles all of this. Adding MCP to SdkEngine
would add ~300-500 lines and significant complexity. Users who need MCP (e.g., Google
Workspace, filesystem tools) should use `ENGINE=cli`.

Future option: support a subset — e.g., MCP servers defined in a ClaudeClaw config file
(not the CLI's settings), started on-demand with a simple lifecycle.

### 2. How to handle tool sandboxing?

**Current lean: Same trust model as CLI with `bypassPermissions`.**

ClaudeClaw already disables the CLI's permission system (`permissionMode: 'bypassPermissions'`).
The SdkEngine would run tools with the same user privileges. Bash commands run as the
ClaudeClaw process user. File operations have full filesystem access.

For safety, the SdkEngine should:
- Enforce `cwd` for relative path resolution
- Timeout Bash commands (120s default)
- Limit Bash output buffer (1MB)
- Respect `AbortController` for cancellation
- Log all tool executions for audit

### 3. Should both engines share the same session format?

**Current lean: No — separate session stores.**

CLI sessions are opaque filesystem-based sessions managed by the `claude` binary.
SDK sessions are JSON-serialized message arrays in SQLite. They are fundamentally
different formats. The `sessions` table in `claudeclaw.db` stores the session ID
for either engine — the ID format distinguishes them (`sdk-` prefix for SdkEngine).

This means `/newchat` works the same way: clear the session ID from the `sessions`
table, and the next message starts fresh regardless of engine.

### 4. How to migrate existing CLI sessions to SDK format?

**Current lean: Don't migrate. Start fresh.**

CLI sessions contain internal state (tool history, compaction markers, etc.) that
doesn't map cleanly to the SDK's message format. When switching `ENGINE=cli` to
`ENGINE=sdk`, existing sessions simply won't be found (different ID prefix), and
a new session starts automatically. The conversation_log in SQLite provides
historical context via the memory system.

### 5. Should we support streaming responses to Telegram during tool execution?

**Current lean: Not in initial implementation. Add in a follow-up.**

Streaming partial text to Telegram while Claude is mid-response would improve UX
for long answers. The Anthropic SDK supports streaming via `client.messages.stream()`.
However, Telegram's `editMessageText` API has rate limits (~30 edits/second) and
the current architecture sends one final message. Streaming would require:
- Accumulating text chunks
- Debounced message edits (every 1-2 seconds)
- Handling tool-use interruptions mid-stream

This is valuable but orthogonal to the engine abstraction. It can be added to
SdkEngine after the base implementation is stable.

### 6. Cost: SdkEngine requires ANTHROPIC_API_KEY

**This is a hard constraint.** The CLI engine can use OAuth (Claude Max plan — included
in subscription, no per-token cost). The SdkEngine calls the API directly and requires
an `ANTHROPIC_API_KEY` with pay-per-token billing.

For users on a Max plan, the CLI engine remains more cost-effective. The SdkEngine
is best suited for:
- Users with API access who want lower latency
- Development/testing environments
- Deployments without the `claude` CLI installed
- Scenarios where MCP is not needed

---

## Alternatives Considered

### 1. SDK-only (drop CLI engine entirely)

**Rejected.** Too risky. The CLI engine provides MCP support, automatic skills loading,
sub-agent orchestration, and battle-tested tool execution. Dropping it would break
existing workflows. The dual-engine approach lets users choose based on their needs.

### 2. HTTP proxy — run CLI as a persistent HTTP server

Run the `claude` CLI in server mode, call it via HTTP from ClaudeClaw.

**Rejected.** The `claude` CLI doesn't have a server mode. We'd need to build a
wrapper that keeps a `claude` process alive and proxies requests — adding complexity
without solving the subprocess problem (we'd still have one long-lived subprocess).

### 3. Plugin/provider system with dynamic registration

Abstract engines, tools, and integrations behind a generic plugin interface.

**Rejected.** Over-engineered for just 2 backends. The `Engine` interface is sufficient
abstraction. If a third backend materializes (e.g., `GeminiEngine`), the interface
is simple enough to extend without a plugin framework.

### 4. Use Claude Agent SDK with custom tool handling

Modify the `query()` call to intercept tool execution and handle it in-process.

**Rejected.** The Claude Agent SDK is designed as a black box — it spawns the subprocess
and handles tool execution internally. There's no hook to intercept tool calls. The
SDK would need upstream changes to support this.

---

## Timeline

| Phase | Scope | Effort | Dependencies |
|-------|-------|--------|-------------|
| Phase 1 | Engine interface + CliEngine | ~2h (1 session) | None |
| Phase 2 | SdkEngine text-only | ~2h (1 session) | Phase 1 |
| Phase 3 | Core tools (Bash, Read, Write, Edit) | ~4h (1-2 sessions) | Phase 2 |
| Phase 4 | Search tools (Glob, Grep, WebFetch) | ~2h (1 session) | Phase 3 |
| Phase 5 | Session persistence + compaction | ~2h (1 session) | Phase 2 |
| Testing + docs | Unit tests, integration test, README update | ~2h (1 session) | Phase 3+ |

**Total: ~14h across 5-7 sessions.**

Phases 1-2 can be merged into the main branch independently (no behavior change for
`ENGINE=cli` users). Phases 3-5 build on each other but each phase produces a usable
(if limited) SdkEngine.

---

## Appendix: Cost Estimation for SdkEngine

For reference, approximate costs at Anthropic API rates (as of early 2026):

| Model | Input (per 1M tokens) | Output (per 1M tokens) | Cache read (per 1M) |
|-------|----------------------|------------------------|---------------------|
| claude-opus-4-6 | $15.00 | $75.00 | $1.50 |
| claude-sonnet-4-5 | $3.00 | $15.00 | $0.30 |
| claude-haiku-4-5 | $0.80 | $4.00 | $0.08 |

A typical ClaudeClaw turn with Opus (200k context, 2k output) costs ~$3.15.
With prompt caching (180k cached + 20k new), it drops to ~$0.57.

The SdkEngine's explicit prompt construction enables aggressive caching: the system
prompt (CLAUDE.md, skills, memory) can be marked with `cache_control` breakpoints,
ensuring it's cached across turns. The CLI does this automatically, but the SdkEngine
can be more precise.

import { query } from '@anthropic-ai/claude-agent-sdk';

import { logger } from '../logger.js';
import type { AgentEngine, AgentEngineEvent, AgentTurnInput } from './types.js';

const TOOL_LABELS: Record<string, string> = {
  Read: 'Reading file',
  Write: 'Writing file',
  Edit: 'Editing file',
  Bash: 'Running command',
  Grep: 'Searching code',
  Glob: 'Finding files',
  WebSearch: 'Web search',
  WebFetch: 'Fetching page',
  Agent: 'Sub-agent',
  NotebookEdit: 'Editing notebook',
  AskUserQuestion: 'User question',
};

function toolLabel(toolName: string): string {
  if (TOOL_LABELS[toolName]) return TOOL_LABELS[toolName];
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    return parts.length >= 3 ? `${parts[1]}: ${parts.slice(2).join(' ')}` : toolName;
  }
  return toolName;
}

/**
 * Pull the active model's real context window from the result's `modelUsage`
 * map (`Record<modelId, { contextWindow }>`). Prefer the requested model's
 * entry; otherwise take the largest window (the primary model dominates any
 * sub-agent models). Returns null when nothing reports a window.
 */
function pickContextWindow(modelUsage: unknown, model: string | undefined): number | null {
  if (!modelUsage || typeof modelUsage !== 'object') return null;
  const entries = Object.entries(modelUsage as Record<string, { contextWindow?: number }>);
  if (model) {
    const exact = (modelUsage as Record<string, { contextWindow?: number }>)[model]?.contextWindow;
    if (typeof exact === 'number' && exact > 0) return exact;
  }
  let max: number | null = null;
  for (const [, v] of entries) {
    if (typeof v?.contextWindow === 'number' && v.contextWindow > 0 && (max === null || v.contextWindow > max)) {
      max = v.contextWindow;
    }
  }
  return max;
}

async function* singleTurn(text: string): AsyncGenerator<{
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}> {
  yield {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    session_id: '',
  };
}

export class ClaudeSdkEngineAdapter implements AgentEngine {
  async *invoke(input: AgentTurnInput): AsyncIterable<AgentEngineEvent> {
    let didCompact = false;
    let preCompactTokens: number | null = null;
    let lastCallCacheRead = 0;
    let lastCallInputTokens = 0;
    let streamedText = '';
    let emittedResult = false;
    // Accumulate every top-level assistant text block across the turn. The SDK's
    // final `result` field only carries the LAST assistant text block, so a turn
    // shaped `text → tool_use → short text` (e.g. "Logged to hive mind.") would
    // truncate to that trailing fragment and drop the real answer. Joining all
    // top-level text blocks reconstructs the full response. Subagent text is
    // excluded (parent_tool_use_id != null) so it never leaks into the reply.
    const turnTextBlocks: string[] = [];

    // SDK 0.3.x requires `allowDangerouslySkipPermissions: true` whenever
    // `permissionMode` is 'bypassPermissions'. Resolve the mode first, then default
    // the flag to true for the bypass path when the caller didn't specify one — this
    // preserves prior bypass behavior and keeps the adapter's own default self-consistent.
    // An explicit `false` from the caller is respected (?? only fills nullish values).
    const permissionMode = input.permissionMode ?? 'bypassPermissions';
    const allowDangerouslySkipPermissions =
      input.allowDangerouslySkipPermissions ??
      (permissionMode === 'bypassPermissions' ? true : undefined);

    try {
      for await (const event of query({
        prompt: singleTurn(input.prompt),
        options: {
          cwd: input.cwd,
          resume: input.sessionId,
          settingSources: input.settingSources ?? ['project', 'user'],
          // Persona-only system prompt (plain string = no claude_code preset).
          // Pins identity/boundaries in the system layer, present every turn and
          // compaction-proof. Omitted when no persona is supplied.
          ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
          permissionMode,
          ...(allowDangerouslySkipPermissions !== undefined
            ? { allowDangerouslySkipPermissions }
            : {}),
          ...(input.maxTurns && input.maxTurns > 0 ? { maxTurns: input.maxTurns } : {}),
          ...(input.env ? { env: input.env } : {}),
          ...(input.mcpServers && Object.keys(input.mcpServers).length ? { mcpServers: input.mcpServers } : {}),
          ...(input.includePartialMessages ? { includePartialMessages: true } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.effort ? { effort: input.effort } : {}),
          ...(input.thinking ? { thinking: input.thinking } : {}),
          ...(input.allowedTools ? { allowedTools: input.allowedTools } : {}),
          ...(input.disallowedTools ? { disallowedTools: input.disallowedTools } : {}),
          ...(input.abortController ? { abortController: input.abortController } : {}),
        } as any,
      })) {
      const ev = event as Record<string, unknown>;

      if (ev.type === 'system' && ev.subtype === 'init' && typeof ev.session_id === 'string') {
        yield { type: 'session', sessionId: ev.session_id, raw: ev };
      }

      if (ev.type === 'system' && ev.subtype === 'compact_boundary') {
        didCompact = true;
        const meta = ev.compact_metadata as { trigger?: string; pre_tokens?: number } | undefined;
        preCompactTokens = meta?.pre_tokens ?? null;
        yield { type: 'compact', preCompactTokens, trigger: meta?.trigger, raw: ev };
      }

      if (ev.type === 'assistant') {
        const msg = ev.message as Record<string, unknown> | undefined;
        const msgUsage = msg?.usage as Record<string, number> | undefined;
        const callCacheRead = msgUsage?.cache_read_input_tokens ?? 0;
        const callInputTokens = msgUsage?.input_tokens ?? 0;
        if (callCacheRead > 0) lastCallCacheRead = callCacheRead;
        if (callInputTokens > 0) lastCallInputTokens = callInputTokens;

        const content = msg?.content as Array<{ type: string; id?: string; name?: string; text?: string }> | undefined;
        if (Array.isArray(content)) {
          // Only collect text from top-level assistant messages; subagent
          // output (parent_tool_use_id set) must not bleed into the reply.
          if (ev.parent_tool_use_id == null) {
            for (const block of content) {
              if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
                turnTextBlocks.push(block.text);
              }
            }
          }
          for (const block of content) {
            if (block.type === 'tool_use' && block.name) {
              yield {
                type: 'progress',
                progress: {
                  type: 'tool_active',
                  description: toolLabel(block.name),
                  toolCallId: block.id,
                },
                raw: ev,
              };
            }
          }
        }
      }

      if (ev.type === 'user') {
        const msg = ev.message as Record<string, unknown> | undefined;
        const content = msg?.content as Array<{ type: string; tool_use_id?: string }> | undefined;
        if (Array.isArray(content) && content.some((block) => block.type === 'tool_result')) {
          yield {
            type: 'progress',
            progress: {
              type: 'task_completed',
              description: 'Tool result',
              toolCallId: content.find((block) => block.type === 'tool_result')?.tool_use_id,
            },
            raw: ev,
          };
        }
      }

      if (ev.type === 'system' && ev.subtype === 'task_started') {
        yield {
          type: 'progress',
          progress: {
            type: 'task_started',
            description: (ev.description as string) ?? 'Sub-agent started',
          },
          raw: ev,
        };
      }

      if (ev.type === 'system' && ev.subtype === 'task_notification') {
        const summary = (ev.summary as string) ?? 'Sub-agent finished';
        const status = (ev.status as string) ?? 'completed';
        yield {
          type: 'progress',
          progress: {
            type: 'task_completed',
            description: status === 'failed' ? `Failed: ${summary}` : summary,
          },
          raw: ev,
        };
      }

      if (ev.type === 'stream_event' && ev.parent_tool_use_id === null) {
        const streamEvent = ev.event as Record<string, unknown> | undefined;
        if (streamEvent?.type === 'message_start') streamedText = '';
        if (streamEvent?.type === 'content_block_delta') {
          const delta = streamEvent.delta as Record<string, unknown> | undefined;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            streamedText += delta.text;
            yield { type: 'text_delta', delta: delta.text, accumulatedText: streamedText, raw: ev };
          }
        }
      }

      if (ev.type === 'result') {
        const evUsage = ev.usage as Record<string, number> | undefined;
        const usage = evUsage ? {
          inputTokens: evUsage.input_tokens ?? 0,
          outputTokens: evUsage.output_tokens ?? 0,
          cacheReadInputTokens: evUsage.cache_read_input_tokens ?? 0,
          totalCostUsd: (ev.total_cost_usd as number) ?? 0,
          didCompact,
          preCompactTokens,
          lastCallCacheRead,
          lastCallInputTokens,
          contextWindow: pickContextWindow(ev.modelUsage, input.model),
        } : null;
        if (usage) yield { type: 'usage', usage, raw: ev };
        // Prefer the full assembled turn text over the SDK's `result` field,
        // which only holds the final assistant text block. Fall back to
        // `ev.result` when no top-level text was captured.
        const assembledText = turnTextBlocks.join('\n\n').trim();
        const sdkResult = (ev.result as string | null | undefined) ?? null;
        yield {
          type: 'result',
          text: assembledText || sdkResult,
          usage,
          stopReason: typeof ev.subtype === 'string' ? ev.subtype : undefined,
          raw: ev,
        };
        emittedResult = true;
      }
      }
    } catch (err) {
      if (emittedResult) {
        logger.warn(
          { err: err instanceof Error ? err.message : err },
          'Claude SDK process errored after final result; keeping completed turn',
        );
        return;
      }
      throw err;
    }
  }
}

/**
 * PreToolUse guard: stops agents from scripting WhatsApp Web (or the
 * WhatsApp service's send routes) directly, which is how the 2026-09-21
 * Nora double-send and unapproved "delete for everyone" happened.
 *
 * Wired as an Agent SDK `hooks.PreToolUse` callback on every Claude SDK
 * engine turn. SDK PreToolUse hooks run before the permission check, so a
 * "deny" holds even under permissionMode 'bypassPermissions' (sdk.d.ts:
 * "PreToolUse hook denies bypass canUseTool").
 *
 * This is a tripwire on the agent's own tool calls, not a sandbox: the
 * gateway (src/outbound.ts) talks to the WhatsApp service from our code,
 * never through an agent tool call, so it is unaffected. The structural
 * fixes are Chrome's --remote-debugging-pipe (no DevTools port) and the
 * WA_API_TOKEN-gated service routes.
 */

export const GUARDED_TOOLS = ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const;

interface GuardRule { re: RegExp; why: string }

const RULES: GuardRule[] = [
  { re: /puppeteer\s*\.\s*connect/i, why: 'attaching to the WhatsApp Web browser' },
  { re: /DevToolsActivePort/i, why: 'locating the WhatsApp Web DevTools port' },
  { re: /remote-debugging/i, why: 'Chrome remote debugging' },
  { re: /WWebJS\s*\.\s*sendMessage/i, why: 'sending through WhatsApp Web internals' },
  { re: /sendRevokeMsgs/i, why: 'revoking WhatsApp messages' },
  { re: /:9334\/(send|revoke)/i, why: 'calling the WhatsApp service send routes directly' },
  { re: /\/api\/outbound\/decide/i, why: 'approving outbound actions (only Mohamed approves)' },
  { re: /WA_API_TOKEN/, why: 'reading the WhatsApp service token' },
  { re: /\b(update|insert\s+into|delete\s+from|replace\s+into)\s+outbound_actions\b/i, why: 'editing the outbound audit log' },
];

export const GUARD_DENY_MESSAGE =
  'Blocked by the outbound guard: agents must not drive WhatsApp Web, the WhatsApp service send routes, or the approval log directly. ' +
  'To message or revoke on Mohamed\'s behalf use `node "$PROJECT_ROOT/dist/outbound-cli.js" propose ...` (he approves on Telegram or with "YES <code>"). ' +
  'To read: `outbound-cli find <name>`, `outbound-cli read <chatId> --since 2h`, and `outbound-cli list` for what was actually sent.';

/** Returns the reason a tool call must be denied, or null to let it through. */
export function checkToolCall(toolName: string, toolInput: unknown): string | null {
  if (!(GUARDED_TOOLS as readonly string[]).includes(toolName)) return null;
  let haystack: string;
  try { haystack = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput ?? ''); } catch { haystack = String(toolInput); }
  // JSON.stringify escapes quotes/newlines; also test the unescaped form.
  const variants = [haystack, haystack.replace(/\\n/g, '\n').replace(/\\"/g, '"')];
  for (const rule of RULES) {
    if (variants.some((v) => rule.re.test(v))) return rule.why;
  }
  return null;
}

type HookOutput = {
  hookSpecificOutput?: { hookEventName: 'PreToolUse'; permissionDecision: 'deny'; permissionDecisionReason: string };
};

export async function outboundGuardHook(input: unknown): Promise<HookOutput> {
  const i = input as { hook_event_name?: string; tool_name?: string; tool_input?: unknown };
  if (i?.hook_event_name !== 'PreToolUse' || !i.tool_name) return {};
  const why = checkToolCall(i.tool_name, i.tool_input);
  if (!why) return {};
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `${GUARD_DENY_MESSAGE} (matched: ${why})`,
    },
  };
}

/** `hooks` option for the Agent SDK query(). */
export function outboundGuardHooks(): Record<string, Array<{ matcher?: string; hooks: Array<(input: unknown) => Promise<HookOutput>> }>> {
  return { PreToolUse: [{ matcher: GUARDED_TOOLS.join('|'), hooks: [outboundGuardHook] }] };
}

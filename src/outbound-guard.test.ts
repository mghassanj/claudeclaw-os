import { describe, it, expect } from 'vitest';

import { checkToolCall, outboundGuardHook, outboundGuardHooks } from './outbound-guard.js';
import { withOutboundGuard } from './agent-engine/claude-sdk-adapter.js';

describe('outbound guard', () => {
  it.each([
    ['Bash', { command: 'node -e "const b = await puppeteer.connect({browserURL})"' }],
    ['Bash', { command: 'cat ~/.wwebjs_auth/session/DevToolsActivePort' }],
    ['Bash', { command: 'google-chrome --remote-debugging-port=9222' }],
    ['Write', { file_path: '/tmp/send-nora.mjs', content: 'await page.evaluate(() => window.WWebJS.sendMessage(chat, "hi"))' }],
    ['Edit', { file_path: '/tmp/x.mjs', old_string: 'a', new_string: 'Msg.sendRevokeMsgs(chat, [m])' }],
    ['Bash', { command: 'curl -s -X POST http://127.0.0.1:9334/send-as-me -d @x.json' }],
    ['Bash', { command: 'curl localhost:9334/send -d \'{"chatId":"x"}\'' }],
    ['Bash', { command: 'curl "http://127.0.0.1:3141/api/outbound/decide?token=$T" -d \'{"code":"AB12"}\'' }],
    ['Bash', { command: 'grep WA_API_TOKEN /home/ubuntu/claudeclaw-os/.env' }],
    ['Bash', { command: 'sqlite3 store/claudeclaw.db "UPDATE outbound_actions SET status=\'approved\'"' }],
    ['MultiEdit', { edits: [{ new_string: 'puppeteer.connect(' }] }],
  ])('denies %s %j', (tool, input) => {
    expect(checkToolCall(tool, input)).not.toBeNull();
  });

  it.each([
    ['Bash', { command: 'node "$PROJECT_ROOT/dist/outbound-cli.js" propose wa --to "Nora" --text "Hi"' }],
    ['Bash', { command: 'node dist/outbound-cli.js list --limit 5' }],
    ['Bash', { command: 'sqlite3 store/claudeclaw.db "SELECT * FROM outbound_actions"' }],
    ['Bash', { command: 'curl -s http://127.0.0.1:9334/health' }],
    ['Read', { file_path: '/home/ubuntu/.wwebjs_auth/session/DevToolsActivePort' }],
    ['Grep', { pattern: 'puppeteer.connect' }],
  ])('allows %s %j', (tool, input) => {
    expect(checkToolCall(tool, input)).toBeNull();
  });

  it('returns an SDK PreToolUse deny decision pointing at outbound-cli', async () => {
    const out = await outboundGuardHook({
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'cat DevToolsActivePort' }, tool_use_id: 't1',
    });
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('outbound-cli.js" propose');
    expect(await outboundGuardHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } })).toEqual({});
    expect(await outboundGuardHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'cat DevToolsActivePort' } })).toEqual({});
  });

  it('is always merged into the SDK hooks, ahead of caller hooks', () => {
    const extra = { PreToolUse: [{ hooks: [async () => ({})] }], Stop: [{ hooks: [async () => ({})] }] };
    const merged = withOutboundGuard(extra);
    expect(merged.PreToolUse).toHaveLength(2);
    expect(merged.PreToolUse[0].matcher).toBe('Bash|Write|Edit|MultiEdit|NotebookEdit');
    expect(merged.Stop).toHaveLength(1);
    expect(withOutboundGuard(undefined)).toEqual(outboundGuardHooks());
  });
});

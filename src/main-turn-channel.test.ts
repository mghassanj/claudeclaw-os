import fs from 'fs';

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { uploadsDir } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require('path') as typeof import('path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeOs = require('os') as typeof import('os');
  return { uploadsDir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'main-turn-uploads-')) };
});

vi.mock('./agent.js', () => ({ runAgentWithRetry: vi.fn() }));
vi.mock('./config.js', () => ({
  ALLOWED_CHAT_ID: 'chat-main',
  MODEL_FALLBACK_CHAIN: [],
  agentMcpAllowlist: undefined,
  AGENT_TIMEOUT_MS: 60_000,
  EXFILTRATION_GUARD_ENABLED: true,
  PROTECTED_ENV_VARS: ['MAIN_TURN_TEST_SECRET'],
}));
vi.mock('./active-provider.js', () => ({ getSelectedProviderConfig: () => ({ type: 'claude' }) }));
vi.mock('./db.js', () => ({ getSession: vi.fn(), setSession: vi.fn() }));
vi.mock('./memory.js', () => ({
  buildMemoryContext: vi.fn(),
  evaluateMemoryRelevance: vi.fn(() => Promise.resolve()),
  saveConversationTurn: vi.fn(),
}));
vi.mock('./logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./state.js', () => ({ emitChatEvent: vi.fn(), setActiveAbort: vi.fn() }));
vi.mock('./media.js', () => ({
  UPLOADS_DIR: uploadsDir,
  buildPhotoMessage: (p: string, caption?: string) => `Photo received. File saved at: ${p}${caption ? `\nCaption: "${caption}"` : ''}`,
}));
vi.mock('./session-handoff.js', () => ({
  runWithTurnContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
  takePendingHandoff: vi.fn(() => ''),
}));

import { runAgentWithRetry } from './agent.js';
import { getSession, setSession } from './db.js';
import { buildMemoryContext, evaluateMemoryRelevance, saveConversationTurn } from './memory.js';
import { emitChatEvent } from './state.js';
import { runWithTurnContext, takePendingHandoff } from './session-handoff.js';
import { buildChannelTag, pickBridgeText, redactReply, runMainTurn } from './main-turn.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const m = <T>(fn: T) => fn as any;

describe('buildChannelTag', () => {
  it('renders a compact tag', () => {
    expect(buildChannelTag({ channel: 'whatsapp-self', lang: 'ar', inboundType: 'voice' }))
      .toBe('[Channel: WhatsApp self-chat | lang: ar | voice note]');
    expect(buildChannelTag({ channel: 'whatsapp-self', lang: 'unknown', inboundType: 'text' }))
      .toBe('[Channel: WhatsApp self-chat]');
    expect(buildChannelTag({ channel: 'whatsapp-self', inboundType: 'image' }))
      .toBe('[Channel: WhatsApp self-chat | image]');
    expect(buildChannelTag({})).toBe('');
  });
});

describe('pickBridgeText', () => {
  it('prefers the final answer over narrated full text', () => {
    expect(pickBridgeText({ text: 'Let me check…\n\nYou are free at 3pm.', finalText: 'You are free at 3pm.' }))
      .toBe('You are free at 3pm.');
  });
  it('falls back to the full text, then "Done."', () => {
    expect(pickBridgeText({ text: 'full', finalText: null })).toBe('full');
    expect(pickBridgeText({ text: 'full', finalText: '   ' })).toBe('full');
    expect(pickBridgeText({ text: null })).toBe('Done.');
  });
});

describe('redactReply', () => {
  it('applies the Telegram guard: known key shapes and encoded protected env values', () => {
    process.env.MAIN_TURN_TEST_SECRET = 'super-secret-value-123';
    const b64 = Buffer.from('super-secret-value-123').toString('base64');
    const out = redactReply(`key: ${b64} and sk-ant-abcdefghijklmnopqrstuvwxyz0123`);
    expect(out).not.toContain(b64);
    expect(out).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz0123');
    expect(out).toContain('[REDACTED]');
  });
  it('leaves normal Arabic text alone', () => {
    expect(redactReply('تم إرسال الرسالة ✅')).toBe('تم إرسال الرسالة ✅');
  });
});

describe('runMainTurn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m(getSession).mockReturnValue('claude:sess-1');
    m(buildMemoryContext).mockResolvedValue({
      contextText: '[Memory context]\n- fact',
      surfacedMemoryIds: [7],
      surfacedMemorySummaries: new Map([[7, 'fact']]),
    });
    m(runAgentWithRetry).mockResolvedValue({
      text: 'Let me look…\n\nHere is the report.\n[SEND_FILE:/tmp/r.pdf|Report]',
      finalText: 'Here is the report.\n[SEND_FILE:/tmp/r.pdf|Report]',
      newSessionId: 'claude:sess-2',
      usage: null,
    });
  });

  it('tags the prompt, returns only the final answer, extracts files, and records the turn', async () => {
    const reply = await runMainTurn('[Voice transcribed]: send me the report', {
      channel: 'whatsapp-self', lang: 'en', inboundType: 'voice',
    });

    const prompt = m(runAgentWithRetry).mock.calls[0][0] as string;
    expect(prompt).toBe('[Memory context]\n- fact\n\n[Channel: WhatsApp self-chat | lang: en | voice note]\n[Voice transcribed]: send me the report');
    expect(m(runAgentWithRetry).mock.calls[0][1]).toBe('claude:sess-1');
    expect(m(runWithTurnContext).mock.calls[0][0]).toEqual({ chatId: 'chat-main', agentId: 'main' });

    expect(reply).toEqual({ text: 'Here is the report.', files: [{ type: 'document', filePath: '/tmp/r.pdf', caption: 'Report' }] });
    expect(setSession).toHaveBeenCalledWith('chat-main', 'claude:sess-2', 'main');

    expect(saveConversationTurn).toHaveBeenCalledWith(
      'chat-main', '[Voice transcribed]: send me the report',
      'Here is the report.\n[SEND_FILE:/tmp/r.pdf|Report]', 'claude:sess-2', 'main',
    );
    expect(evaluateMemoryRelevance).toHaveBeenCalledTimes(1);
    expect(m(emitChatEvent).mock.calls.map((c: unknown[]) => (c[0] as { type: string; source: string }))).toEqual([
      expect.objectContaining({ type: 'user_message', source: 'whatsapp' }),
      expect.objectContaining({ type: 'assistant_message', source: 'whatsapp' }),
    ]);
    expect(takePendingHandoff).not.toHaveBeenCalled(); // resumed session
  });

  it('redacts secrets before logging and returning', async () => {
    const key = 'sk-ant-abcdefghijklmnopqrstuvwxyz0123';
    m(runAgentWithRetry).mockResolvedValue({ text: `token ${key}`, newSessionId: undefined, usage: null });
    const reply = await runMainTurn('show token', { channel: 'whatsapp-self' });
    expect(reply.text).toBe('token [REDACTED]');
    expect(m(saveConversationTurn).mock.calls[0][2]).not.toContain(key);
  });

  it('injects a pending /newchat handoff on a fresh session', async () => {
    m(getSession).mockReturnValue(undefined);
    m(takePendingHandoff).mockReturnValue('[Session handoff: x]');
    await runMainTurn('hi');
    expect(takePendingHandoff).toHaveBeenCalledWith('chat-main', 'main');
    expect((m(runAgentWithRetry).mock.calls[0][0] as string).startsWith('[Session handoff: x]\n\n[Memory context]')).toBe(true);
  });

  it('works without metadata (old bridge) and without a channel tag', async () => {
    await runMainTurn('plain');
    expect(m(runAgentWithRetry).mock.calls[0][0]).toBe('[Memory context]\n- fact\n\nplain');
  });

  it('stages a bridged image and sends the Photo received prompt', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
    await runMainTurn('what is this?', { channel: 'whatsapp-self', inboundType: 'image', image: { base64: png, mime: 'image/png' } });
    const prompt = m(runAgentWithRetry).mock.calls[0][0] as string;
    const saved = prompt.match(/File saved at: (\S+)/)?.[1];
    expect(saved).toBeDefined();
    expect(saved!.startsWith(uploadsDir)).toBe(true);
    expect(saved!.endsWith('.png')).toBe(true);
    expect(fs.readFileSync(saved!).toString('hex')).toBe('89504e470d0a1a0a');
    expect(prompt).toContain('Caption: "what is this?"');
    expect(prompt).toContain('[Channel: WhatsApp self-chat | image]');
  });
});

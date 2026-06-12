import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

import { runAcpAgent } from './acp-runner.js';
import { AcpEngineAdapter, inspectAcpProviderRuntimeOptions } from './agent-engine/acp-adapter.js';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeFakeAcpAgent(mode: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeclaw-acp-test-'));
  tmpDirs.push(dir);
  const acpUrl = pathToFileURL(path.join(process.cwd(), 'node_modules', '@agentclientprotocol', 'sdk', 'dist', 'acp.js')).href;
  const script = path.join(dir, 'fake-acp-agent.mjs');
  fs.writeFileSync(script, `
import { Readable, Writable } from 'node:stream';
import * as acp from ${JSON.stringify(acpUrl)};

class FakeAgent {
  constructor(conn) { this.conn = conn; this.sessions = new Set(); this.pending = new Map(); }
  async initialize() {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: ${mode === 'noresume' ? '{ loadSession: false }' : '{ loadSession: false, session: { resume: true } }'},
    };
  }
  async newSession(params) {
    const id = 'sess-' + ${JSON.stringify(mode)};
    this.sessions.add(id);
    this.mcpServers = params.mcpServers || [];
    if (${JSON.stringify(mode)} === 'config') {
      return {
        sessionId: id,
        configOptions: [
          { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'normal', options: [{ value: 'fast', name: 'Fast' }, { value: 'normal', name: 'Normal' }, { value: 'deep', name: 'Deep' }] },
          { id: 'thought', name: 'Thinking', category: 'thought_level', type: 'select', currentValue: 'medium', options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }, { value: 'xhigh', name: 'Extra high' }] },
        ],
      };
    }
    if (${JSON.stringify(mode)} === 'access') {
      return {
        sessionId: id,
        configOptions: [
          { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'auto', options: [{ value: 'read-only', name: 'Read only' }, { value: 'auto', name: 'Auto' }, { value: 'full-access', name: 'Full access' }] },
          { id: 'thought', name: 'Thinking', category: 'thought_level', type: 'select', currentValue: 'medium', options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }, { value: 'xhigh', name: 'Extra high' }] },
        ],
      };
    }
    return { sessionId: id };
  }
  async resumeSession(params) { this.sessions.add(params.sessionId); this.mcpServers = params.mcpServers || []; return {}; }
  async authenticate() { return {}; }
  async setSessionMode() { return {}; }
  async setSessionConfigOption(params) {
    if (params.configId === 'mode') this.currentMode = params.value;
    if (params.configId === 'thought') this.currentThought = params.value;
    return { configOptions: [] };
  }
  async unstable_setSessionModel(params) { this.currentModel = params.modelId; return {}; }
  async prompt(params) {
    if (${JSON.stringify(mode)} === 'error') throw new Error('fake acp failure');
    if (${JSON.stringify(mode)} === 'abort') {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 1000);
        this.pending.set(params.sessionId, () => { clearTimeout(t); resolve(); });
      });
      return { stopReason: 'cancelled' };
    }
    if (${JSON.stringify(mode)} === 'model') {
      await this.conn.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: this.currentModel || 'no-model' } } });
      return { stopReason: 'end_turn' };
    }
    if (${JSON.stringify(mode)} === 'config') {
      await this.conn.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: (this.currentMode || 'no-mode') + '/' + (this.currentThought || 'no-thought') } } });
      return { stopReason: 'end_turn' };
    }
    if (${JSON.stringify(mode)} === 'access') {
      await this.conn.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: this.currentMode || 'no-mode' } } });
      return { stopReason: 'end_turn' };
    }
    if (${JSON.stringify(mode)} === 'mcp') {
      await this.conn.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(this.mcpServers || []) } } });
      return { stopReason: 'end_turn' };
    }
    if (${JSON.stringify(mode)} === 'permission') {
      const response = await this.conn.requestPermission({
        sessionId: params.sessionId,
        toolCall: { toolCallId: 'tool-exec', title: 'Run shell command', kind: 'execute', status: 'pending' },
        options: [
          { kind: 'allow_once', name: 'Allow', optionId: 'allow' },
          { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
        ],
      });
      const outcome = response.outcome.outcome === 'selected' ? response.outcome.optionId : response.outcome.outcome;
      await this.conn.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: outcome } } });
      return { stopReason: 'end_turn' };
    }
    if (${JSON.stringify(mode)} === 'env') {
      await this.conn.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: process.env.OPENAI_API_KEY || 'no-key' } } });
      return { stopReason: 'end_turn' };
    }
    if (${JSON.stringify(mode)} === 'env-windows') {
      await this.conn.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: (process.env.APPDATA || 'no-appdata') + '|' + (process.env.OPENAI_API_KEY || 'no-key') } } });
      return { stopReason: 'end_turn' };
    }
    await this.conn.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello ' } } });
    await this.conn.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: 'plan', entries: [{ content: 'Inspect project', priority: 'high', status: 'in_progress' }] } });
    await this.conn.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Reading files', kind: 'read', status: 'pending', locations: [{ path: 'README.md', line: 12 }] } });
    await this.conn.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', title: 'Reading files', status: 'completed' } });
    await this.conn.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } } });
    return { stopReason: 'end_turn' };
  }
  async cancel(params) { const done = this.pending.get(params.sessionId); if (done) done(); }
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new acp.AgentSideConnection((conn) => new FakeAgent(conn), stream);
`, 'utf-8');
  return script;
}

function writeFakeOpenCode(mode: string): { oldPath: string } {
  return writeFakePresetCommand('opencode', ['acp'], mode);
}

function writeFakePresetCommand(command: string, expectedArgs: string[], mode: string): { oldPath: string } {
  const isWindows = process.platform === 'win32';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeclaw-opencode-test-'));
  tmpDirs.push(dir);
  const agentScript = writeFakeAcpAgent(mode);
  const bin = path.join(dir, isWindows ? `${command}.cmd` : command);
  
  if (isWindows) {
    const argChecks = expectedArgs
      .map((arg, idx) => `if not "%${idx + 1}%" == "${arg}" exit /b 42`)
      .join('\n');
    const arityCheck = `if not "%${expectedArgs.length + 1}%" == "" if not "%${expectedArgs.length}%" == "" (if not "%${expectedArgs.length + 1}%" == "" exit /b 42)`;
    // Simpler arity check for cmd
    const content = [
      '@echo off',
      argChecks,
      `"${process.execPath}" "${agentScript}" %*`,
    ].join('\r\n');
    fs.writeFileSync(bin, content, 'utf-8');
  } else {
    const argAssertions = expectedArgs
      .map((arg, idx) => `test "$${idx + 1}" = ${JSON.stringify(arg)} || exit 42`)
      .join('\n');
    const arityAssertion = `test "$#" = "${expectedArgs.length}" || exit 42`;
    fs.writeFileSync(bin, [
      '#!/usr/bin/env sh',
      arityAssertion,
      argAssertions,
      `exec "${process.execPath}" "${agentScript}"`,
      '',
    ].join('\n'), 'utf-8');
    fs.chmodSync(bin, 0o755);
  }
  
  const oldPath = process.env.PATH ?? '';
  process.env.PATH = `${dir}${path.delimiter}${oldPath}`;
  return { oldPath };
}

describe('runAcpAgent', () => {
  it('initializes, streams text, reports progress, and returns result', async () => {
    const script = writeFakeAcpAgent('ok');
    const streamed: string[] = [];
    const progress: Array<{ description: string; type: string; status?: string; path?: string }> = [];

    const result = await runAcpAgent(
      { type: 'acp', command: process.execPath, args: [script] },
      'hi',
      undefined,
      (event) => progress.push({
        description: event.description,
        type: event.type,
        status: event.status,
        path: event.locations?.[0]?.path,
      }),
      undefined,
      (text) => streamed.push(text),
    );

    expect(result.text).toBe('hello world');
    expect(result.newSessionId).toBe('sess-ok');
    expect(result.usage?.inputTokens).toBe(0);
    expect(streamed).toEqual(['hello ', 'hello world']);
    expect(progress).toContainEqual(expect.objectContaining({
      description: 'Inspect project',
      type: 'plan',
      status: 'in_progress',
    }));
    expect(progress).toContainEqual(expect.objectContaining({
      description: 'Reading files',
      type: 'tool_active',
      status: 'pending',
      path: 'README.md',
    }));
    expect(progress).toContainEqual(expect.objectContaining({
      description: 'Reading files',
      type: 'tool_active',
      status: 'completed',
    }));
  });

  it('resumes an existing ACP session id', async () => {
    const script = writeFakeAcpAgent('ok');
    const result = await runAcpAgent(
      { type: 'acp', command: process.execPath, args: [script] },
      'hi',
      'existing-session',
    );

    expect(result.newSessionId).toBe('existing-session');
    expect(result.text).toBe('hello world');
  });

  it('starts a new session when the provider does not support resume', async () => {
    const script = writeFakeAcpAgent('noresume');
    const result = await runAcpAgent(
      { type: 'acp', command: process.execPath, args: [script] },
      'hi',
      'existing-session',
    );

    expect(result.newSessionId).toBe('sess-noresume');
    expect(result.text).toBe('hello world');
  });

  it('launches OpenCode through the opencode acp preset', async () => {
    const { oldPath } = writeFakeOpenCode('ok');
    try {
      const result = await runAcpAgent({ type: 'opencode' }, 'hi', undefined);
      expect(result.newSessionId).toBe('sess-ok');
      expect(result.text).toBe('hello world');
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it('launches Gemini through the gemini --acp preset', async () => {
    const { oldPath } = writeFakePresetCommand('gemini', ['--acp'], 'ok');
    try {
      const result = await runAcpAgent({ type: 'gemini' }, 'hi', undefined);
      expect(result.newSessionId).toBe('sess-ok');
      expect(result.text).toBe('hello world');
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it('launches Codex through the codex-acp adapter preset', async () => {
    const { oldPath } = writeFakePresetCommand('codex-acp', [], 'ok');
    try {
      const result = await runAcpAgent({ type: 'codex' }, 'hi', undefined);
      expect(result.newSessionId).toBe('sess-ok');
      expect(result.text).toBe('hello world');
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it('sets ACP session model when provider model is configured', async () => {
    const script = writeFakeAcpAgent('model');
    const result = await runAcpAgent(
      { type: 'acp', command: process.execPath, args: [script], model: 'fake-model-1' },
      'hi',
      undefined,
    );

    expect(result.text).toBe('fake-model-1');
  });

  it('sets ACP runtime and thinking config when advertised', async () => {
    const script = writeFakeAcpAgent('config');
    const result = await runAcpAgent(
      { type: 'acp', command: process.execPath, args: [script], runtimeMode: 'deep', thinkingMode: 'xhigh' },
      'hi',
      undefined,
    );

    expect(result.text).toBe('deep/xhigh');
  });

  it('inspects ACP provider runtime and thinking options', async () => {
    const script = writeFakeAcpAgent('config');
    const result = await inspectAcpProviderRuntimeOptions(
      { type: 'acp', command: process.execPath, args: [script] },
      process.cwd(),
      2000,
    );

    expect(result.source).toBe('provider');
    expect(result.modeOptions).toContainEqual(expect.objectContaining({ id: 'deep', label: 'Deep' }));
    expect(result.thinkingOptions).toContainEqual(expect.objectContaining({ id: 'xhigh', label: 'Extra high' }));
  });

  it('does not expose access modes as speed options and forces full access when opted in', async () => {
    const script = writeFakeAcpAgent('access');
    const inspected = await inspectAcpProviderRuntimeOptions(
      { type: 'acp', command: process.execPath, args: [script] },
      process.cwd(),
      2000,
    );
    expect(inspected.modeOptions).toEqual([]);
    expect(inspected.thinkingOptions).toContainEqual(expect.objectContaining({ id: 'xhigh' }));

    const result = await runAcpAgent(
      { type: 'acp', command: process.execPath, args: [script], dangerouslySkipPermissions: true },
      'hi',
      undefined,
    );
    expect(result.text).toBe('full-access');
  });

  it('does not force full-access mode when provider has not opted in', async () => {
    const script = writeFakeAcpAgent('access');
    const result = await runAcpAgent(
      { type: 'acp', command: process.execPath, args: [script] },
      'hi',
      undefined,
    );
    expect(result.text).toBe('no-mode');
  });

  it('forwards toolPolicy allowedTools/disallowedTools to the ACP engine', async () => {
    const script = writeFakeAcpAgent('permission');
    const reject = await runAcpAgent(
      { type: 'acp', command: process.execPath, args: [script] },
      'hi',
      undefined,
      undefined,
      undefined,
      undefined,
      { allowedTools: [], disallowedTools: ['*'] },
    );
    expect(reject.text).toBe('reject');

    const allow = await runAcpAgent(
      { type: 'acp', command: process.execPath, args: [script] },
      'hi',
      undefined,
      undefined,
      undefined,
      undefined,
      { allowedTools: ['Bash'], disallowedTools: ['*'] },
    );
    expect(allow.text).toBe('allow');
  });

  it('passes MCP servers to ACP sessions', async () => {
    const script = writeFakeAcpAgent('mcp');
    const events = [];
    for await (const event of new AcpEngineAdapter().invoke({
      prompt: 'hi',
      provider: { type: 'acp', command: process.execPath, args: [script] },
      cwd: process.cwd(),
      mcpServers: {
        notes: {
          command: 'notes-mcp',
          args: ['--stdio'],
          env: { NOTES_TOKEN: 'token-1' },
        },
      },
    })) {
      events.push(event);
    }
    const result = events.find((event) => event.type === 'result');
    expect(result?.type).toBe('result');
    expect(JSON.parse(result?.type === 'result' ? result.text ?? '[]' : '[]')).toEqual([
      {
        name: 'notes',
        command: 'notes-mcp',
        args: ['--stdio'],
        env: [{ name: 'NOTES_TOKEN', value: 'token-1' }],
      },
    ]);
  });

  it('enforces ACP tool policy permission requests', async () => {
    const script = writeFakeAcpAgent('permission');
    const collectText = async (allowedTools: string[], disallowedTools: string[]) => {
      let text: string | null = null;
      for await (const event of new AcpEngineAdapter().invoke({
        prompt: 'hi',
        provider: { type: 'acp', command: process.execPath, args: [script] },
        cwd: process.cwd(),
        allowedTools,
        disallowedTools,
      })) {
        if (event.type === 'result') text = event.text;
      }
      return text;
    };

    await expect(collectText([], ['*'])).resolves.toBe('reject');
    await expect(collectText(['Bash'], ['*'])).resolves.toBe('allow');
  });

  it('does not leak parent secret env vars into ACP children by default', async () => {
    const script = writeFakeAcpAgent('env');
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'parent-secret';
    try {
      const result = await runAcpAgent(
        { type: 'acp', command: process.execPath, args: [script] },
        'hi',
        undefined,
      );
      expect(result.text).toBe('no-key');
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it('preserves non-secret Windows env vars while scrubbing secrets', async () => {
    const script = writeFakeAcpAgent('env-windows');
    const previousAppData = process.env.APPDATA;
    const previousOpenAi = process.env.OPENAI_API_KEY;
    process.env.APPDATA = 'C:\\Users\\test\\AppData\\Roaming';
    process.env.OPENAI_API_KEY = 'parent-secret';
    try {
      const result = await runAcpAgent(
        { type: 'acp', command: process.execPath, args: [script] },
        'hi',
        undefined,
      );
      expect(result.text).toBe('C:\\Users\\test\\AppData\\Roaming|no-key');
    } finally {
      if (previousAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = previousAppData;
      if (previousOpenAi === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAi;
    }
  });

  it('does not force ACP full-access mode for locked-down calls', async () => {
    const script = writeFakeAcpAgent('access');
    let text: string | null = null;
    for await (const event of new AcpEngineAdapter().invoke({
      prompt: 'hi',
      provider: { type: 'acp', command: process.execPath, args: [script] },
      cwd: process.cwd(),
      allowDangerouslySkipPermissions: true,
      allowedTools: [],
      disallowedTools: ['*'],
    })) {
      if (event.type === 'result') text = event.text;
    }

    expect(text).toBe('no-mode');
  });

  it('surfaces ACP errors', async () => {
    const script = writeFakeAcpAgent('error');
    await expect(runAcpAgent(
      { type: 'acp', command: process.execPath, args: [script] },
      'hi',
      undefined,
    )).rejects.toThrow(/fake acp failure/);
  });

  it('rejects cleanly when the ACP command is missing', async () => {
    await expect(runAcpAgent(
      { type: 'acp', command: 'claudeclaw-missing-acp-command' },
      'hi',
      undefined,
    )).rejects.toThrow(/Failed to start ACP provider command/);
  });

  it('returns aborted when cancelled', async () => {
    const script = writeFakeAcpAgent('abort');
    const ctrl = new AbortController();
    const promise = runAcpAgent(
      { type: 'acp', command: process.execPath, args: [script] },
      'hi',
      'abort-session',
      undefined,
      ctrl,
    );
    setTimeout(() => ctrl.abort(), 50);
    const result = await promise;
    expect(result.aborted).toBe(true);
  });
});

/**
 * Agent Voice Bridge
 *
 * Lightweight CLI script that the War Room Pipecat server calls to invoke
 * a ClaudeClaw agent via the Claude Code SDK and return the text response.
 *
 * Usage: node dist/agent-voice-bridge.js --agent research --message "What did you find?"
 *
 * Outputs JSON to stdout: {"response": "...", "usage": {...}, "error": null}
 *
 * The Pipecat server spawns this as a subprocess for each agent turn,
 * reads the JSON response, and pipes the text to TTS.
 */

import fs from 'fs';
import yaml from 'js-yaml';
import { readEnvFile } from './env.js';
import { initDatabase, getSession, setSession } from './db.js';
import { buildMemoryContext } from './memory.js';
import { getScrubbedSdkEnv } from './security.js';
import { requireEnabled, KillSwitchDisabledError } from './kill-switches.js';
import { loadMcpServers } from './agent.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { EngineFactory } from './agent-engine/index.js';
import { defaultModelForProvider } from './active-provider.js';
import {
  decodeProviderSession,
  encodeProviderSession,
  getMainProviderConfig,
  sessionBelongsToProvider,
} from './provider.js';

// The voice bridge is a standalone subprocess — initialize the DB
// connection before any getSession/setSession calls run. Without this,
// db is undefined and every call fails with "Cannot read properties of
// undefined (reading 'prepare')".
initDatabase();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Parse CLI args
const args = process.argv.slice(2);
let agentId = 'main';
let message = '';
let chatId = 'warroom';
let quickMode = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--agent' && args[i + 1]) {
    agentId = args[++i];
  } else if (args[i] === '--message' && args[i + 1]) {
    message = args[++i];
  } else if (args[i] === '--chat-id' && args[i + 1]) {
    chatId = args[++i];
  } else if (args[i] === '--quick') {
    // Quick mode: cap turns hard, used by warroom auto-routing where
    // voice latency matters more than thoroughness. The agent still has
    // MCP access but can only do ~1 tool call round-trip before it has
    // to answer.
    quickMode = true;
  }
}

if (!message) {
  console.error(JSON.stringify({ response: null, usage: null, error: 'No --message provided' }));
  process.exit(1);
}

async function main() {
  try {
    // Kill-switch chokepoint for voice-bridge SDK calls. If LLM_SPAWN_ENABLED
    // is off, exit cleanly with an error payload so warroom/server.py can
    // surface "auth/spawn disabled" through the agent_error frame instead
    // of a vague Gemini stutter.
    requireEnabled('LLM_SPAWN_ENABLED');

    const secrets = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
    // Strip nested Claude Code state plus every secret-shaped env var the
    // SDK subprocess doesn't need to authenticate. A prompt-injected agent
    // can read whatever's in its env; least-privilege limits the blast
    // radius to just the SDK auth token. Shared with router/orchestrator.
    const sdkEnv = getScrubbedSdkEnv(secrets);

    // Validate agent ID format (prevent path traversal)
    if (agentId !== 'main' && !/^[a-z][a-z0-9_-]{0,29}$/.test(agentId)) {
      throw new Error(`Invalid agent ID: ${agentId}`);
    }

    // Resolve agent directory and verify it's within the project
    const agentDir = agentId === 'main'
      ? PROJECT_ROOT
      : path.join(PROJECT_ROOT, 'agents', agentId);
    const resolved = path.resolve(agentDir);
    if (!resolved.startsWith(path.resolve(PROJECT_ROOT) + path.sep) && resolved !== path.resolve(PROJECT_ROOT)) {
      throw new Error(`Agent path outside project: ${resolved}`);
    }

    // Read the agent's MCP allowlist from its agent.yaml (if present). The
    // text bot does this via loadAgentConfig in src/bot.ts; we do a minimal
    // inline read to avoid pulling bot.ts's heavy init chain into the voice
    // bridge subprocess.
    let mcpAllowlist: string[] | undefined;
    try {
      const yamlPath = path.join(agentDir, 'agent.yaml');
      if (fs.existsSync(yamlPath)) {
        const raw = yaml.load(fs.readFileSync(yamlPath, 'utf-8')) as Record<string, unknown> | undefined;
        const list = raw?.['mcp_servers'];
        if (Array.isArray(list)) mcpAllowlist = list.filter((x): x is string => typeof x === 'string');
      }
    } catch (err) {
      // Non-fatal: fall through with undefined allowlist (loads all MCPs)
      process.stderr.write(`[voice-bridge] agent.yaml read failed: ${err}\n`);
    }

    // Load MCP servers for this agent, mirroring the text-bot's behavior.
    // Without this, voice-invoked agents can only use built-in tools (Bash,
    // Read, Grep, etc.) — no Gmail, Slack, Linear, Fireflies, etc.
    const mcpServers = loadMcpServers(mcpAllowlist, agentDir);
    const mcpServerNames = Object.keys(mcpServers);
    process.stderr.write(`[voice-bridge] agent=${agentId} mcpServers=${JSON.stringify(mcpServerNames)}\n`);

    // Resume session if one exists for this chat+agent
    const sessionId = getSession(chatId, agentId) ?? undefined;
    const provider = getMainProviderConfig();
    const providerSessionId = sessionBelongsToProvider(sessionId, provider)
      ? decodeProviderSession(provider, sessionId)
      : undefined;

    // Build memory context
    const { contextText: memCtx } = await buildMemoryContext(chatId, message, agentId);
    const parts: string[] = [];
    if (memCtx) parts.push(memCtx);

    // Add voice-meeting context hint. Quick mode is stricter because
    // Gemini Live will read the answer verbatim over voice —
    // long responses break the meeting feel.
    if (quickMode) {
      parts.push('[War Room auto-routing: the user is in a voice meeting and this answer will be read aloud verbatim. Respond in 1-2 short sentences. No preamble, no caveats, no lists. If the question genuinely needs a long answer, say "I need to dig into this, want me to queue it" so the user can choose to delegate the full task.]');
    } else {
      parts.push('[Voice meeting mode: Keep responses concise and conversational. Aim for 2-3 sentences unless asked for detail. Start with a brief acknowledgment.]');
    }
    parts.push(message);
    const fullMessage = parts.join('\n\n');

    let resultText: string | null = null;
    let newSessionId: string | undefined;
    let usage: Record<string, number> = {};

    const engine = EngineFactory.forProvider(provider);
    for await (const event of engine.invoke({
      prompt: fullMessage,
      provider,
      cwd: agentDir,
      sessionId: providerSessionId,
      settingSources: ['project', 'user'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      // Quick mode caps turns hard so an auto-routed voice answer
      // can't spiral into a 30s tool-use loop. Direct mode keeps the
      // higher ceiling for more substantive voice conversations.
      maxTurns: quickMode ? 3 : 15,
      env: sdkEnv,
      ...(mcpServerNames.length > 0 ? { mcpServers } : {}),
      ...(defaultModelForProvider(provider) ? { model: defaultModelForProvider(provider) } : {}),
    })) {
      if (event.type === 'session') newSessionId = event.sessionId;

      if (event.type === 'result') {
        resultText = event.text;
        if (event.usage) {
          usage = {
            input_tokens: event.usage.inputTokens,
            output_tokens: event.usage.outputTokens,
            cost_usd: event.usage.totalCostUsd,
          };
        }
      }
    }

    // Save session for continuity
    if (newSessionId) {
      setSession(chatId, encodeProviderSession(provider, newSessionId) ?? newSessionId, agentId);
    }

    console.log(JSON.stringify({
      response: resultText,
      usage,
      error: null,
    }));
  } catch (err) {
    console.log(JSON.stringify({
      response: null,
      usage: null,
      error: err instanceof Error ? err.message : String(err),
    }));
    process.exit(1);
  }
}

main();

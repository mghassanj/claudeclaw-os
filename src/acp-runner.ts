import { PROJECT_ROOT, agentCwd } from './config.js';
import { AcpEngineAdapter } from './agent-engine/index.js';
import type { AgentProgressEvent, AgentResult } from './agent.js';
import { DEFAULT_CODEX_MODEL, effectiveSkipPermissions, type ProviderConfig } from './provider.js';

export interface AcpToolPolicy {
  allowedTools?: string[];
  disallowedTools?: string[];
}

export async function runAcpAgent(
  provider: ProviderConfig,
  message: string,
  sessionId: string | undefined,
  onProgress?: (event: AgentProgressEvent) => void,
  abortController?: AbortController,
  onStreamText?: (accumulatedText: string) => void,
  toolPolicy?: AcpToolPolicy,
): Promise<AgentResult> {
  const engine = new AcpEngineAdapter();
  let text: string | null = null;
  let newSessionId = sessionId;
  let usage = null;
  let aborted = false;
  const effectiveModel = provider.model ?? (provider.type === 'codex' ? DEFAULT_CODEX_MODEL : undefined);

  for await (const event of engine.invoke({
    prompt: message,
    provider,
    sessionId,
    cwd: agentCwd ?? PROJECT_ROOT,
    ...(effectiveModel ? { model: effectiveModel } : {}),
    ...(provider.runtimeMode ? { runtimeMode: provider.runtimeMode } : {}),
    ...(provider.thinkingMode ? { thinkingMode: provider.thinkingMode } : {}),
    allowDangerouslySkipPermissions: effectiveSkipPermissions(provider),
    ...(toolPolicy?.allowedTools ? { allowedTools: toolPolicy.allowedTools } : {}),
    ...(toolPolicy?.disallowedTools ? { disallowedTools: toolPolicy.disallowedTools } : {}),
    abortController,
  })) {
    if (event.type === 'session') newSessionId = event.sessionId;
    if (event.type === 'text_delta') onStreamText?.(event.accumulatedText);
    if (event.type === 'progress') onProgress?.(event.progress);
    if (event.type === 'result') {
      text = event.text;
      usage = event.usage;
    }
    if (event.type === 'aborted') {
      text = event.text;
      newSessionId = event.sessionId ?? newSessionId;
      usage = event.usage;
      aborted = true;
    }
  }

  return { text, newSessionId, usage, ...(aborted ? { aborted } : {}) };
}

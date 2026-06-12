import { ENABLE_ACP } from '../config.js';
import type { ProviderConfig } from '../provider.js';
import { AcpEngineAdapter } from './acp-adapter.js';
import { ClaudeSdkEngineAdapter } from './claude-sdk-adapter.js';
import type { AgentEngine } from './types.js';

export * from './types.js';
export { AcpEngineAdapter, getAcpCommand } from './acp-adapter.js';
export { ClaudeSdkEngineAdapter } from './claude-sdk-adapter.js';

export class EngineFactory {
  static forProvider(provider: ProviderConfig): AgentEngine {
    // ENABLE_ACP gates the ACP engine path. When off, always return the
    // Claude SDK adapter even if a non-Claude provider somehow leaks through
    // (stale config, race during a flag flip, etc.).
    if (!ENABLE_ACP) return new ClaudeSdkEngineAdapter();
    if (provider.type === 'claude') return new ClaudeSdkEngineAdapter();
    return new AcpEngineAdapter();
  }
}

/**
 * Whether the engine selected for `provider` models a system prompt. The Claude
 * SDK engine does, so the persona is pinned there and callers should NOT also
 * inject it in-band. ACP does not, so callers must deliver the persona in the
 * message (e.g. a turn-1 injection). Mirrors `EngineFactory.forProvider`.
 *
 * Conservative on missing info: with ACP enabled and no provider, returns false
 * so callers keep injecting rather than risk an ACP turn with no persona.
 */
export function engineSupportsSystemPrompt(provider: ProviderConfig | undefined): boolean {
  if (!ENABLE_ACP) return true;
  if (!provider) return false;
  return provider.type === 'claude';
}


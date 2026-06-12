import { agentProvider, ENABLE_ACP } from './config.js';
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_PROVIDER,
  getMainProviderConfig,
  type ProviderConfig,
} from './provider.js';

export function getSelectedProviderConfig(): ProviderConfig {
  // ENABLE_ACP gates the beta multi-provider feature. When off, force Claude
  // regardless of saved agent.yaml or main-config.json. Belt-and-braces with
  // the dashboard API gate so a stale config file can't reach the ACP engine.
  if (!ENABLE_ACP) return { ...DEFAULT_PROVIDER };
  return agentProvider ?? getMainProviderConfig();
}

export function defaultModelForProvider(
  provider: ProviderConfig,
  claudeDefault = DEFAULT_CLAUDE_MODEL,
): string | undefined {
  return provider.model
    ?? (provider.type === 'claude'
      ? claudeDefault
      : provider.type === 'codex'
        ? DEFAULT_CODEX_MODEL
        : undefined);
}

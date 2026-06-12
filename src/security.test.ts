import { afterEach, describe, expect, it } from 'vitest';
import { getScrubbedSdkEnv } from './security.js';

const ORIGINAL_ENV = { ...process.env };

describe('getScrubbedSdkEnv', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('drops ANTHROPIC_API_KEY by default so Claude subscription auth can be used', () => {
    process.env.ANTHROPIC_API_KEY = 'stale-api-key';
    delete process.env.CLAUDECLAW_USE_ANTHROPIC_API_KEY;

    const env = getScrubbedSdkEnv({ ANTHROPIC_API_KEY: 'stale-api-key' });

    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('preserves CLAUDE_CODE_OAUTH_TOKEN when provided explicitly', () => {
    const env = getScrubbedSdkEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' });

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-token');
  });

  it('allows ANTHROPIC_API_KEY only when API-key auth is explicitly enabled', () => {
    process.env.CLAUDECLAW_USE_ANTHROPIC_API_KEY = 'true';

    const env = getScrubbedSdkEnv({ ANTHROPIC_API_KEY: 'valid-api-key' });

    expect(env.ANTHROPIC_API_KEY).toBe('valid-api-key');
  });

  it('still drops unrelated secret-shaped env vars', () => {
    process.env.GOOGLE_API_KEY = 'google-key';
    process.env.CUSTOM_SERVICE_TOKEN = 'service-token';
    process.env.PATH = '/usr/bin';

    const env = getScrubbedSdkEnv();

    expect(env.GOOGLE_API_KEY).toBeUndefined();
    expect(env.CUSTOM_SERVICE_TOKEN).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });
});

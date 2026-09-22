// Runs before any test module imports. Sets the env vars that config.ts
// reads at import time so contract tests can build a working dashboard
// app without polluting the developer's real .env or DB.
import { assertSafeTestEnvironment, sandboxTestDirs } from './test-guard.js';

// Defense in depth: globalSetup already ran this in the main process, but a
// worker could be started some other way (e.g. an IDE runner).
assertSafeTestEnvironment();

// Point CLAUDECLAW_CONFIG and STORE_DIR at fresh temp dirs and stop env.ts
// from reading any .env, so no test can touch the developer's (or the
// production host's) real config, store, or secrets. Tests that need a
// specific layout populate these dirs or override the env var themselves.
sandboxTestDirs();

process.env.DASHBOARD_TOKEN = 'test-contract-token';
process.env.DASHBOARD_MUTATIONS_ENABLED = process.env.DASHBOARD_MUTATIONS_ENABLED || 'true';
process.env.WARROOM_ENABLED = process.env.WARROOM_ENABLED || 'false';

// Fallback bot token for tests that exercise loadAgentConfig('main').
// The main agent falls back to TELEGRAM_BOT_TOKEN when agent.yaml omits
// telegram_bot_token_env, so this prevents spurious failures.
if (!process.env.TELEGRAM_BOT_TOKEN) {
  process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token-placeholder';
}
// Pinned for the CSRF allowlist regression — the contract test issues
// a POST with Origin=https://dash.test.example and asserts the
// middleware lets it through. Without this, the CSRF check has no
// allowed-origin host and 403s every cross-origin POST.
process.env.DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://dash.test.example';
// Contract tests exercise the multi-provider feature surface (models endpoint,
// runtime-options, PATCH /api/agents/:id/provider). The ENABLE_ACP gate defaults
// to off, so enable it here to keep those tests meaningful. Tests for the gated
// (off) state should override this explicitly.
process.env.ENABLE_ACP = process.env.ENABLE_ACP || 'true';

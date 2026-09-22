import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Refuses to start the run in an unsafe environment (production host,
    // real .env present, remote DATABASE_URL, NODE_ENV=production).
    globalSetup: ['src/test-guard.ts'],
    // Runs before any test module loads. Sandboxes CLAUDECLAW_CONFIG and
    // STORE_DIR to temp dirs, disables .env reading, and sets the env vars
    // that config.ts reads at import time. See src/test-guard.ts.
    setupFiles: ['src/test-env-setup.ts'],
  },
});

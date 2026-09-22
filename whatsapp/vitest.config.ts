import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    // Shared safety guard with the root package: refuses to run on the
    // production host, with a real .env, or against a remote DATABASE_URL.
    globalSetup: ["../src/test-guard.ts"],
    // Sandboxes config/store dirs and swaps DATABASE_URL for TEST_DATABASE_URL.
    setupFiles: ["tests/test-setup.ts"],
    // Tests must never touch the real sent-id registry in ~/.cache.
    env: { WA_SENT_REGISTRY_PATH: "/tmp/claudeclaw-test-wa-sent-ids.json" },
  },
});

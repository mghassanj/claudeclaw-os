import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    // Tests must never touch the real sent-id registry in ~/.cache.
    env: { WA_SENT_REGISTRY_PATH: "/tmp/claudeclaw-test-wa-sent-ids.json" },
  },
});

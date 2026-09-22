import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { execSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, '..');
// Run the CLI from source via tsx so the test does not depend on a prior
// `npm run build` (it used to exec dist/schedule-cli.js, which is absent on
// a fresh checkout).
const CLI = `node --import tsx "${path.join(PROJECT_DIR, 'src', 'schedule-cli.ts')}"`;

// The CLI opens STORE_DIR/claudeclaw.db, which needs DB_ENCRYPTION_KEY. Give
// the child process its own throwaway store and key so it never needs a
// .env and can never write to a real scheduler database.
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeclaw-schedule-cli-'));
const BASE_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  STORE_DIR: STORE,
  CLAUDECLAW_IGNORE_DOTENV: '1',
  DB_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
};

afterAll(() => {
  fs.rmSync(STORE, { recursive: true, force: true });
});

describe('schedule-cli agent routing', () => {
  // These tests run the actual CLI as a child process to verify env var behavior

  it('auto-detects agent from CLAUDECLAW_AGENT_ID env var', () => {
    const result = createAndTrack(
      `${CLI} create "test auto-detect" "0 9 * * *"`,
      { ...BASE_ENV, CLAUDECLAW_AGENT_ID: 'comms' },
    );

    expect(result).toContain('Agent:        comms');
  });

  it('--agent flag overrides CLAUDECLAW_AGENT_ID env var', () => {
    const result = createAndTrack(
      `${CLI} create "test override" "0 9 * * *" --agent ops`,
      { ...BASE_ENV, CLAUDECLAW_AGENT_ID: 'comms' },
    );

    expect(result).toContain('Agent:        ops');
  });

  it('defaults to main when no env var and no --agent flag', () => {
    const result = createAndTrack(
      `${CLI} create "test default" "0 9 * * *"`,
      { ...BASE_ENV, CLAUDECLAW_AGENT_ID: undefined },
    );

    expect(result).toContain('Agent:        main');
  });

  // Track task IDs created during tests for targeted cleanup
  const createdTaskIds: string[] = [];

  // Monkey-patch: extract task ID from CLI output
  function createAndTrack(cmd: string, env: Record<string, string | undefined>): string {
    const result = execSync(cmd, { cwd: PROJECT_DIR, env, encoding: 'utf-8' });
    const match = result.match(/Task created:\s+([a-f0-9]+)/);
    if (match) createdTaskIds.push(match[1]);
    return result;
  }

  afterEach(() => {
    // Only delete tasks we created, not pre-existing ones
    for (const id of createdTaskIds) {
      try {
        execSync(`${CLI} delete ${id}`, { cwd: PROJECT_DIR, env: BASE_ENV });
      } catch {
        // ignore if already gone
      }
    }
    createdTaskIds.length = 0;
  });
});

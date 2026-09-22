// Test safety guard, shared by the root and whatsapp/ vitest configs.
//
// Why this exists: on the production host, src/config.ts used to read the
// real .env from the repo root and STORE_DIR pointed at the live store, so a
// stray `npx vitest run` there could rewrite store/main-config.json, delete
// the live main agent's instructions, send real Telegram messages, or write
// to the production Postgres. This module makes that impossible by default:
//
//   * assertSafeTestEnvironment() REFUSES to run (throws) when the process
//     looks like production. It is wired as vitest `globalSetup` (so the run
//     aborts once, loudly, before any test file loads) and is called again
//     from each `setupFiles` entry as defense in depth.
//   * sandboxTestDirs() points CLAUDECLAW_CONFIG and STORE_DIR at fresh temp
//     dirs and tells env.ts to ignore any .env file. It runs from
//     `setupFiles`, i.e. in every worker before any test module imports
//     config.ts. A test that needs a different location sets the env var
//     itself (after this runs) or mocks ./config.js.
//
// Escape hatches (all explicit opt-ins, documented in CONTRIBUTING.md):
//   ALLOW_TESTS_WITH_DOTENV=1  run even though a .env exists at the repo root
//   ALLOW_TESTS_ON_HOST=1      run on an EC2-shaped host (hostname ip-172-31-*)
//   TEST_DATABASE_URL=...      the only way to give tests a non-local Postgres
//
// This file must stay dependency-free (fs/os/path only) because the whatsapp/
// package loads it straight from here.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

/** Repo root, derived from this file's location (src/test-guard.ts). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '']);

/** True when a Postgres connection string targets this machine (or a unix socket). */
export function isLocalDatabaseUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    // Unparseable → treat as remote; never guess in the permissive direction.
    return false;
  }
  return LOCAL_DB_HOSTS.has(host) || host.startsWith('127.');
}

/**
 * Collect every reason the current process must not run tests.
 * Returned (not thrown) so it can be unit-tested without tripping the guard.
 */
export function findUnsafeTestConditions(
  env: NodeJS.ProcessEnv = process.env,
  hostname: string = os.hostname(),
  repoRoot: string = REPO_ROOT,
): string[] {
  const problems: string[] = [];

  if (env.NODE_ENV === 'production') {
    problems.push('NODE_ENV=production. Tests never run against a production environment.');
  }

  if (env.DATABASE_URL && !env.TEST_DATABASE_URL && !isLocalDatabaseUrl(env.DATABASE_URL)) {
    problems.push(
      'DATABASE_URL points at a non-local host. Unset it, or point TEST_DATABASE_URL at a ' +
      'disposable database (tests then use TEST_DATABASE_URL instead).',
    );
  }

  if (env.ALLOW_TESTS_WITH_DOTENV !== '1') {
    for (const rel of ['.env', path.join('whatsapp', '.env')]) {
      if (fs.existsSync(path.join(repoRoot, rel))) {
        problems.push(
          `a real ${rel} exists in the repo (${path.join(repoRoot, rel)}), which suggests a live ` +
          'install. Run tests from a clean checkout, or set ALLOW_TESTS_WITH_DOTENV=1 if this is ' +
          'a dev machine (tests still never read it).',
        );
      }
    }
  }

  if (/^ip-172-31-/.test(hostname) && env.ALLOW_TESTS_ON_HOST !== '1') {
    problems.push(
      `hostname "${hostname}" looks like the production EC2 host. Set ALLOW_TESTS_ON_HOST=1 ` +
      'only if you are certain this is not production.',
    );
  }

  return problems;
}

/** Throw with a clear message if the environment is unsafe for tests. */
export function assertSafeTestEnvironment(): void {
  const problems = findUnsafeTestConditions();
  if (problems.length === 0) return;
  throw new Error(
    'Refusing to run tests: this environment looks unsafe.\n' +
    problems.map((p) => '  - ' + p).join('\n') +
    '\nSee "Running tests" in CONTRIBUTING.md.',
  );
}

/**
 * Point every on-disk location the app writes to at fresh temp dirs and
 * stop env.ts from reading any .env file. Call before config.ts is imported.
 */
export function sandboxTestDirs(): { configDir: string; storeDir: string } {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeclaw-test-config-'));
  fs.mkdirSync(path.join(configDir, 'agents'), { recursive: true });
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeclaw-test-store-'));
  process.once('exit', () => {
    for (const d of [configDir, storeDir]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });
  process.env.CLAUDECLAW_CONFIG = configDir;
  process.env.STORE_DIR = storeDir;
  process.env.CLAUDECLAW_IGNORE_DOTENV = '1';
  // Tests that need a Postgres get the explicit test database, never the ambient one.
  if (process.env.TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  }
  return { configDir, storeDir };
}

/** vitest globalSetup entry point: abort the whole run before any test loads. */
export default function setup(): void {
  assertSafeTestEnvironment();
}

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';

import { findUnsafeTestConditions, isLocalDatabaseUrl } from './test-guard.js';
import { STORE_DIR, CLAUDECLAW_CONFIG } from './config.js';

const cleanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeclaw-guard-root-'));
const SAFE_HOST = 'dev-laptop';

describe('test guard', () => {
  afterEach(() => {
    fs.rmSync(path.join(cleanRoot, '.env'), { force: true });
  });

  it('passes a clean environment', () => {
    expect(findUnsafeTestConditions({}, SAFE_HOST, cleanRoot)).toEqual([]);
  });

  it('refuses NODE_ENV=production', () => {
    const p = findUnsafeTestConditions({ NODE_ENV: 'production' }, SAFE_HOST, cleanRoot);
    expect(p.join()).toMatch(/NODE_ENV=production/);
  });

  it('refuses a remote DATABASE_URL unless TEST_DATABASE_URL is provided', () => {
    const remote = 'postgres://u:p@ep-x.eu-central-1.aws.neon.tech/db';
    expect(findUnsafeTestConditions({ DATABASE_URL: remote }, SAFE_HOST, cleanRoot)).toHaveLength(1);
    expect(
      findUnsafeTestConditions({ DATABASE_URL: remote, TEST_DATABASE_URL: 'postgres://localhost/t' }, SAFE_HOST, cleanRoot),
    ).toEqual([]);
    expect(findUnsafeTestConditions({ DATABASE_URL: 'postgres://localhost:5432/x' }, SAFE_HOST, cleanRoot)).toEqual([]);
  });

  it('classifies database hosts', () => {
    expect(isLocalDatabaseUrl('postgres://127.0.0.1/x')).toBe(true);
    expect(isLocalDatabaseUrl('postgres://[::1]:5432/x')).toBe(true);
    expect(isLocalDatabaseUrl('postgres://db.example.com/x')).toBe(false);
    expect(isLocalDatabaseUrl('not a url')).toBe(false);
  });

  it('refuses when a .env exists at the repo root unless ALLOW_TESTS_WITH_DOTENV=1', () => {
    fs.writeFileSync(path.join(cleanRoot, '.env'), 'X=1\n');
    expect(findUnsafeTestConditions({}, SAFE_HOST, cleanRoot).join()).toMatch(/\.env/);
    expect(findUnsafeTestConditions({ ALLOW_TESTS_WITH_DOTENV: '1' }, SAFE_HOST, cleanRoot)).toEqual([]);
  });

  it('refuses on the EC2 host unless ALLOW_TESTS_ON_HOST=1', () => {
    expect(findUnsafeTestConditions({}, 'ip-172-31-4-135', cleanRoot).join()).toMatch(/EC2/);
    expect(findUnsafeTestConditions({ ALLOW_TESTS_ON_HOST: '1' }, 'ip-172-31-4-135', cleanRoot)).toEqual([]);
  });

  it('sandboxes STORE_DIR and CLAUDECLAW_CONFIG into temp dirs', () => {
    const tmp = fs.realpathSync(os.tmpdir());
    expect(fs.realpathSync(STORE_DIR).startsWith(tmp)).toBe(true);
    expect(fs.realpathSync(CLAUDECLAW_CONFIG).startsWith(tmp)).toBe(true);
    expect(process.env.CLAUDECLAW_IGNORE_DOTENV).toBe('1');
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { readEnvFile } from './env.js';

const TMP_DIR = '/tmp/claudeclaw-env-test';
const TMP_ENV = path.join(TMP_DIR, '.env');

function writeEnv(content: string): void {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.writeFileSync(TMP_ENV, content, 'utf-8');
}

function cleanup(): void {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

describe('readEnvFile', () => {
  // The test harness sets CLAUDECLAW_IGNORE_DOTENV=1 so nothing reads a real
  // .env; these tests exercise the parser itself against a temp file.
  let savedIgnore: string | undefined;
  beforeEach(() => {
    savedIgnore = process.env.CLAUDECLAW_IGNORE_DOTENV;
    delete process.env.CLAUDECLAW_IGNORE_DOTENV;
  });

  afterEach(() => {
    if (savedIgnore === undefined) delete process.env.CLAUDECLAW_IGNORE_DOTENV;
    else process.env.CLAUDECLAW_IGNORE_DOTENV = savedIgnore;
    vi.restoreAllMocks();
    cleanup();
  });

  it('returns {} when CLAUDECLAW_IGNORE_DOTENV=1', () => {
    writeEnv('FOO=bar\n');
    mockCwd();
    process.env.CLAUDECLAW_IGNORE_DOTENV = '1';
    expect(readEnvFile(['FOO'])).toEqual({});
  });

  function mockCwd(): void {
    vi.spyOn(process, 'cwd').mockReturnValue(TMP_DIR);
  }

  it('parses KEY=value correctly', () => {
    writeEnv('FOO=bar\nBAZ=qux\n');
    mockCwd();
    const result = readEnvFile(['FOO', 'BAZ']);
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('handles double-quoted values', () => {
    writeEnv('GREETING="hello world"\n');
    mockCwd();
    const result = readEnvFile(['GREETING']);
    expect(result).toEqual({ GREETING: 'hello world' });
  });

  it('handles single-quoted values', () => {
    writeEnv("NAME='John Doe'\n");
    mockCwd();
    const result = readEnvFile(['NAME']);
    expect(result).toEqual({ NAME: 'John Doe' });
  });

  it('ignores comment lines', () => {
    writeEnv('# This is a comment\nKEY=value\n# Another comment\n');
    mockCwd();
    const result = readEnvFile(['KEY']);
    expect(result).toEqual({ KEY: 'value' });
  });

  it('ignores blank lines', () => {
    writeEnv('\n\nKEY=value\n\n\n');
    mockCwd();
    const result = readEnvFile(['KEY']);
    expect(result).toEqual({ KEY: 'value' });
  });

  it('returns empty object if .env does not exist', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/tmp/nonexistent-dir-xyz');
    const result = readEnvFile(['FOO']);
    expect(result).toEqual({});
  });

  it('only returns requested keys', () => {
    writeEnv('A=1\nB=2\nC=3\n');
    mockCwd();
    const result = readEnvFile(['A', 'C']);
    expect(result).toEqual({ A: '1', C: '3' });
    expect(result).not.toHaveProperty('B');
  });

  it('strips surrounding whitespace from keys and values', () => {
    writeEnv('  MY_KEY  =  my_value  \n');
    mockCwd();
    const result = readEnvFile(['MY_KEY']);
    expect(result).toEqual({ MY_KEY: 'my_value' });
  });

  it('handles values containing = sign', () => {
    writeEnv('URL=https://example.com?a=1&b=2\n');
    mockCwd();
    const result = readEnvFile(['URL']);
    expect(result).toEqual({ URL: 'https://example.com?a=1&b=2' });
  });

  it('skips lines without = sign', () => {
    writeEnv('NOEQUALS\nKEY=value\n');
    mockCwd();
    const result = readEnvFile(['KEY', 'NOEQUALS']);
    expect(result).toEqual({ KEY: 'value' });
  });
});

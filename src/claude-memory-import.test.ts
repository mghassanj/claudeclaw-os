import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect } from 'vitest';

import { contentHash, existingImportHashes, parseNote, readNotes, selectNew } from './claude-memory-import.js';

const NOTE = `---
name: Measure impact before designing prevention
description: Lead with live measurement and recovery numbers
type: feedback
---

For incident work, measure first.
`;

describe('parseNote', () => {
  it('uses frontmatter name/description for the summary and tags hash + type', () => {
    const n = parseNote('/m/feedback_measure.md', NOTE)!;
    expect(n.summary).toBe('Measure impact before designing prevention: Lead with live measurement and recovery numbers');
    expect(n.rawText).toContain('For incident work, measure first.');
    expect(n.rawText.startsWith('[Imported from Claude memory note feedback_measure.md]')).toBe(true);
    expect(n.topics).toEqual(expect.arrayContaining(['imported', 'claude-memory', 'file:feedback_measure', `sha256:${n.hash}`, 'type:feedback']));
  });

  it('falls back to the heading and first line without frontmatter (Arabic ok)', () => {
    const n = parseNote('/m/x.md', '# ملاحظات\n\nالكتابة بالعربي بدون همزات زائدة.\n')!;
    expect(n.summary).toBe('ملاحظات: الكتابة بالعربي بدون همزات زائدة.');
  });

  it('skips empty notes', () => {
    expect(parseNote('/m/e.md', '---\nname: x\n---\n\n')).toBeNull();
  });
});

describe('dedupe', () => {
  it('hash ignores line endings and trailing whitespace', () => {
    expect(contentHash('a  \r\nb\n')).toBe(contentHash('a\nb'));
    expect(contentHash('a\nb')).not.toBe(contentHash('a\nc'));
  });

  it('reads existing hashes from topics JSON and selects only new notes', () => {
    const a = parseNote('/m/a.md', 'alpha')!;
    const b = parseNote('/m/b.md', 'beta')!;
    const bCopy = parseNote('/m/b-copy.md', 'beta')!;
    const existing = existingImportHashes([JSON.stringify(['imported', `sha256:${a.hash}`]), 'not json']);
    expect(selectNew([a, b, bCopy], existing).map((n) => n.file)).toEqual(['/m/b.md']);
  });
});

describe('readNotes', () => {
  it('reads *.md, skipping MEMORY.md and non-markdown files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mem-'));
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), '- [index](a.md)');
    fs.writeFileSync(path.join(dir, 'a.md'), NOTE);
    fs.writeFileSync(path.join(dir, 'transcript.txt'), 'ignored');
    const notes = readNotes(dir);
    expect(notes.map((n) => path.basename(n.file))).toEqual(['a.md']);
  });
});

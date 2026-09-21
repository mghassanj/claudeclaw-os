/**
 * Pure helpers for scripts/import-claude-memory.ts: turn Claude Code
 * auto-memory markdown notes into `memories` rows, deduped by content hash.
 * Kept in src/ so they are type-checked and unit-tested with the rest.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export const IMPORT_SOURCE = 'claude-memory-import';
export const IMPORT_IMPORTANCE = 0.9;
const RAW_TEXT_MAX_CHARS = 8000;

export interface ParsedNote {
  file: string;
  title: string;
  summary: string;
  rawText: string;
  hash: string;
  topics: string[];
}

/** sha256 of the note with line endings and trailing whitespace normalized. */
export function contentHash(content: string): string {
  const normalized = content.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').trim();
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/** Split optional YAML-ish frontmatter (--- key: value ---) from the body. */
export function splitFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const m = content.replace(/\r\n?/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: content.replace(/\r\n?/g, '\n') };
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: m[2] };
}

/** Turn one markdown note into the fields of a memories row. Returns null for empty notes. */
export function parseNote(file: string, content: string): ParsedNote | null {
  const { meta, body } = splitFrontmatter(content);
  const text = body.trim();
  if (!text && !meta.description) return null;
  const heading = text.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim();
  const base = path.basename(file).replace(/\.md$/i, '');
  const title = meta.name || heading || base;
  const firstLine = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) ?? '';
  const summaryCore = meta.description || firstLine || title;
  const summary = `${title}: ${summaryCore}`.slice(0, 500);
  const hash = contentHash(content);
  const rawText = `[Imported from Claude memory note ${path.basename(file)}]\n${text || summaryCore}`.slice(0, RAW_TEXT_MAX_CHARS);
  const topics = ['imported', 'claude-memory', `file:${base}`, `sha256:${hash}`];
  if (meta.type) topics.push(`type:${meta.type}`);
  return { file, title, summary, rawText, hash, topics };
}

/** Read *.md notes in `dir` (non-recursive), skipping the MEMORY.md index. */
export function readNotes(dir: string): ParsedNote[] {
  return fs.readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.md') && f.toUpperCase() !== 'MEMORY.MD')
    .sort()
    .map((f) => parseNote(path.join(dir, f), fs.readFileSync(path.join(dir, f), 'utf8')))
    .filter((n): n is ParsedNote => n !== null);
}

/** Hashes already imported, read from the `sha256:` topic of earlier import rows. */
export function existingImportHashes(topicsJsonRows: string[]): Set<string> {
  const out = new Set<string>();
  for (const raw of topicsJsonRows) {
    try {
      for (const t of JSON.parse(raw) as unknown[]) {
        if (typeof t === 'string' && t.startsWith('sha256:')) out.add(t.slice(7));
      }
    } catch { /* ignore malformed rows */ }
  }
  return out;
}

/** Notes whose content hash isn't imported yet (also dedupes identical notes within the batch). */
export function selectNew(notes: ParsedNote[], existing: Set<string>): ParsedNote[] {
  const seen = new Set(existing);
  const out: ParsedNote[] = [];
  for (const n of notes) {
    if (seen.has(n.hash)) continue;
    seen.add(n.hash);
    out.push(n);
  }
  return out;
}

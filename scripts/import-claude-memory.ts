#!/usr/bin/env tsx
/**
 * Import Claude Code auto-memory notes (markdown files) into ClaudeClaw's
 * `memories` table as PINNED rows, so knowledge written under an old working
 * directory (e.g. ~/.claude/projects/-home-ubuntu/memory) isn't lost now that
 * the main agent runs from a different cwd.
 *
 * Usage (on the host, from the repo root, with the service's .env in place):
 *   npx tsx scripts/import-claude-memory.ts <dir> [--chat-id <id>] [--agent main] [--dry-run] [--no-embed]
 *
 *   <dir>        directory of *.md notes. MEMORY.md (the index of pointers) is skipped.
 *   --chat-id    chat the memories belong to (default: ALLOWED_CHAT_ID from .env).
 *   --agent      agent_id for the rows (default: main).
 *   --dry-run    print what would be imported, write nothing.
 *   --no-embed   skip Gemini embeddings (rows are then found by keyword/FTS search only).
 *
 * Idempotent: each note's normalized content is hashed (sha256) and the hash
 * is stored as a `sha256:<hash>` topic. Re-running skips notes whose hash is
 * already present, so an edited note is imported again as a new row.
 */
import fs from 'fs';
import path from 'path';

import {
  IMPORT_IMPORTANCE,
  IMPORT_SOURCE,
  existingImportHashes,
  readNotes,
  selectNew,
} from '../src/claude-memory-import.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (!dir || dir.startsWith('--') || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error('Usage: npx tsx scripts/import-claude-memory.ts <dir> [--chat-id <id>] [--agent main] [--dry-run] [--no-embed]');
    process.exit(2);
  }
  const dryRun = process.argv.includes('--dry-run');
  const noEmbed = process.argv.includes('--no-embed');
  const agentId = arg('--agent') ?? 'main';

  // Loaded lazily so --help/usage errors don't need a configured .env.
  const { ALLOWED_CHAT_ID, STORE_DIR } = await import('../src/config.js');
  const db = await import('../src/db.js');
  const chatId = arg('--chat-id') ?? ALLOWED_CHAT_ID;
  if (!chatId) {
    console.error('No chat id: pass --chat-id or set ALLOWED_CHAT_ID in .env');
    process.exit(2);
  }

  db.initDatabase();
  const Database = (await import('better-sqlite3')).default;
  const ro = new Database(path.join(STORE_DIR, 'claudeclaw.db'), { readonly: true });
  const rows = ro.prepare('SELECT topics FROM memories WHERE source = ? AND chat_id = ?').all(IMPORT_SOURCE, chatId) as Array<{ topics: string }>;
  ro.close();

  const notes = readNotes(dir);
  const fresh = selectNew(notes, existingImportHashes(rows.map((r) => r.topics)));
  console.log(`${notes.length} notes in ${dir}; ${notes.length - fresh.length} already imported; ${fresh.length} to import${dryRun ? ' (dry run)' : ''}.`);

  let embedText: ((t: string) => Promise<number[]>) | null = null;
  if (!noEmbed && !dryRun) embedText = (await import('../src/embeddings.js')).embedText;

  let imported = 0;
  for (const n of fresh) {
    if (dryRun) {
      console.log(`  would import ${path.basename(n.file)}: ${n.summary.slice(0, 100)}`);
      continue;
    }
    let embedding: number[] = [];
    if (embedText) {
      try { embedding = await embedText(`${n.summary} ${n.topics.join(' ')}`); } catch (e) {
        console.warn(`  embedding failed for ${path.basename(n.file)} (keyword search still works): ${(e as Error).message}`);
      }
    }
    const id = db.saveStructuredMemoryAtomic(chatId, n.rawText, n.summary, [], n.topics, IMPORT_IMPORTANCE, embedding, IMPORT_SOURCE, agentId);
    db.pinMemory(id);
    imported++;
    console.log(`  imported #${id} (pinned) ${path.basename(n.file)}`);
  }
  if (!dryRun) console.log(`Done: ${imported}/${fresh.length} imported and pinned.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

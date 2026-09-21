/**
 * One-off: pin the personal-assistant language preferences as permanent
 * memories for the MAIN agent (chat ALLOWED_CHAT_ID).
 *
 *   cd ~/claudeclaw-os && npx tsx scripts/seed-pa-preferences.ts [--dry-run]
 *
 * Idempotent: a rule whose exact summary already exists is only (re)pinned,
 * which also resets its salience to 1.0. The Arabic spelling rules are
 * copied from memories #35/#36 (saved under the comms agent in May, so the
 * main agent never retrieved them); the wording is unchanged, no PII.
 */
import { ALLOWED_CHAT_ID } from '../src/config.js';
import { getDatabaseHandle, initDatabase, pinMemory, saveStructuredMemory } from '../src/db.js';

interface Seed {
  summary: string;
  entities: string[];
  topics: string[];
  importance: number;
}

const SEEDS: Seed[] = [
  {
    summary:
      'STANDING RULE: when Mohamed writes in Arabic, reply in Najdi Arabic (Saudi Najdi dialect).',
    entities: ['Arabic', 'Najdi', 'Mohamed'],
    topics: ['language preferences', 'Arabic', 'voice'],
    importance: 1.0,
  },
  {
    summary:
      "User requires correct Arabic spelling of system names: 'قوى' (not 'قيوى') and 'جسر' (not 'جيسر'). Apply in all future messages.",
    entities: ['قوى', 'جسر'],
    topics: ['Arabic spelling', 'system names', 'writing preferences'],
    importance: 0.9,
  },
  {
    summary: 'When writing in Arabic, spell-check all words first to ensure proper Arabic.',
    entities: ['Arabic'],
    topics: ['Arabic spelling', 'writing preferences'],
    importance: 0.85,
  },
];

const dryRun = process.argv.includes('--dry-run');

if (!ALLOWED_CHAT_ID) {
  console.error('ALLOWED_CHAT_ID is not set (.env). Run from the claudeclaw-os root.');
  process.exit(1);
}

initDatabase();
const db = getDatabaseHandle();

for (const s of SEEDS) {
  const existing = db
    .prepare(`SELECT id, pinned FROM memories WHERE chat_id = ? AND agent_id = 'main' AND summary = ?`)
    .get(ALLOWED_CHAT_ID, s.summary) as { id: number; pinned: number } | undefined;
  if (existing) {
    console.log(`${dryRun ? '[dry-run] would re-pin' : 'Re-pinned'} existing memory #${existing.id}: ${s.summary.slice(0, 70)}…`);
    if (!dryRun) pinMemory(existing.id);
    continue;
  }
  if (dryRun) {
    console.log(`[dry-run] would add + pin: ${s.summary.slice(0, 70)}…`);
    continue;
  }
  const id = saveStructuredMemory(ALLOWED_CHAT_ID, s.summary, s.summary, s.entities, s.topics, s.importance, 'seed', 'main');
  pinMemory(id);
  console.log(`Added + pinned memory #${id}: ${s.summary.slice(0, 70)}…`);
}

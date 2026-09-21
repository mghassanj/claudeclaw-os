/**
 * Typed memory intake side effects (memory-ingest.ts classifies each
 * extraction as fact | preference | person | commitment):
 *   preference -> the saved memory row is pinned (never decays)
 *   person     -> contacts upsert (fills empty fields, appends notes)
 *   commitment -> open_loops row, status open, needs_confirmation = 1
 *                 (shown in [Open loops] as UNCONFIRMED; it only fires after
 *                 `loops-cli confirm <id>`)
 * Every function is best-effort: callers wrap them, memory rows are still
 * written exactly as before.
 */
import { pinMemory } from './db.js';
import { findContactByName, upsertContactByName } from './contacts.js';
import { createLoop, listLoops } from './open-loops.js';
import { parseWhen } from './pa-cli-util.js';
import { logger } from './logger.js';

export type MemoryKind = 'fact' | 'preference' | 'person' | 'commitment';
export const MEMORY_KINDS: MemoryKind[] = ['fact', 'preference', 'person', 'commitment'];

export interface ExtractedPerson {
  name?: string;
  aliases?: string[];
  relationship?: string;
  org?: string;
  language_pref?: string;
  notes?: string;
  email?: string;
  phone?: string;
}

export interface ExtractedCommitment {
  summary?: string;
  due?: string;          // ISO time or relative ("2h", "1d"); optional
  contact_name?: string; // who it concerns, if anyone
  kind?: 'promise' | 'reminder' | 'await_reply';
}

export function normalizeKind(k: unknown): MemoryKind {
  return typeof k === 'string' && (MEMORY_KINDS as string[]).includes(k) ? (k as MemoryKind) : 'fact';
}

export function pinPreferenceMemory(memoryId: number): void {
  pinMemory(memoryId);
}

export function upsertPersonFromIntake(p: ExtractedPerson | undefined): number | null {
  const name = p?.name?.trim();
  if (!name || name.length < 2) return null;
  const clean = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : undefined);
  const { contact, created } = upsertContactByName({
    display_name: name,
    aliases: Array.isArray(p!.aliases) ? p!.aliases.filter((a): a is string => typeof a === 'string').slice(0, 5) : [],
    relationship: clean(p!.relationship),
    org: clean(p!.org),
    language_pref: clean(p!.language_pref),
    notes: clean(p!.notes),
    email: clean(p!.email),
    phone: clean(p!.phone),
  });
  logger.info({ contactId: contact.id, created }, 'typed intake: person upserted');
  return contact.id;
}

/**
 * Record a commitment as an unconfirmed open loop. Skips duplicates (an
 * active loop with the same summary) so re-extraction of the same promise
 * doesn't pile up rows.
 */
export function recordCommitmentFromIntake(c: ExtractedCommitment | undefined, fallbackSummary: string, agentId: string): number | null {
  const summary = (c?.summary?.trim() || fallbackSummary.trim()).slice(0, 300);
  if (!summary) return null;
  const active = listLoops({ limit: 200 });
  if (active.some((l) => l.summary.trim().toLowerCase() === summary.toLowerCase())) return null;
  const contact = c?.contact_name ? findContactByName(c.contact_name) : null;
  const due = c?.due ? parseWhen(c.due) : null;
  // An unconfirmed await_reply can't be matched without an id; store it as
  // a promise and let the agent upgrade it after confirming with Mohamed.
  const kind = c?.kind === 'reminder' ? 'reminder' : 'promise';
  const loop = createLoop({
    kind,
    summary,
    intent_prompt: 'Captured automatically from conversation; confirm with Mohamed before acting.',
    contact_id: contact?.id ?? null,
    channel: 'internal',
    due_at: due,
    needs_confirmation: true,
    created_by_agent: agentId,
  });
  logger.info({ loopId: loop.id }, 'typed intake: commitment recorded (unconfirmed)');
  return loop.id;
}

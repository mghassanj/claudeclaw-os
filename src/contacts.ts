/**
 * People directory for the personal assistant (table `contacts`, created in
 * db.ts). Used by contacts-cli, the [People] context block, typed memory
 * intake (person -> upsert) and open-loop matching (WhatsApp ids).
 */
import { getDatabaseHandle } from './db.js';

export interface Contact {
  id: number;
  display_name: string;
  aliases: string; // JSON array
  wa_chat_id: string | null;
  phone: string | null;
  telegram_id: string | null;
  email: string | null;
  relationship: string | null;
  org: string | null;
  language_pref: string | null;
  notes: string | null;
  last_interaction_at: number | null;
  pinned: number;
  created_at: number;
  updated_at: number;
}

export interface ContactInput {
  display_name?: string;
  aliases?: string[];
  wa_chat_id?: string | null;
  phone?: string | null;
  telegram_id?: string | null;
  email?: string | null;
  relationship?: string | null;
  org?: string | null;
  language_pref?: string | null;
  notes?: string | null;
  pinned?: boolean;
}

const now = (): number => Math.floor(Date.now() / 1000);

export function contactAliases(c: Pick<Contact, 'aliases'>): string[] {
  try {
    const v = JSON.parse(c.aliases);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : [];
  } catch {
    return [];
  }
}

/** Digits of a phone / the user-part of a WhatsApp id ("9665...@c.us" -> "9665..."). */
export function waUserPart(id: string | null | undefined): string {
  if (!id) return '';
  return id.split('@')[0].replace(/[^0-9a-zA-Z]/g, '');
}

export function addContact(input: ContactInput & { display_name: string }): Contact {
  const t = now();
  const res = getDatabaseHandle().prepare(
    `INSERT INTO contacts (display_name, aliases, wa_chat_id, phone, telegram_id, email,
       relationship, org, language_pref, notes, pinned, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.display_name.trim(),
    JSON.stringify(dedupeStrings(input.aliases ?? [])),
    input.wa_chat_id ?? null,
    input.phone ?? null,
    input.telegram_id ?? null,
    input.email ?? null,
    input.relationship ?? null,
    input.org ?? null,
    input.language_pref ?? null,
    input.notes ?? null,
    input.pinned ? 1 : 0,
    t,
    t,
  );
  return getContact(Number(res.lastInsertRowid))!;
}

export function getContact(id: number): Contact | null {
  return (getDatabaseHandle().prepare('SELECT * FROM contacts WHERE id = ?').get(id) as Contact | undefined) ?? null;
}

export function listContacts(limit = 50): Contact[] {
  return getDatabaseHandle()
    .prepare(
      `SELECT * FROM contacts
       ORDER BY pinned DESC, COALESCE(last_interaction_at, updated_at) DESC LIMIT ?`,
    )
    .all(limit) as Contact[];
}

/**
 * Update a contact. Aliases passed are MERGED with existing ones; notes
 * replace (use appendNotes to append).
 */
export function updateContact(id: number, input: ContactInput & { appendNotes?: string }): Contact | null {
  const cur = getContact(id);
  if (!cur) return null;
  const aliases = input.aliases ? dedupeStrings([...contactAliases(cur), ...input.aliases]) : contactAliases(cur);
  let notes = input.notes !== undefined ? input.notes : cur.notes;
  if (input.appendNotes && input.appendNotes.trim()) {
    const add = input.appendNotes.trim();
    if (!(notes ?? '').includes(add)) notes = notes ? `${notes}\n${add}` : add;
  }
  getDatabaseHandle().prepare(
    `UPDATE contacts SET display_name = ?, aliases = ?, wa_chat_id = ?, phone = ?, telegram_id = ?,
       email = ?, relationship = ?, org = ?, language_pref = ?, notes = ?, pinned = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    (input.display_name ?? cur.display_name).trim(),
    JSON.stringify(aliases),
    pick(input.wa_chat_id, cur.wa_chat_id),
    pick(input.phone, cur.phone),
    pick(input.telegram_id, cur.telegram_id),
    pick(input.email, cur.email),
    pick(input.relationship, cur.relationship),
    pick(input.org, cur.org),
    pick(input.language_pref, cur.language_pref),
    notes ?? null,
    input.pinned === undefined ? cur.pinned : input.pinned ? 1 : 0,
    now(),
    id,
  );
  return getContact(id);
}

export function touchContactInteraction(id: number, at = now()): void {
  getDatabaseHandle()
    .prepare('UPDATE contacts SET last_interaction_at = MAX(COALESCE(last_interaction_at, 0), ?) WHERE id = ?')
    .run(at, id);
}

/** Case-insensitive search over name, aliases, email, phone, WhatsApp id, org. */
export function findContacts(query: string, limit = 10): Contact[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const all = getDatabaseHandle().prepare('SELECT * FROM contacts').all() as Contact[];
  const qDigits = q.replace(/[^0-9]/g, '');
  const scored: Array<{ c: Contact; score: number }> = [];
  for (const c of all) {
    const names = [c.display_name, ...contactAliases(c)].map((n) => n.toLowerCase());
    let score = 0;
    if (names.some((n) => n === q)) score = 3;
    else if (names.some((n) => n.includes(q) || (q.length >= 3 && q.includes(n) && n.length >= 3))) score = 2;
    else if ([c.email, c.org, c.relationship].some((f) => (f ?? '').toLowerCase().includes(q))) score = 1;
    else if (qDigits.length >= 6 && [c.phone, c.wa_chat_id].some((f) => waUserPart(f).includes(qDigits))) score = 1;
    if (score > 0) scored.push({ c, score });
  }
  return scored.sort((a, b) => b.score - a.score || b.c.pinned - a.c.pinned).slice(0, limit).map((s) => s.c);
}

/** Exact (case-insensitive) match on display name or alias. */
export function findContactByName(name: string): Contact | null {
  const n = name.trim().toLowerCase();
  if (!n) return null;
  const all = getDatabaseHandle().prepare('SELECT * FROM contacts').all() as Contact[];
  return all.find((c) => [c.display_name, ...contactAliases(c)].some((x) => x.toLowerCase() === n)) ?? null;
}

/** Contacts whose WhatsApp id or phone matches any of the given WhatsApp ids. */
export function findContactsByWaIds(ids: string[]): Contact[] {
  const parts = new Set(ids.map(waUserPart).filter((p) => p.length >= 5));
  if (parts.size === 0) return [];
  const all = getDatabaseHandle()
    .prepare('SELECT * FROM contacts WHERE wa_chat_id IS NOT NULL OR phone IS NOT NULL')
    .all() as Contact[];
  return all.filter((c) => parts.has(waUserPart(c.wa_chat_id)) || parts.has(waUserPart(c.phone)));
}

/**
 * Contacts mentioned by name/alias in free text. Latin names match on word
 * boundaries; Arabic (and other non-Latin) names match as substrings since
 * Arabic attaches prefixes (و، ل، ب) to words. Names shorter than 3 chars
 * are ignored to avoid noise.
 */
export function findMentionedContacts(text: string, limit = 3): Contact[] {
  if (!text || !text.trim()) return [];
  const all = getDatabaseHandle().prepare('SELECT * FROM contacts').all() as Contact[];
  const lower = text.toLowerCase();
  const hits: Array<{ c: Contact; pos: number }> = [];
  for (const c of all) {
    let best = -1;
    for (const raw of [c.display_name, ...contactAliases(c)]) {
      const name = raw.trim().toLowerCase();
      if (name.length < 3) continue;
      let pos: number;
      if (/^[\x00-\x7F]+$/.test(name)) {
        const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(name)}($|[^a-z0-9])`, 'i');
        const m = re.exec(lower);
        pos = m ? m.index : -1;
      } else {
        pos = lower.indexOf(name);
      }
      if (pos >= 0 && (best < 0 || pos < best)) best = pos;
    }
    if (best >= 0) hits.push({ c, pos: best });
  }
  return hits.sort((a, b) => a.pos - b.pos).slice(0, limit).map((h) => h.c);
}

/**
 * Upsert by exact name/alias match (typed memory intake). Only fills fields
 * that are empty on the existing row; notes are appended, never overwritten.
 */
export function upsertContactByName(input: ContactInput & { display_name: string }): { contact: Contact; created: boolean } {
  const candidates = [input.display_name, ...(input.aliases ?? [])];
  let existing: Contact | null = null;
  for (const n of candidates) {
    existing = findContactByName(n);
    if (existing) break;
  }
  if (!existing) return { contact: addContact(input), created: true };
  const fill = <K extends keyof Contact>(k: K, v: string | null | undefined): string | null | undefined =>
    existing![k] ? undefined : v ?? undefined;
  const updated = updateContact(existing.id, {
    aliases: [input.display_name, ...(input.aliases ?? [])].filter(
      (a) => a.trim().toLowerCase() !== existing!.display_name.toLowerCase(),
    ),
    wa_chat_id: fill('wa_chat_id', input.wa_chat_id),
    phone: fill('phone', input.phone),
    email: fill('email', input.email),
    relationship: fill('relationship', input.relationship),
    org: fill('org', input.org),
    language_pref: fill('language_pref', input.language_pref),
    appendNotes: input.notes ?? undefined,
  });
  return { contact: updated ?? existing, created: false };
}

function pick<T>(next: T | undefined, cur: T): T {
  return next === undefined ? cur : next;
}

function dedupeStrings(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const t = x.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

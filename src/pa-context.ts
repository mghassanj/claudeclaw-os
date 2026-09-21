/**
 * Personal-assistant context blocks for the MAIN agent, appended by
 * buildMemoryContext:
 *   [Open loops]  every turn (max 8, overdue first)
 *   [People]      when the message mentions a known contact name/alias
 */
import { contactAliases, findMentionedContacts, type Contact } from './contacts.js';
import { buildOpenLoopsBlock, listLoops, relTime } from './open-loops.js';

export function buildPeopleBlock(message: string, max = 3): string {
  const people = findMentionedContacts(message, max);
  if (people.length === 0) return '';
  return `[People — known contacts mentioned]\n${people.map(personLines).join('\n')}\n[End people]`;
}

function personLines(c: Contact): string {
  const head = [c.display_name];
  const aliases = contactAliases(c);
  if (aliases.length) head.push(`(aka ${aliases.join(', ')})`);
  const role = [c.relationship, c.org].filter(Boolean).join(' @ ');
  const lines = [`- ${head.join(' ')}${role ? ` — ${role}` : ''} [contact #${c.id}]`];
  const facts: string[] = [];
  if (c.language_pref) facts.push(`language: ${c.language_pref}`);
  if (c.wa_chat_id) facts.push(`WhatsApp: ${c.wa_chat_id}`);
  if (c.last_interaction_at) facts.push(`last interaction ${relTime(c.last_interaction_at)}`);
  if (facts.length) lines.push(`  ${facts.join(' · ')}`);
  if (c.notes) lines.push(`  notes: ${c.notes.replace(/\s+/g, ' ').slice(0, 300)}`);
  const loops = listLoops({ contactId: c.id, limit: 3 });
  for (const l of loops) lines.push(`  open loop #${l.id} ${l.kind} [${l.status}]: ${l.summary.slice(0, 100)}`);
  return lines.join('\n');
}

/** Both PA blocks; each failure is isolated so memory context never breaks. */
export function buildPaContextBlocks(message: string): string[] {
  const out: string[] = [];
  try {
    const loops = buildOpenLoopsBlock(8);
    if (loops) out.push(loops);
  } catch { /* table missing / db not ready: skip */ }
  try {
    const people = buildPeopleBlock(message);
    if (people) out.push(people);
  } catch { /* skip */ }
  return out;
}

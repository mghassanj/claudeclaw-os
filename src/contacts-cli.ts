#!/usr/bin/env node
/**
 * ClaudeClaw contacts CLI: the assistant's people directory.
 *
 *   node dist/contacts-cli.js add --name "Nora" [--alias "نورة"]... [--wa 9665XXXXXXXX@c.us]
 *        [--phone +9665...] [--telegram <id>] [--email x@y] [--rel "colleague"] [--org "Jisr"]
 *        [--lang ar-najdi] [--notes "..."] [--pin]
 *   node dist/contacts-cli.js find <text>
 *   node dist/contacts-cli.js show <id|name>
 *   node dist/contacts-cli.js update <id> [same flags; --alias adds; --add-note appends; --unpin]
 *   node dist/contacts-cli.js list [--limit 50]
 */
import { pathToFileURL } from 'url';

import { initDatabase } from './db.js';
import {
  addContact,
  contactAliases,
  findContactByName,
  findContacts,
  getContact,
  listContacts,
  updateContact,
  type Contact,
  type ContactInput,
} from './contacts.js';
import { listLoops } from './open-loops.js';
import { flag, flagAll, fmtTime, parseArgs, type ParsedArgs } from './pa-cli-util.js';

export interface CliResult { code: number; out: string }

function oneLine(c: Contact): string {
  const bits = [`#${c.id} ${c.display_name}${c.pinned ? ' 📌' : ''}`];
  const aliases = contactAliases(c);
  if (aliases.length) bits.push(`aka ${aliases.join(', ')}`);
  if (c.relationship || c.org) bits.push([c.relationship, c.org].filter(Boolean).join(' @ '));
  if (c.language_pref) bits.push(`lang ${c.language_pref}`);
  if (c.wa_chat_id) bits.push(`wa ${c.wa_chat_id}`);
  return bits.join(' · ');
}

function detail(c: Contact): string {
  const loops = listLoops({ contactId: c.id, limit: 10 });
  return [
    oneLine(c),
    `Phone: ${c.phone ?? '-'}   Email: ${c.email ?? '-'}   Telegram: ${c.telegram_id ?? '-'}`,
    `Last interaction: ${fmtTime(c.last_interaction_at)}`,
    `Notes: ${c.notes ?? '-'}`,
    `Open loops: ${loops.length ? loops.map((l) => `#${l.id} ${l.kind} [${l.status}] ${l.summary.slice(0, 60)}`).join('; ') : 'none'}`,
  ].join('\n');
}

function inputFromFlags(p: ParsedArgs): ContactInput {
  const input: ContactInput = {};
  const set = <K extends keyof ContactInput>(k: K, f: string): void => {
    const v = flag(p, f);
    if (v !== undefined) (input as Record<string, unknown>)[k] = v === '-' ? null : v;
  };
  set('display_name', 'name');
  set('wa_chat_id', 'wa');
  set('phone', 'phone');
  set('telegram_id', 'telegram');
  set('email', 'email');
  set('relationship', 'rel');
  set('org', 'org');
  set('language_pref', 'lang');
  set('notes', 'notes');
  const aliases = flagAll(p, 'alias');
  if (aliases.length) input.aliases = aliases;
  if (flag(p, 'pin') !== undefined) input.pinned = true;
  if (flag(p, 'unpin') !== undefined) input.pinned = false;
  return input;
}

function resolve(ref: string): Contact | null {
  if (/^\d+$/.test(ref)) return getContact(Number(ref));
  return findContactByName(ref) ?? (findContacts(ref, 2).length === 1 ? findContacts(ref, 1)[0] : null);
}

export function runContactsCli(argv: string[]): CliResult {
  const [command, ...rest] = argv;
  const p = parseArgs(rest);

  switch (command) {
    case 'add': {
      const input = inputFromFlags(p);
      const name = input.display_name ?? p.positional.join(' ');
      if (!name?.trim()) return { code: 1, out: 'Usage: contacts-cli add --name "Name" [--wa ...] [--lang ...]' };
      const existing = findContactByName(name);
      if (existing) return { code: 1, out: `Contact already exists: ${oneLine(existing)}\nUse: contacts-cli update ${existing.id} ...` };
      const c = addContact({ ...input, display_name: name });
      return { code: 0, out: `Added ${oneLine(c)}` };
    }

    case 'find': {
      const q = p.positional.join(' ');
      if (!q.trim()) return { code: 1, out: 'Usage: contacts-cli find <text>' };
      const hits = findContacts(q, 10);
      return { code: 0, out: hits.length ? hits.map(oneLine).join('\n') : `No contact matches "${q}".` };
    }

    case 'show': {
      const ref = p.positional.join(' ');
      const c = ref ? resolve(ref) : null;
      return c ? { code: 0, out: detail(c) } : { code: 1, out: `No single contact matches "${ref}".` };
    }

    case 'update': {
      const id = Number(p.positional[0]);
      if (!Number.isInteger(id) || id <= 0) return { code: 1, out: 'Usage: contacts-cli update <id> [--flags]' };
      const input = inputFromFlags(p);
      const addNote = flag(p, 'add-note');
      const c = updateContact(id, { ...input, appendNotes: addNote });
      return c ? { code: 0, out: `Updated ${oneLine(c)}` } : { code: 1, out: `No contact #${id}` };
    }

    case 'list': {
      const limit = Number(flag(p, 'limit') ?? '50');
      const all = listContacts(Number.isFinite(limit) && limit > 0 ? limit : 50);
      return { code: 0, out: all.length ? all.map(oneLine).join('\n') : 'No contacts yet.' };
    }

    default:
      return { code: 1, out: 'Commands: add | find | show | update | list' };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  initDatabase();
  const r = runContactsCli(process.argv.slice(2));
  (r.code === 0 ? console.log : console.error)(r.out);
  process.exit(r.code);
}

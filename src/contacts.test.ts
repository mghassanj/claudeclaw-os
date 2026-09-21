import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase } from './db.js';
import {
  addContact,
  contactAliases,
  findContactByName,
  findContacts,
  findContactsByWaIds,
  findMentionedContacts,
  getContact,
  updateContact,
  upsertContactByName,
} from './contacts.js';
import { runContactsCli } from './contacts-cli.js';
import { buildPeopleBlock } from './pa-context.js';
import { createLoop } from './open-loops.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('contacts', () => {
  it('finds by name, alias, org and phone digits', () => {
    const n = addContact({ display_name: 'Nora Alharbi', aliases: ['نورة'], org: 'Jisr', phone: '+966 50 000 0001' });
    expect(findContacts('nora')[0].id).toBe(n.id);
    expect(findContacts('نورة')[0].id).toBe(n.id);
    expect(findContacts('jisr')[0].id).toBe(n.id);
    expect(findContacts('500000001')[0].id).toBe(n.id);
    expect(findContactByName('NORA ALHARBI')?.id).toBe(n.id);
    expect(findContactByName('nora')).toBeNull();
  });

  it('matches WhatsApp ids by user-part', () => {
    const n = addContact({ display_name: 'Nora', wa_chat_id: '966500000001@c.us' });
    expect(findContactsByWaIds(['966500000001@lid']).map((c) => c.id)).toEqual([n.id]);
    expect(findContactsByWaIds(['966500000002@c.us'])).toEqual([]);
  });

  it('detects mentions: Latin on word boundaries, Arabic as substring', () => {
    const nora = addContact({ display_name: 'Nora', aliases: ['نورة'] });
    addContact({ display_name: 'Al' }); // too short: ignored
    expect(findMentionedContacts('reply to Nora please').map((c) => c.id)).toEqual([nora.id]);
    expect(findMentionedContacts('Norah is someone else')).toEqual([]);
    expect(findMentionedContacts('رد على ونورة').map((c) => c.id)).toEqual([nora.id]);
    expect(findMentionedContacts('call Al now')).toEqual([]);
  });

  it('update merges aliases and appends notes once', () => {
    const c = addContact({ display_name: 'Sara', aliases: ['S'], notes: 'likes voice notes' });
    updateContact(c.id, { aliases: ['Sarah'], appendNotes: 'prefers mornings' });
    updateContact(c.id, { appendNotes: 'prefers mornings' });
    const u = getContact(c.id)!;
    expect(contactAliases(u)).toEqual(['S', 'Sarah']);
    expect(u.notes).toBe('likes voice notes\nprefers mornings');
  });

  it('upsertContactByName fills only empty fields', () => {
    const c = addContact({ display_name: 'Nora', relationship: 'colleague' });
    const r = upsertContactByName({ display_name: 'nora', relationship: 'friend', language_pref: 'ar-najdi', notes: 'HR lead' });
    expect(r.created).toBe(false);
    expect(r.contact.id).toBe(c.id);
    expect(r.contact.relationship).toBe('colleague');
    expect(r.contact.language_pref).toBe('ar-najdi');
    expect(r.contact.notes).toBe('HR lead');
    expect(upsertContactByName({ display_name: 'Omar' }).created).toBe(true);
  });
});

describe('[People] block', () => {
  it('includes language, notes and the contact’s open loops', () => {
    const n = addContact({ display_name: 'Nora', language_pref: 'ar-najdi', notes: 'HR lead at a client', wa_chat_id: '966500000001@c.us' });
    createLoop({ kind: 'await_reply', summary: 'her answer on Thursday', contact_id: n.id });
    const block = buildPeopleBlock('did Nora answer?');
    expect(block).toContain('[People');
    expect(block).toContain('language: ar-najdi');
    expect(block).toContain('HR lead at a client');
    expect(block).toContain('her answer on Thursday');
    expect(buildPeopleBlock('nothing relevant')).toBe('');
  });
});

describe('contacts-cli', () => {
  it('add / find / update / show / list', () => {
    expect(runContactsCli(['add', '--name', 'Nora', '--alias', 'نورة', '--wa', '966500000001@c.us', '--lang', 'ar-najdi']).code).toBe(0);
    expect(runContactsCli(['add', '--name', 'nora']).code).toBe(1); // duplicate
    expect(runContactsCli(['find', 'نورة']).out).toContain('Nora');
    expect(runContactsCli(['update', '1', '--rel', 'client', '--add-note', 'prefers voice']).out).toContain('client');
    const show = runContactsCli(['show', 'Nora']);
    expect(show.out).toContain('prefers voice');
    expect(show.out).toContain('Open loops: none');
    expect(runContactsCli(['list']).out).toContain('#1 Nora');
    expect(runContactsCli(['bogus']).code).toBe(1);
  });
});

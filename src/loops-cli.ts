#!/usr/bin/env node
/**
 * ClaudeClaw open-loops CLI. The agent's ONLY way to "track / follow up /
 * remind": state lives in SQLite and the main process fires it (WhatsApp
 * reply, due time, expiry). Never write polling scripts instead.
 *
 *   node dist/loops-cli.js add --kind await_reply --contact "Nora" \
 *        --summary "Nora's answer on the Thursday meeting" \
 *        --intent "Draft a reply in her language and ask Mohamed before sending" \
 *        [--chat 9665XXXXXXXX@c.us] [--due 4h] [--expires 7d] \
 *        [--origin telegram|whatsapp-self|whatsapp:<chatId>] [--max-fires 1]
 *   node dist/loops-cli.js add --kind reminder --due 2026-09-22T09:00+03:00 --summary "..." --intent "..."
 *   node dist/loops-cli.js list [--all] [--contact Nora]
 *   node dist/loops-cli.js show <id>
 *   node dist/loops-cli.js close <id> [resolution]
 *   node dist/loops-cli.js snooze <id> <2h | ISO time>
 *   node dist/loops-cli.js drop <id> [reason]
 *   node dist/loops-cli.js confirm <id>        (commitments captured by memory intake)
 */
import { pathToFileURL } from 'url';

import { initDatabase } from './db.js';
import { findContactByName, findContacts, getContact, waUserPart, type Contact } from './contacts.js';
import {
  closeLoop,
  confirmLoop,
  createLoop,
  dropLoop,
  formatLoopLine,
  getLoop,
  getWaitingReplyLoops,
  listLoops,
  loopWaIds,
  snoozeLoop,
  type LoopKind,
} from './open-loops.js';
import { flag, fmtTime, parseArgs, parseWhen } from './pa-cli-util.js';

const KINDS: LoopKind[] = ['await_reply', 'promise', 'reminder'];

export interface CliResult { code: number; out: string }

function resolveContact(ref: string | undefined): Contact | null | 'ambiguous' {
  if (!ref) return null;
  if (/^\d+$/.test(ref)) return getContact(Number(ref));
  const exact = findContactByName(ref);
  if (exact) return exact;
  const hits = findContacts(ref, 3);
  if (hits.length === 1) return hits[0];
  return hits.length > 1 ? 'ambiguous' : null;
}

function validOrigin(o: string): boolean {
  return o === 'telegram' || o === 'whatsapp-self' || /^whatsapp:.+/.test(o);
}

export function runLoopsCli(argv: string[], agentId = process.env.CLAUDECLAW_AGENT_ID || 'main'): CliResult {
  const [command, ...rest] = argv;
  const p = parseArgs(rest);
  const id = Number(p.positional[0]);
  const tail = p.positional.slice(1).join(' ').trim();
  const needId = (): CliResult | null =>
    Number.isInteger(id) && id > 0 ? null : { code: 1, out: `Usage: loops-cli ${command} <id> ...` };

  switch (command) {
    case 'add': {
      const kind = flag(p, 'kind') as LoopKind | undefined;
      const summary = flag(p, 'summary') ?? p.positional.join(' ');
      if (!kind || !KINDS.includes(kind)) return { code: 1, out: `--kind must be one of ${KINDS.join('|')}` };
      if (!summary?.trim()) return { code: 1, out: '--summary is required' };

      const contactRef = flag(p, 'contact');
      const contact = resolveContact(contactRef);
      if (contact === 'ambiguous') return { code: 1, out: `--contact "${contactRef}" matches several contacts; use the id (contacts-cli find "${contactRef}")` };
      if (contactRef && !contact) return { code: 1, out: `No contact "${contactRef}". Add it first: contacts-cli add --name "${contactRef}" --wa <chatId>` };

      const chat = flag(p, 'chat') ?? null;
      const origin = flag(p, 'origin') ?? 'telegram';
      if (!validOrigin(origin)) return { code: 1, out: '--origin must be telegram | whatsapp-self | whatsapp:<chatId>' };

      let due: number | null = null;
      const dueRaw = flag(p, 'due');
      if (dueRaw) {
        due = parseWhen(dueRaw);
        if (due === null) return { code: 1, out: `Can't parse --due "${dueRaw}" (use 30m, 4h, 2d or ISO with offset, e.g. 2026-09-22T09:00+03:00)` };
      }
      let expires: number | null = null;
      const expRaw = flag(p, 'expires');
      if (expRaw) {
        expires = parseWhen(expRaw);
        if (expires === null) return { code: 1, out: `Can't parse --expires "${expRaw}"` };
      }
      if (kind !== 'await_reply' && due === null) return { code: 1, out: `--due is required for ${kind}` };

      if (kind === 'await_reply') {
        const probe = { chat_ref: chat, contact_id: contact?.id ?? null } as Parameters<typeof loopWaIds>[0];
        const ids = loopWaIds(probe, contact);
        if (ids.length === 0) {
          return { code: 1, out: 'await_reply needs --chat <WhatsApp chat id> or a --contact with a WhatsApp id/phone (contacts-cli update <id> --wa ...)' };
        }
        // One watcher per chat: the 2026-09-21 incident had two pollers on one contact.
        if (flag(p, 'force') === undefined) {
          const parts = new Set(ids.map(waUserPart));
          const dup = getWaitingReplyLoops().find((l) => loopWaIds(l).some((x) => parts.has(waUserPart(x))));
          if (dup) return { code: 0, out: `Already watching this chat: loop #${dup.id} (${dup.summary}). Not creating a duplicate; use --force to add another.` };
        }
      }

      const maxFires = Number(flag(p, 'max-fires') ?? '1');
      const loop = createLoop({
        kind,
        summary,
        intent_prompt: flag(p, 'intent') ?? '',
        contact_id: contact?.id ?? null,
        channel: flag(p, 'channel') ?? (kind === 'await_reply' ? 'whatsapp' : 'internal'),
        chat_ref: chat,
        origin,
        due_at: due,
        expires_at: expires,
        max_fires: Number.isFinite(maxFires) && maxFires > 0 ? Math.floor(maxFires) : 1,
        created_by_agent: agentId,
      });
      return {
        code: 0,
        out: [
          `Loop #${loop.id} created (${loop.kind}, status ${loop.status}).`,
          contact ? `Contact:  ${contact.display_name} (#${contact.id})` : '',
          loop.chat_ref ? `Chat:     ${loop.chat_ref}` : '',
          loop.due_at ? `Due:      ${fmtTime(loop.due_at)}` : '',
          `Expires:  ${fmtTime(loop.expires_at)}`,
          `Reports to: ${loop.origin}`,
        ].filter(Boolean).join('\n'),
      };
    }

    case 'list': {
      let contactId: number | undefined;
      const cref = flag(p, 'contact');
      if (cref) {
        const c = resolveContact(cref);
        if (!c || c === 'ambiguous') return { code: 1, out: `Contact "${cref}" not found or ambiguous` };
        contactId = c.id;
      }
      const loops = listLoops({ includeClosed: flag(p, 'all') !== undefined, contactId, limit: 100 });
      if (loops.length === 0) return { code: 0, out: 'No open loops.' };
      return { code: 0, out: loops.map((l) => `${formatLoopLine(l)}  [${l.status}]`).join('\n') };
    }

    case 'show': {
      const bad = needId(); if (bad) return bad;
      const l = getLoop(id);
      if (!l) return { code: 1, out: `No loop #${id}` };
      const c = l.contact_id ? getContact(l.contact_id) : null;
      return {
        code: 0,
        out: [
          `#${l.id} ${l.kind} [${l.status}]${l.needs_confirmation ? ' UNCONFIRMED' : ''}`,
          `Summary:  ${l.summary}`,
          `Intent:   ${l.intent_prompt || '-'}`,
          `Contact:  ${c ? `${c.display_name} (#${c.id})` : '-'}`,
          `Chat:     ${l.chat_ref ?? '-'} (${l.channel})`,
          `Due:      ${fmtTime(l.due_at)}   Next check: ${fmtTime(l.next_check_at)}   Expires: ${fmtTime(l.expires_at)}`,
          `Fired:    ${l.fired_count}/${l.max_fires}   Origin: ${l.origin}   By: ${l.created_by_agent}`,
          `Resolution: ${l.resolution ?? '-'}`,
        ].join('\n'),
      };
    }

    case 'close': {
      const bad = needId(); if (bad) return bad;
      return closeLoop(id, tail || undefined)
        ? { code: 0, out: `Closed loop #${id}.` }
        : { code: 1, out: `Loop #${id} not found or already closed.` };
    }

    case 'drop': {
      const bad = needId(); if (bad) return bad;
      return dropLoop(id, tail || undefined)
        ? { code: 0, out: `Dropped loop #${id}.` }
        : { code: 1, out: `Loop #${id} not found or already closed.` };
    }

    case 'snooze': {
      const bad = needId(); if (bad) return bad;
      const until = parseWhen(tail);
      if (until === null) return { code: 1, out: 'Usage: loops-cli snooze <id> <30m | 2h | 1d | ISO time>' };
      return snoozeLoop(id, until)
        ? { code: 0, out: `Loop #${id} snoozed until ${fmtTime(until)}.` }
        : { code: 1, out: `Loop #${id} not found or already closed.` };
    }

    case 'confirm': {
      const bad = needId(); if (bad) return bad;
      return confirmLoop(id)
        ? { code: 0, out: `Loop #${id} confirmed; it will fire when due.` }
        : { code: 1, out: `Loop #${id} not found or not awaiting confirmation.` };
    }

    default:
      return { code: 1, out: 'Commands: add | list | show | close | snooze | drop | confirm' };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  initDatabase();
  const r = runLoopsCli(process.argv.slice(2));
  (r.code === 0 ? console.log : console.error)(r.out);
  process.exit(r.code);
}

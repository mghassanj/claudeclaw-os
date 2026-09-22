#!/usr/bin/env node
/**
 * ClaudeClaw Outbound CLI: the only supported way for an agent to act on
 * Mohamed's behalf towards other people (WhatsApp as him, email, calendar,
 * Jira/Slack posts, revokes). Agents PROPOSE; Mohamed approves on Telegram
 * (✅ / ❌) or with "YES <code>" in his WhatsApp self-chat; the gateway then
 * executes the exact text once and posts a receipt.
 *
 * Usage:
 *   node dist/outbound-cli.js propose wa --to <chatId|phone|name> --text "..." [--name "Nora"]
 *   node dist/outbound-cli.js propose wa --to <...> --text-file /path/to/draft.txt
 *   node dist/outbound-cli.js propose revoke --to <chatId> --message-id <waMsgId>
 *   node dist/outbound-cli.js propose email --account m.ghassan@jisr.net --to a@b.com [--to ...] [--cc ..] [--bcc ..]
 *        --subject "..." --text "..." | --text-file f [--html-file f] [--thread <gmailThreadId>] [--in-reply-to <Message-ID>]
 *   node dist/outbound-cli.js propose email --account <acct> --draft-id <gmailDraftId>     (send an existing draft as-is)
 *   node dist/outbound-cli.js propose calendar --account <acct> --action create --summary "..." --start 2026-09-30T10:00
 *        --end 2026-09-30T11:00 [--attendee x@y]... [--tz Asia/Riyadh] [--location ..] [--description ..] [--conference] [--calendar primary]
 *   node dist/outbound-cli.js propose calendar --account <acct> --action update --event-id <id> [--summary|--start+--end|--attendee|...]
 *   node dist/outbound-cli.js propose calendar --account <acct> --action cancel --event-id <id>
 *   node dist/outbound-cli.js propose jira|slack|other --to <target> --text "..." [--payload '{json}']
 *   node dist/outbound-cli.js status <id>
 *   node dist/outbound-cli.js list [--limit 20] [--status executed] [--to <name|chatId>] [--json]
 *   node dist/outbound-cli.js complete <id> --receipt '{"ref":"..."}'     (approved email/calendar/jira/slack/other only)
 *   node dist/outbound-cli.js find <name|phone>                            (WhatsApp contact lookup)
 *   node dist/outbound-cli.js read <chatId> [--since 2h|<unix>|<iso>] [--limit 20]
 *
 * Flags for propose: --force (repeat an identical action inside 10 min;
 * only when Mohamed explicitly asked), --agent <id>, --session <ref>,
 * --turn <ref>, --ttl-hours <n>.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// config.ts and kill-switches.ts read .env relative to cwd; agents call
// this CLI from their own working directory.
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.chdir(PROJECT_ROOT); } catch { /* keep cwd */ }
// Keep the agent-facing output to the CLI's own lines; the row is the audit trail.
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';

const { initDatabase } = await import('./db.js');
const outbound = await import('./outbound.js');
const { OutboundError, propose, getAction, listActions, complete, publicView, payloadText, waRequest, OUTBOUND_KINDS, defaultGoogleClient } = outbound;
const { GoogleAuthError, parseAddress } = await import('./google-executor.js');

/** Bare addresses for the row's target column (names stay in the payload). */
function addressesOnly(list: string[]): string {
  return list.map((a) => { try { return parseAddress(a).email; } catch { return a; } }).join(', ');
}

type Flags = Record<string, string | true>;

function parseArgs(argv: string[]): { positional: string[]; flags: Flags; multi: Record<string, string[]> } {
  const positional: string[] = [];
  const flags: Flags = {};
  const multi: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; (multi[key] ??= []).push(next); i++; }
    } else positional.push(a);
  }
  return { positional, flags, multi };
}

/** Repeatable, comma-separable flag values: --to a@x --to b@y  or  --to "a@x, b@y". */
function listFlag(multi: Record<string, string[]>, ...keys: string[]): string[] {
  const out: string[] = [];
  for (const k of keys) for (const v of multi[k] ?? []) out.push(...v.split(',').map((x) => x.trim()).filter(Boolean));
  return out;
}

function readTextFlag(flags: Flags, inline: string, file: string): string | undefined {
  const f = str(flags[file]);
  if (f) return fs.readFileSync(f, 'utf-8');
  return str(flags[inline]);
}

/** Build + pre-check an email payload (reads the draft / thread from Gmail so the card shows exactly what will go out). */
async function buildEmailPayload(flags: Flags, multi: Record<string, string[]>): Promise<{ payload: Record<string, unknown>; target: string; name: string }> {
  const account = str(flags.account);
  if (!account) die('--account is required for email (the Google account to send from, e.g. m.ghassan@jisr.net or semo.790@gmail.com)');
  const google = defaultGoogleClient();
  const draftId = str(flags['draft-id']);
  if (draftId) {
    for (const f of ['to', 'cc', 'bcc', 'subject', 'text', 'text-file', 'html-file', 'thread', 'in-reply-to']) {
      if (flags[f] !== undefined) die(`--${f} can't be combined with --draft-id: the draft is sent exactly as it is in Gmail. Edit the draft instead.`);
    }
    const d = await google.getDraft(account.toLowerCase(), draftId);
    const payload = {
      account, draftId, draftMessageId: d.messageId, to: d.to, cc: d.cc, bcc: d.bcc,
      subject: d.subject, body: d.body, ...(d.threadId ? { threadId: d.threadId } : {}), attachments: d.attachments,
    };
    return { payload, target: addressesOnly(d.to), name: d.subject };
  }
  const to = listFlag(multi, 'to');
  const subjectFlag = str(flags.subject);
  const body = readTextFlag(flags, 'text', 'text-file');
  const htmlFile = str(flags['html-file']);
  const html = htmlFile ? fs.readFileSync(htmlFile, 'utf-8') : undefined;
  const threadId = str(flags.thread);
  let inReplyTo = str(flags['in-reply-to']);
  let references = str(flags.references);
  let subject = subjectFlag;
  if (threadId && !inReplyTo) {
    // Reply properly: thread it on the recipients' side too (In-Reply-To / References).
    const info = await google.threadReplyInfo(account.toLowerCase(), threadId);
    inReplyTo = info.inReplyTo;
    references = references ?? info.references;
    if (!subject && info.subject) subject = /^re:/i.test(info.subject) ? info.subject : `Re: ${info.subject}`;
  }
  const payload = {
    account, to, cc: listFlag(multi, 'cc'), bcc: listFlag(multi, 'bcc'), subject: subject ?? '', body: body ?? '',
    ...(html ? { html } : {}), ...(threadId ? { threadId } : {}), ...(inReplyTo ? { inReplyTo } : {}), ...(references ? { references } : {}),
  };
  return { payload, target: addressesOnly(to), name: subject ?? '' };
}

async function buildCalendarPayload(flags: Flags, multi: Record<string, string[]>): Promise<{ payload: Record<string, unknown>; target: string; name: string }> {
  const account = str(flags.account);
  if (!account) die('--account is required for calendar (whose calendar, e.g. m.ghassan@jisr.net)');
  const action = str(flags.action) ?? 'create';
  const calendarId = str(flags.calendar) ?? 'primary';
  const eventId = str(flags['event-id']);
  const attendees = multi.attendee || multi.attendees ? listFlag(multi, 'attendee', 'attendees') : undefined;
  const payload: Record<string, unknown> = {
    account, action, calendarId,
    ...(eventId ? { eventId } : {}),
    ...(str(flags.summary) !== undefined ? { summary: str(flags.summary) } : {}),
    ...(str(flags.start) ? { start: str(flags.start) } : {}),
    ...(str(flags.end) ? { end: str(flags.end) } : {}),
    ...(str(flags.tz) || str(flags['time-zone']) ? { timeZone: str(flags.tz) ?? str(flags['time-zone']) } : {}),
    ...(attendees ? { attendees } : {}),
    ...(str(flags.location) !== undefined ? { location: str(flags.location) } : {}),
    ...(readTextFlag(flags, 'description', 'description-file') !== undefined ? { description: readTextFlag(flags, 'description', 'description-file') } : {}),
    ...(flags.conference === true ? { conference: true } : {}),
  };
  let name = str(flags.summary) ?? '';
  if ((action === 'update' || action === 'cancel') && eventId) {
    // Show Mohamed which event this touches (and that it exists).
    const ev = await defaultGoogleClient().getEvent(account.toLowerCase(), calendarId, eventId);
    payload.current = { summary: ev.summary, start: ev.start, end: ev.end, attendees: ev.attendees };
    name = name || ev.summary || eventId;
  }
  const target = (attendees ?? []).join(', ') || account.toLowerCase();
  return { payload, target, name };
}

const str = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

function die(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

function fmtTime(sec: number | null): string {
  return sec ? new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 19) + 'Z' : '-';
}

function printAction(a: import('./outbound.js').OutboundAction): void {
  console.log(`#${a.id} [${a.status}] ${a.kind} → ${a.target_name ? `${a.target_name} (${a.target})` : a.target}`);
  console.log(`  agent: ${a.requested_by_agent}   created: ${fmtTime(a.created_at)}   expires: ${fmtTime(a.expires_at)}`);
  if (a.decided_at) console.log(`  decided: ${fmtTime(a.decided_at)} via ${a.decided_via ?? '?'}`);
  if (a.executed_at) console.log(`  executed: ${fmtTime(a.executed_at)}`);
  if (a.receipt) console.log(`  receipt: ${a.receipt}`);
  if (a.error) console.log(`  error: ${a.error}`);
  console.log(`  text: ${payloadText(a).replace(/\n/g, '\n        ')}`);
}

/** Parse "2h", "30m", "1d", unix seconds, or an ISO date into unix seconds. */
function parseSince(v: string): number {
  const rel = v.match(/^(\d+)\s*([mhd])$/i);
  if (rel) {
    const mult = { m: 60, h: 3600, d: 86400 }[rel[2].toLowerCase() as 'm' | 'h' | 'd'];
    return Math.floor(Date.now() / 1000) - Number(rel[1]) * mult;
  }
  if (/^\d{9,11}$/.test(v)) return Number(v);
  const t = Date.parse(v);
  if (Number.isNaN(t)) die(`Bad --since "${v}" (use 30m, 2h, 1d, unix seconds or ISO)`);
  return Math.floor(t / 1000);
}

async function resolveWaTarget(to: string): Promise<{ chatId: string; name?: string }> {
  if (/@(c\.us|g\.us|lid)$/.test(to)) return { chatId: to };
  if (/^[+\d\s()-]{7,}$/.test(to)) return { chatId: `${to.replace(/[^\d]/g, '')}@c.us` };
  const { status, data } = await waRequest('GET', `/contacts/find?q=${encodeURIComponent(to)}`);
  if (status !== 200) die(`Contact lookup failed (HTTP ${status}): ${data?.error ?? ''}`);
  const matches = (data?.matches ?? []) as Array<{ id: string; name?: string; number?: string; isGroup?: boolean }>;
  if (matches.length === 1) return { chatId: matches[0].id, name: matches[0].name };
  if (matches.length === 0) die(`No WhatsApp contact matches "${to}". Use "find" with another spelling, or pass the chat id.`);
  const exact = matches.filter((m) => (m.name ?? '').toLowerCase() === to.toLowerCase());
  if (exact.length === 1) return { chatId: exact[0].id, name: exact[0].name };
  die(`"${to}" matches ${matches.length} chats; pass --to <chatId>:\n` +
    matches.slice(0, 15).map((m) => `  ${m.id}  ${m.name ?? ''} ${m.number ? `(+${m.number})` : ''}${m.isGroup ? ' [group]' : ''}`).join('\n'));
}

async function main(): Promise<void> {
  const { positional, flags, multi } = parseArgs(process.argv.slice(2));
  const [command, ...rest] = positional;
  const agent = str(flags.agent) ?? process.env.CLAUDECLAW_AGENT_ID ?? 'main';

  switch (command) {
    case 'propose': {
      initDatabase();
      let kind = rest[0] as string | undefined;
      if (kind === 'wa' || kind === 'whatsapp') kind = 'wa_message';
      if (!kind || !(OUTBOUND_KINDS as readonly string[]).includes(kind)) {
        die(`Usage: outbound-cli propose <wa|${OUTBOUND_KINDS.filter((k) => k !== 'wa_message').join('|')}> --to <target> --text "..."`);
      }
      if (kind === 'email' || kind === 'calendar') {
        const built = kind === 'email' ? await buildEmailPayload(flags, multi) : await buildCalendarPayload(flags, multi);
        const ttlG = str(flags['ttl-hours']);
        const resG = await propose({
          kind, target: built.target || String(built.payload.account), targetName: built.name, payload: built.payload, agent,
          sessionRef: str(flags.session), turnRef: str(flags.turn),
          force: flags.force === true, ttlHours: ttlG ? Number(ttlG) : undefined,
        });
        console.log(`PROPOSED #${resG.action.id} (${kind} as ${String(built.payload.account).toLowerCase()} → ${resG.action.target}).`);
        console.log(resG.action.tg_message_id
          ? 'Mohamed has the full details on Telegram (✅ / ❌) and can also reply "YES <code>" in his WhatsApp self-chat.'
          : 'WARNING: could not post the approval card to Telegram; tell Mohamed to check /outbox.');
        console.log(`Nothing has been ${kind === 'email' ? 'sent' : 'changed or sent to attendees'}. On approval the gateway does it and posts the receipt; check with: outbound-cli status ${resG.action.id}`);
        break;
      }
      const to = str(flags.to);
      if (!to) die('--to is required');
      let text = str(flags.text);
      const textFile = str(flags['text-file']);
      if (textFile) text = fs.readFileSync(textFile, 'utf-8');
      let payload: Record<string, unknown> = {};
      const payloadJson = str(flags.payload);
      if (payloadJson) {
        try { payload = JSON.parse(payloadJson); } catch { die('--payload must be valid JSON'); }
      }
      if (text !== undefined) payload.text = text;
      const messageId = str(flags['message-id']);
      if (messageId) payload.messageId = messageId;

      let target = to;
      let targetName = str(flags.name);
      if (kind === 'wa_message' || kind === 'revoke') {
        const r = await resolveWaTarget(to);
        target = r.chatId;
        targetName = targetName ?? r.name;
      }
      const ttl = str(flags['ttl-hours']);
      const res = await propose({
        kind: kind as import('./outbound.js').OutboundKind,
        target, targetName, payload, agent,
        sessionRef: str(flags.session), turnRef: str(flags.turn),
        force: flags.force === true, ttlHours: ttl ? Number(ttl) : undefined,
      });
      if (res.autonomous) {
        console.log(res.outcome?.ok ? `EXECUTED (autonomous contact): ${res.outcome.message}` : `FAILED: ${res.outcome?.message}`);
        if (!res.outcome?.ok) process.exit(2);
        break;
      }
      console.log(`PROPOSED #${res.action.id} (${res.action.kind} → ${res.action.target_name || res.action.target}).`);
      console.log(res.action.tg_message_id
        ? 'Mohamed has the draft on Telegram (✅ Send / ❌ Cancel) and can also reply "YES <code>" in his WhatsApp self-chat.'
        : 'WARNING: could not post the approval card to Telegram; tell Mohamed to check /outbox.');
      console.log(`Nothing has been sent. Tell Mohamed it is awaiting his approval; check later with: outbound-cli status ${res.action.id}`);
      break;
    }

    case 'status': {
      initDatabase();
      const id = Number(rest[0]);
      if (!Number.isInteger(id)) die('Usage: outbound-cli status <id>');
      listActions({ limit: 1 }); // expires stale proposals first
      const a = getAction(id);
      if (!a) die(`#${id} not found`);
      if (flags.json) console.log(JSON.stringify(publicView(a), null, 2));
      else printAction(a);
      break;
    }

    case 'list': {
      initDatabase();
      const limit = Number(str(flags.limit) ?? '20') || 20;
      const rows = listActions({
        limit,
        status: str(flags.status) as import('./outbound.js').OutboundStatus | undefined,
        target: str(flags.to),
        sinceSec: str(flags.since) ? parseSince(str(flags.since)!) : undefined,
        agent: str(flags['by-agent']),
      });
      if (flags.json) { console.log(JSON.stringify(rows.map(publicView), null, 2)); break; }
      if (rows.length === 0) { console.log('No outbound actions match.'); break; }
      for (const a of rows) { printAction(a); console.log(); }
      break;
    }

    case 'complete': {
      initDatabase();
      const id = Number(rest[0]);
      const receiptRaw = str(flags.receipt);
      if (!Number.isInteger(id) || !receiptRaw) die(`Usage: outbound-cli complete <id> --receipt '{"ref":"..."}'  (use {"error":"..."} if it failed)`);
      let receipt: Record<string, unknown>;
      try { receipt = JSON.parse(receiptRaw); } catch { die('--receipt must be valid JSON'); }
      const res = await complete(id, receipt);
      console.log(res.message);
      if (!res.ok) process.exit(2);
      break;
    }

    case 'find': {
      const q = rest.join(' ').trim();
      if (!q) die('Usage: outbound-cli find <name|phone>');
      const { status, data } = await waRequest('GET', `/contacts/find?q=${encodeURIComponent(q)}`);
      if (status !== 200) die(`HTTP ${status}: ${data?.error ?? ''}`);
      const matches = (data?.matches ?? []) as Array<{ id: string; name?: string; number?: string; isGroup?: boolean }>;
      if (!matches.length) { console.log('No matches.'); break; }
      for (const m of matches) console.log(`${m.id}  ${m.name ?? ''}${m.number ? `  +${m.number}` : ''}${m.isGroup ? '  [group]' : ''}`);
      break;
    }

    case 'read': {
      const chatId = rest[0];
      if (!chatId) die('Usage: outbound-cli read <chatId> [--since 2h] [--limit 20]');
      const q = new URLSearchParams();
      if (str(flags.since)) q.set('since', String(parseSince(str(flags.since)!)));
      q.set('limit', str(flags.limit) ?? '20');
      const { status, data } = await waRequest('GET', `/chats/${encodeURIComponent(chatId)}/messages?${q}`);
      if (status !== 200) die(`HTTP ${status}: ${data?.error ?? ''}`);
      if (flags.json) { console.log(JSON.stringify(data, null, 2)); break; }
      const msgs = (data?.messages ?? []) as Array<{ id: string; fromMe: boolean; author?: string; body: string; timestamp: number; type: string }>;
      if (!msgs.length) { console.log('No messages in range.'); break; }
      for (const m of msgs) {
        console.log(`${fmtTime(m.timestamp)} ${m.fromMe ? 'Mohamed' : (m.author ?? 'them')}: ${m.type !== 'chat' ? `[${m.type}] ` : ''}${m.body}`);
        console.log(`  id: ${m.id}`);
      }
      break;
    }

    default:
      die('Commands: propose | status | list | complete | find | read   (see header of src/outbound-cli.ts)');
  }
}

main().catch((err) => {
  if (err instanceof OutboundError) die(`REFUSED (${err.code}): ${err.message}`, 3);
  if (err instanceof GoogleAuthError) die(`REFUSED (google_auth): ${err.message}. Tell Mohamed; don't retry.`, 3);
  die(`ERROR: ${err?.message ?? err}`);
});

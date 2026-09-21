## Open loops and contacts

<!-- Paste this section into ~/.claudeclaw/agents/main/CLAUDE.md. -->

Run these CLIs from the project root. It holds the `.env` they need:

```bash
cd /home/ubuntu/claudeclaw-os && node dist/loops-cli.js <command> ...
cd /home/ubuntu/claudeclaw-os && node dist/contacts-cli.js <command> ...
```

### Open loops: how you follow up

An open loop is a follow-up stored in the database. It survives your turn ending and a restart. The main process fires it and runs a new turn for you. You get one of these prompts:

- `[Open loop #N fired]`: the contact replied.
- `[Open loop #N due]`: a reminder or promise is due.
- `[Open loop #N deadline]`: you set `--due` on an await_reply loop and no reply came by then.

Your answer goes to Mohamed on the loop's origin.

**Rules**

1. Create a loop every time you say or imply "I'll track / follow up / remind / get back to you / watch for their reply". Create it in the same turn, before you reply. If you don't create a loop, don't make the promise.
2. **Never write polling scripts:** no `while(true)`, no `sleep` loops, no DevTools/puppeteer watchers, no background `node` scripts that wait for messages. The WhatsApp service already feeds each inbound message to the loop matcher.
3. There is one watcher per chat. `loops-cli add` refuses to create a duplicate `await_reply` loop for a chat that is already watched. Reuse the existing loop and don't pass `--force` to get around it.
4. When a loop fires, act on its intent, then close it with `loops-cli close <id> "<what happened>"`. If more is needed, snooze it, or add a new loop.
5. A fired loop does not approve sending anything. When a reply to a third party is needed, draft it and ask Mohamed. "Respond accordingly" means draft and ask. Only Mohamed's approval of that exact text sends it.
6. `[Open loops]` at the top of each turn lists the active loops, overdue first. Mention overdue ones when relevant. When one no longer matters, close it or drop it with `loops-cli drop`.
7. Memory intake can capture a commitment on its own. It shows as `UNCONFIRMED` and never fires. Ask Mohamed, then run `loops-cli confirm <id>` or `loops-cli drop <id>`.

**Kinds**

| kind | use for | needs |
|---|---|---|
| `await_reply` | "track her reply and respond" | `--contact <name/id>` with a WhatsApp id, or `--chat <WhatsApp chat id>` |
| `reminder` | "remind me at 5pm" | `--due` |
| `promise` | "I'll send the summary tomorrow" | `--due` |

**Origin (where the result is delivered)**

- If the request came from the WhatsApp self-chat, pass `--origin whatsapp-self`.
- Otherwise leave the default, `telegram`.

**Examples**

```bash
# "Go ahead, track her reply and respond accordingly" (from the WhatsApp self-chat)
node dist/loops-cli.js add --kind await_reply --contact "Nora" \
  --summary "Nora's answer on the Thursday meeting" \
  --intent "Summarise her reply for Mohamed and draft a response in Najdi Arabic; ask before sending" \
  --origin whatsapp-self --expires 3d

# Reply deadline: nudge if nothing comes back by 6pm Riyadh time
node dist/loops-cli.js add --kind await_reply --contact "Nora" --summary "..." --intent "..." --due 2026-09-22T18:00+03:00

# Reminder
node dist/loops-cli.js add --kind reminder --due 2h --summary "Call the bank about the transfer" --intent "Remind Mohamed"

node dist/loops-cli.js list            # active loops (--all includes closed)
node dist/loops-cli.js show 12
node dist/loops-cli.js close 12 "She confirmed Thursday; Mohamed approved and I sent the reply"
node dist/loops-cli.js snooze 12 1d    # also 30m, 4h, or an ISO time with an offset
node dist/loops-cli.js drop 12 "No longer needed"
node dist/loops-cli.js confirm 15      # an UNCONFIRMED commitment from memory intake
```

**Time formats**

- Relative: `30m`, `4h`, `2d`, `1w`.
- Absolute: ISO with an explicit offset, e.g. `2026-09-22T09:00+03:00`. The host runs in UTC.

The default expiry is 7 days, or 1 day after `--due` if that is later. When a loop expires unresolved, Mohamed is told once on Telegram.

Mohamed can see the loops with `/loops` on Telegram and close them from there.

### Contacts: who people are

The `contacts` table is your people directory. When a message mentions a known name or alias, you get a `[People]` block with:

- the contact's language preference and notes;
- their open loops;
- their last interaction.

**Rules**

1. Before messaging or discussing someone, run `contacts-cli find <name>`. Use their `language_pref`: `ar-najdi` means reply in Najdi Arabic.
2. When you learn who someone is (role, org, relationship, language, WhatsApp id), add or update them. Memory intake also upserts people it detects, so check for duplicates with `find` first.
3. An `await_reply` loop needs the contact's WhatsApp id. Set it with `--wa`.
4. Store only what helps you assist Mohamed. Keep secrets and sensitive personal data out of `notes`.

```bash
node dist/contacts-cli.js find "Nora"
node dist/contacts-cli.js add --name "Nora" --alias "نورة" --wa 9665XXXXXXXX@c.us \
  --rel "HR lead" --org "Client X" --lang ar-najdi --notes "Prefers short voice-friendly messages"
node dist/contacts-cli.js update 3 --alias "Noura" --add-note "Out of office until Sunday"
node dist/contacts-cli.js show "Nora"      # details, open loops, last interaction
node dist/contacts-cli.js list
```

Flags:

- `--name`, `--alias` (repeatable), `--wa`, `--phone`, `--telegram`, `--email`, `--rel`, `--org`, `--lang`, `--notes`, `--pin` / `--unpin`.
- On `update`, `--alias` adds to the aliases and `--add-note` appends to the notes.
- `-` clears a field.

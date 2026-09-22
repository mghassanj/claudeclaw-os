## Acting on Mohamed's behalf (outbound gateway)

Anything that reaches another person as Mohamed goes through the outbound gateway. This covers WhatsApp messages as him, email, calendar invites, Jira or Slack posts, and deleting or revoking messages. You **propose**. Mohamed **approves**, either by tapping ✅ on Telegram or by replying `YES <code>` in his WhatsApp self-chat. The gateway then sends the exact approved text once and posts a receipt. Nothing you write in a reply counts as sending.

```bash
OB="node /home/ubuntu/claudeclaw-os/dist/outbound-cli.js"
```

### Propose

```bash
$OB find "Nora"                                  # name or phone -> WhatsApp chat id(s)
$OB propose wa --to "Nora" --text "…exact text…"  # or --to 9665XXXXXXXX@c.us, or --to +9665XXXXXXXX
$OB propose wa --to <chatId> --text-file /tmp/draft.txt   # for long or multi-line drafts
$OB propose revoke --to <chatId> --message-id <waMessageId>
```

### Email (sent by the gateway through Gmail)

```bash
# New email. --to/--cc/--bcc repeat or take a comma list; "Name <a@b.com>" works.
$OB propose email --account m.ghassan@jisr.net --to nora@x.com [--to ali@x.com] [--cc ..] [--bcc ..] \
    --subject "…" --text "…exact body…"          # or --text-file /tmp/body.txt, optional --html-file /tmp/body.html
# Reply in a Gmail thread (subject and In-Reply-To/References are filled from the thread):
$OB propose email --account m.ghassan@jisr.net --thread <gmailThreadId> --to nora@x.com --text-file /tmp/reply.txt
# Send a Gmail draft you already created, exactly as it is:
$OB propose email --account semo.790@gmail.com --draft-id <draftId>
```

- `--account` is the Google account it is sent from: `m.ghassan@jisr.net` (work) or `semo.790@gmail.com` (personal). Pick the one the conversation is on; ask if unsure.
- **Create Gmail drafts freely** with the workspace tools. **Sending only happens through `propose`.** You have no send tool, and you must not look for another way to send.
- A draft is sent only if it is unchanged since you proposed it. If you edit the draft afterwards, the send fails; propose it again.

### Calendar (written by the gateway; attendees get Google's invite/update/cancel email)

```bash
$OB propose calendar --account m.ghassan@jisr.net --action create --summary "Q4 review" \
    --start 2026-09-30T10:00 --end 2026-09-30T11:00 [--attendee nora@x.com]... \
    [--tz Asia/Riyadh] [--location "HQ"] [--description "…"] [--conference] [--calendar primary]
$OB propose calendar --account m.ghassan@jisr.net --action update --event-id <id> --start 2026-09-30T11:00 --end 2026-09-30T12:00
$OB propose calendar --account m.ghassan@jisr.net --action cancel --event-id <id>
```

- Times are ISO local times in `--tz` (default `Asia/Riyadh`), or dates like `2026-09-30` for all-day events (the end date is exclusive). The end must be after the start.
- `update` changes only the fields you pass. `--attendee` on update **replaces** the whole attendee list, so pass everyone.
- Read calendars and find event ids with the workspace tools. Create, change and cancel events **only** through `propose`.

### Jira, Slack, other

```bash
$OB propose jira|slack|other --to <target> --text "…" [--payload '{json}']
```

- Propose the **final text**, not a summary of it. The text you propose is exactly what will be sent.
- After proposing, tell Mohamed in one line that it's waiting for his approval, then end your turn. Don't wait or poll for the approval.
- If `--to` matches more than one chat, the CLI lists them. Pick the right chat id; never guess.
- `REFUSED (duplicate_pending|duplicate_recent)` means an identical action is already waiting or was sent in the last 10 minutes. Don't work around it. Use `--force` only when Mohamed explicitly asks to send the same thing again.
- WhatsApp, revoke, email and calendar are **executed by the gateway** once Mohamed approves. Don't do them yourself, and don't `complete` them.
- For Jira, Slack or other actions, approval only unlocks the action. You then do it yourself and record the result: `$OB complete <id> --receipt '{"ref":"…"}'`, or `'{"error":"…"}'` if it failed. Never do the action before `$OB status <id>` shows `approved`.
- `REFUSED (google_auth)` or a failed row saying "needs re-authorising" means that Google account's access has expired. Tell Mohamed; don't retry.

### Check before you claim

```bash
$OB list --limit 10                  # history: proposed / approved / executed / failed / rejected / expired
$OB list --to "Nora" --since 1d
$OB status <id>                      # one action, with its receipt (WhatsApp/Gmail message id, calendar event id + link)
```

Before saying what was or wasn't sent, check `$OB list`. Never answer from memory. If the log shows no `executed` row, nothing was sent.

### Read WhatsApp (read-only)

```bash
$OB read <chatId> --since 2h --limit 20
```

### Rules

- **One approval covers one exact text, once, to one recipient** (for email: the exact recipients, subject and body; for calendar: the exact event change). A changed word needs a new proposal. An approval never covers later replies.
- **"Respond accordingly", "handle it", "reply to her" mean draft and propose.** Never send later on your own because of an earlier "go ahead".
- **Never revoke, delete or edit** a message in anyone's chat without an approved `revoke` proposal for that specific message.
- **Never script WhatsApp Web.** That includes puppeteer/CDP, `DevToolsActivePort`, `WWebJS.*`, `sendRevokeMsgs`, and calling `127.0.0.1:9334/send*` directly. The runtime blocks these tool calls. If `$OB` can't do something you need, tell Mohamed; don't build a workaround.
- **Never write polling loops or background watchers** (`while(true)`, `nohup`, `&`) to wait for replies or approvals.
- After every executed action the gateway posts the receipt ("Sent to Nora ✓ … · id …", "Email sent from … ✓", "Calendar event created ✓ …"). Quote that receipt; don't restate it from memory.

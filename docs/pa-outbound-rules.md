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
$OB propose email --to someone@x.com --text "…" --payload '{"subject":"…"}'
```

- Propose the **final text**, not a summary of it. The text you propose is exactly what will be sent.
- After proposing, tell Mohamed in one line that it's waiting for his approval, then end your turn. Don't wait or poll for the approval.
- If `--to` matches more than one chat, the CLI lists them. Pick the right chat id; never guess.
- `REFUSED (duplicate_pending|duplicate_recent)` means an identical action is already waiting or was sent in the last 10 minutes. Don't work around it. Use `--force` only when Mohamed explicitly asks to send the same thing again.
- For email, calendar, Jira, Slack or other actions, approval only unlocks the action. You then do it yourself and record the result: `$OB complete <id> --receipt '{"ref":"…"}'`, or `'{"error":"…"}'` if it failed. Never do the action before `$OB status <id>` shows `approved`.

### Check before you claim

```bash
$OB list --limit 10                  # history: proposed / approved / executed / failed / rejected / expired
$OB list --to "Nora" --since 1d
$OB status <id>                      # one action, with its receipt (WhatsApp message id and time)
```

Before saying what was or wasn't sent, check `$OB list`. Never answer from memory. If the log shows no `executed` row, nothing was sent.

### Read WhatsApp (read-only)

```bash
$OB read <chatId> --since 2h --limit 20
```

### Rules

- **One approval covers one exact text, once, to one recipient.** A changed word needs a new proposal. An approval never covers later replies.
- **"Respond accordingly", "handle it", "reply to her" mean draft and propose.** Never send later on your own because of an earlier "go ahead".
- **Never revoke, delete or edit** a message in anyone's chat without an approved `revoke` proposal for that specific message.
- **Never script WhatsApp Web.** That includes puppeteer/CDP, `DevToolsActivePort`, `WWebJS.*`, `sendRevokeMsgs`, and calling `127.0.0.1:9334/send*` directly. The runtime blocks these tool calls. If `$OB` can't do something you need, tell Mohamed; don't build a workaround.
- **Never write polling loops or background watchers** (`while(true)`, `nohup`, `&`) to wait for replies or approvals.
- After every executed action the gateway posts the receipt ("Sent to Nora ✓ … · id …"). Quote that receipt; don't restate it from memory.

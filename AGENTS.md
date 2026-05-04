# Shared Responsibility Map

This file is a template. It is loaded into every delegated agent's context by the orchestrator and acts as the operating agreement between your agents. Edit it to match the agents you have actually configured and the workflows you care about. The example roles below (ops, research, comms, content) are starting points, not a prescribed setup.

## Core principles

1. **Execute, don't forward.** If a task falls inside your responsibilities, do it. Do not bounce it to another agent for "coordination."
2. **Delegate narrowly.** Delegation is allowed only when the task is clearly outside your listed responsibilities AND inside another agent's.
3. **Own the final answer.** The agent the user (or `main`) called is responsible for the end-to-end result, even if pieces of it are delegated.
4. **Report results, not plans.** When done, return the actual output, not a summary of who you asked.

## Agents (example roles)

### main

- **Mission:** Primary interface for the user over Telegram. Handles everything unless the task is clearly specialist work.
- **Primary responsibilities:** conversation, quick questions, note and file reads, schedule CLI, mission CLI, sending files via Telegram, invoking global skills.
- **Direct-execution tasks:** general chat, reads, calendar lookups, quick writes, shell commands, database checks, skill invocations.
- **Allowed delegation:** deep research briefs (`research`), multi-step comms campaigns (`comms`), long-form content production (`content`), admin and billing ops (`ops`).
- **Forbidden delegation:** single emails, one-off scheduling, calendar reads, status questions, anything the user expects back in under 10 seconds.
- **Inputs:** Telegram messages (text, voice transcripts, files).
- **Outputs:** Telegram replies, scheduled tasks, mission tasks, sent files.
- **Final answer ownership:** always. No other agent replies directly to the user.

### ops

- **Mission:** Operations and admin backbone: calendar, billing, system health, **and memory & knowledge infrastructure stewardship**.
- **Primary responsibilities:** calendar management, scheduling, billing and invoices, payment-platform admin, task follow-ups, service health checks, **maintaining the 5-layer memory architecture (SQLite conversational memory, Obsidian personal vault, per-project CLAUDE.md, skills, Neon RAG)**, **adding/maintaining RAG ingestion sources**, **routing facts to the right knowledge layer**.
- **Direct-execution tasks:** create or move calendar events, reconcile invoices, query billing APIs, check deploy status, run health checks, post maintenance updates, query the enterprise RAG via `mcp__rag__search_enterprise_kb`, write captures to `/home/ubuntu/vault/Inbox/Bot/ops/`, add or update ingestion sources at `/home/ubuntu/rag-platform/ingestion/sources/`, edit the architecture doc at `/home/ubuntu/claudeclaw-os/docs/architecture/memory-and-knowledge.md`.
- **Allowed delegation:** research on a vendor or process (→ `research`); outbound message to a customer (→ `comms`).
- **Forbidden delegation:** the admin/billing/memory-infrastructure work itself. If the user asked you about where a fact lives, where to put it, how RAG is doing, or how to add a source — you answer, not someone else.
- **Inputs:** admin requests, billing events, scheduling requests, memory-routing questions, RAG ingestion or maintenance tasks.
- **Outputs:** confirmed schedule changes, reconciled billing state, maintenance reports, knowledge-base search results, new ingestion sources, updated architecture docs.
- **Final answer ownership:** the ops agent for anything admin, finance, **or memory/knowledge infrastructure**.

### research

- **Mission:** Deep research and analysis with source verification.
- **Primary responsibilities:** web research, academic dives, competitive intel, market analysis, synthesis briefs.
- **Direct-execution tasks:** multi-source web browsing, reading papers and reports, building comparison tables, writing briefs with citations.
- **Allowed delegation:** ghostwriting the public-facing version of a brief (→ `content`); sending the brief to stakeholders (→ `comms`).
- **Forbidden delegation:** the actual researching itself. Never subcontract the reading or synthesis.
- **Inputs:** a research question with scope.
- **Outputs:** a cited brief (tables for comparisons, timelines for chronology) with confidence level per claim.
- **Final answer ownership:** research for anything investigatory.

### comms

- **Mission:** All human communication on the user's behalf.
- **Primary responsibilities:** email, chat platforms, direct messages, forum replies (e.g. Gmail, Outlook, Slack, WhatsApp, LinkedIn).
- **Direct-execution tasks:** draft replies, send messages (only after confirmation), maintain contact notes, triage inbox.
- **Allowed delegation:** research a recipient or topic before replying (→ `research`); calendar invite generation (→ `ops`).
- **Forbidden delegation:** any drafting work, tone matching, or reply-writing. That is this agent's job.
- **Inputs:** incoming messages, reply requests.
- **Outputs:** drafted or sent messages, contact updates.
- **Final answer ownership:** comms for anything interpersonal.

### content

- **Mission:** Content production across platforms.
- **Primary responsibilities:** scripts and outlines, posts for social platforms, content calendar, cross-platform repurposing, trend research for content ideation.
- **Direct-execution tasks:** script drafting, post writing, outline building, calendar updates, hook generation, repurposing.
- **Allowed delegation:** heavy research on a topic (→ `research`); scheduling a post (→ `ops`).
- **Forbidden delegation:** writing the script or post itself.
- **Inputs:** topic, platform, format.
- **Outputs:** finished script, post, or outline ready to use.
- **Final answer ownership:** content for anything published-facing.

## Anti-patterns: do not do these

- "Let me delegate that to X" when X is you, or when the user wanted a direct answer.
- Delegating to ask a clarifying question. Ask the user directly.
- Chaining: A → B → A → C. If you need two agents, gather inputs first, then call each once.
- Reporting delegation status instead of delegation output. The user wants the result, not a trace.
- Replying with "I've asked X to look into this." Either do the work or return the completed handoff.

## When to escalate to the user

- A task requires information only the user has.
- Two agents disagree on ownership (rare; flag it).
- The task is outside every agent's listed responsibilities.

In all three cases: one short question, then proceed.

## Browser automation

When a task requires driving a real browser (login flows, scraping pages without an API, posting to UIs without programmatic access):

1. **Use Playwright. Do not use Puppeteer.** New automation goes through Playwright (cleaner API, auto-waiting, better tracing). Existing Puppeteer code is fine to leave; do not migrate without a reason.
2. **Connect to the persistent Chrome at `ws://localhost:9333`. Never spawn a fresh browser.**
   - The headless Chrome at `/home/ubuntu/.chrome-profile` is logged into Google (Gmail / Drive / Calendar as `semo.790@gmail.com`). Calling `chromium.launch()` or `puppeteer.launch()` (a) loses that session and (b) re-triggers Google's bot detection.
   - The shared Chrome is launched outside this codebase and managed manually. If it is dead (`curl -sf http://localhost:9333/json/version` fails), **ask the user before relaunching** — a respawn requires re-logging into Google.

   ```js
   const { chromium } = require('playwright');
   const browser = await chromium.connectOverCDP('ws://localhost:9333');
   const context = browser.contexts()[0];      // reuse the context that has the Google session
   const page = await context.newPage();
   await page.goto('https://mail.google.com/');
   // ... do your work ...
   await page.close();                         // close the page, not the browser
   ```

3. **Never call `browser.close()` or `browser.disconnect()` with side effects.** Killing the singleton Chrome ends the user's Google session.
4. **Do not sign out, switch accounts, or change profile.** The Google session is shared with the user.
5. **Prefer dedicated MCPs when they exist.** For Gmail-specific work, `mcp__gmail__*` and `mcp__claude_ai_Gmail__*` are faster, more reliable, and do not appear in Google's account-activity log. Reach for the browser only when no MCP fits the task.
6. Install with `npm install playwright` if it is not in the working directory's `node_modules/`. **Do not run `npx playwright install`** — we attach to an external Chrome, not Playwright's bundled browsers.

## Investigation & Verification Protocol

When the user (or main) asks you to fix, debug, or verify something, you MUST follow this protocol. Skipping steps is the #1 reason agents claim "done" on broken work. This is **non-negotiable** — claim "done" only after you've executed all 6 steps.

### The 6-step protocol

**1. Read the actual error.**
- Pull the EXACT error text from logs — don't paraphrase, don't summarize away the stack trace.
- `sudo journalctl -u <service> --since "10 minutes ago" --no-pager` for systemd services
- `tail -200 /tmp/<service>-debug.log` for app-managed logs
- `sudo journalctl -u <service> -n 500 --no-pager | grep -iE "error|fail|warn|traceback"` for filtered scans
- For HTTP errors: capture status code AND response body AND headers, not just one
- For UI errors: ask the user to open DevTools console + paste the actual JS exception

**2. Pull all relevant logs (don't guess context).**
- System: `journalctl`, `dmesg`
- App: each service has its own log file or stream. Find them before reasoning. The bot's war room uses `/tmp/warroom-debug.log`. The dashboard logs to `journalctl -u claudeclaw`.
- Network: `sudo ss -tlnp | grep <port>`, `lsof -nP -iTCP:<port>`
- Process state: `ps -eo pid,ppid,etime,cmd | grep <name>`
- Recent file changes: `find <dir> -mmin -30 -type f`
- For DB issues: `psql "$DATABASE_URL" -c "<query>"` to see actual rows, not assumptions

**3. Verify paths and assumptions.**
- Does the file you're about to edit actually exist at the path you remembered? `ls -la <path>`
- Is the binary the version you think? `which <cmd>`, `<cmd> --version`
- Does the env var exist? `grep "^VARNAME=" .env` (and **mask the value** in any output)
- Is the service actually running? `systemctl is-active <name>`
- Don't write code based on "I think this is how it works" — confirm with the actual current state.

**4. Read the actual code (not your model of it).**
- `grep -nE "<pattern>" <file>` to find the relevant function
- `sed -n "<start>,<end>p" <file>` to read context around the line
- Trace data flow: where does X come from? What modifies it? Where does it go?
- Code is the source of truth, not docs, not comments, not your prior assumption.
- For shared state: check Postgres/SQLite tables, config files, env vars — don't assume.

**5. Form a hypothesis. State it explicitly. Make one minimal change.**
- Before editing, write out: *"I think X causes Y because Z. Fix proposal: change <file:line> from A to B."*
- Make ONE surgical change. Not three. Not a rewrite. Not refactoring while you're there.
- Read the diff before applying.
- If the bug is upstream of your code (a dependency, the OS, a third-party service): document it, don't paper over.

**6. End-to-end verify. NOT exit-code-zero.**
- Run the actual user-facing scenario, not just the command you changed.
- If it's a service: restart it, trigger the failing case, watch logs for your fix's signature in REAL traffic.
- If it's a query: run a test query and manually inspect the result.
- If it's a deploy: tail logs until the fix's signature shows up under real load.
- If you CANNOT do an end-to-end test, **say so explicitly** — see "What 'done' means" below.

### What "done" means — never use these phrases unless step 6 has executed

| ❌ Don't say | ✅ Say instead |
|---|---|
| "Done" | "Verified end-to-end with <specific test>: <observed result>" |
| "Fixed" | "Changed <file:line>. Re-ran <test> and got <expected output>." |
| "Should work now" | "I changed X. I cannot test Y; please run it and tell me what you see." |
| "All set" | "Migration applied; `\dt` shows 3 tables. Smoke test: inserted 4 rows, ran 3 queries, all returned expected hits." |
| "I've fixed it" (without test) | "I made the change. Pending verification — please <specific user action> and report what you see." |

The exit code of the last command is **not** a measure of success. A `psql` migration that returns 0 but didn't create the table you expected is a failure. A service `systemctl restart` that returns 0 but immediately crashes after boot is a failure. Always verify the OUTCOME, not the COMMAND.

### When to STOP and ASK rather than guessing

- After 2 failed fix attempts on the same bug: stop, write up what you've tried + observed, ask the user for direction. Don't infinite-loop.
- When the bug requires destroying data (drop table, delete files, force-push, reset --hard): **never** proceed without explicit confirmation in the current turn.
- When you need a credential or context you don't have: ask, don't fabricate.
- When the symptom doesn't match any testable hypothesis: ask the user *"I can't reproduce this — exactly what did you do, what error did you see, in which client?"*.

## ⚠️ STANDING RULE — Jisr Visual Assets (effective 2026-05-03, upgraded 2026-05-03)

**Every Jisr deck, document, or visual asset must stack all THREE standards below. No exceptions.**

This rule applies to ALL agents (content, comms, research, ops, main).

### Standard A — Jisr Design System (brand tokens)
- **Machine-readable tokens:** `/home/ubuntu/claudeclaw-os/out/jisr-design-tokens.json`
- **Human reference doc:** `/home/ubuntu/claudeclaw-os/out/jisr-design-system-tokens.md`
- **Source HTML (3.2MB):** `workspace/uploads/1777789952931_Jisr_Design_System__standalone_.html`

### Standard B — Executive Presentation Standards (structure)
6×6 rule, 10/20/30 rule, assertion-evidence slide structure, Tufte/Mayer principles, WCAG 4.5:1 contrast.

### Standard C — Jisr Deck Alignment Spec (visual composition) ← NEW 2026-05-03
- **Spec file:** `/home/ubuntu/claudeclaw-os/out/jisr-deck-alignment-spec.md`
- **Reference deck:** `workspace/uploads/1777791386845_Enterprise_Customization_Strategy_-_Standalone.html` (Mohammed-authored, 11 slides — gold standard for layout, padding, composition)

**Key alignment rules (no drift allowed):**
- Canvas: 1920×1080 → PPTX 10in × 5.625in
- Chrome: logo top=56px/left=80px; page# bottom=56px/right=80px; footer bottom=56px/left=80px
- Content left margin: 120px (0.625in); content top (default stage): 140px (0.729in)
- Eyebrow: 14px/600/UPPERCASE, 36px blue dash before, 32–48px gap below
- Headline anchors: h-large=88px/66pt, h-mid=64px/48pt, h-small=40px/30pt
- Tolerance: ≤8px anchor drift on chrome and headline positions
- Build scripts must use explicit `Inches()`/`Pt()` positioning — never auto-flow

### Key token summary
| Role | Token | Value |
|------|-------|-------|
| Primary text / dark bg | ink | `#101010` |
| Base background | paper | `#FFFFFF` |
| CTA / signal / links | blue | `#4783FC` |
| Success / positive | mint | `#42DCCC` |
| Emphasis / warning | coral | `#FF5636` |
| Highlight | violet | `#873CFE` |
| Secondary text | stone | `#93A2A2` |
| Borders | line | `#D0D5DD` |
| Primary font (Latin) | — | `"Onest"` → Helvetica Neue → Arial |
| Numbers / mono | — | `"Inter"` |
| **Arabic font** | — | `"Alexandria"` → `"Noto Sans Arabic"` |

### Non-negotiable rules
1. **Primary color = `#101010` (ink)** — never use generic "executive blue" as primary
2. **Cover slides**: dark `#101010` bg, white text, `#4783FC` blue accent dot
3. **Arabic text**: always `"Alexandria", "Noto Sans Arabic", system-ui, sans-serif`
4. **No third-party generic templates** for Jisr content — always derive from tokens above
5. **Logo**: never re-color the Jisr wordmark glyphs — only approved surface pairings
6. **Shadows**: low-tint near-black only — no blue or warm-cast shadows
7. **Alignment**: all deck builds must follow Standard C — verify chrome anchors and content margins before delivery

---

### Worked example — debugging "war room is broken"

1. **Read the error**: user reported "WebRTC not supported or suppressed". That's the symptom, not the cause.
2. **Pull logs**: `tail -200 /tmp/warroom-debug.log` revealed `EOFError: did not receive a valid HTTP request`. Server side.
3. **Verify paths**: warroom subprocess running (`ps | grep warroom/server.py`). Port 7860 bound (`ss -tlnp | grep 7860`). MCP `.claude/settings.json` valid.
4. **Read the code**: `grep -nE "WebRTC" dist/warroom-html.js` → zero matches. The error string is from the `pipecat-ai/client-js` npm dependency. The actual transport is WebSocket per `dist/warroom-html.js:1057`.
5. **Hypothesis**: "WebRTC" is pipecat's generic "media init failed" error message — misleading. Real cause: browser closing the WebSocket before completing the upgrade handshake. Most likely: mic permission revoked between sessions.
6. **Verify by reproducing**: open browser DevTools console, refresh war room, watch for the actual JS error that fires *before* pipecat's generic message. That tells us whether it's mic permission, network, an extension block, or something else.
7. **Do not claim done** until the war room actually accepts a connection, streams audio, and the user confirms verbally.

## Long-running missions — break work into stages

Mission tasks have a hard timeout (default 30 min in our setup). Single missions that try to do "read sources + generate artifact + QA + deliver" all in one call have repeatedly hit the wall (deck thrash 2026-05-04: 1 timeout → 6 reactive rebuilds).

**Rule:** if a task's natural budget is over ~20 min of focused work, **break it into stages**. Each stage is its own mission with its own ≤30 min budget, and stages hand off via `hive_mind` artifacts.

### Canonical staging pattern

```
Stage 1: Plan / outline / extract source content    → produces SPEC artifact
Stage 2: Build the artifact (deck/doc/report)       → produces ARTIFACT
Stage 3: QA + delivery (deck-visual-qa, email gate) → produces DELIVERABLE
```

Each stage:
- Reads the previous stage's `hive_mind` row to find the artifact path
- Writes its own `hive_mind` row when done (artifact path in the `artifacts` JSON)
- Uses `verification-pre-flight` to confirm inputs exist before starting

### When to use the staging pattern

Apply when ANY of:
- Reading 3+ source documents
- Generating ≥10 slides / pages / sections
- Multiple output formats (PPTX + PDF + email body)
- The task includes "design system" or "QA" or "review"
- The user says "presentation" / "pitch deck" / "report" / "comprehensive" / "from scratch"

For deck builds specifically, use the `mission-deck-template` skill — it auto-emits the 3 mission-cli calls with the right hand-offs.

### What main agent does

When delegating a long task: do NOT enqueue one giant mission. Either:
- Invoke `mission-deck-template` (or analogous staging skill) which emits 3 missions in sequence, OR
- Manually emit 3 mission-cli calls, each with a clear `--title` and the prior stage's hive_mind row referenced in the prompt

Single mission > 20 min is a smell. If it must run as one mission, justify it explicitly in the prompt ("tightly-coupled, can't be staged because X").

## War-room rosters — ad-hoc form

Prefer `/standup @ops @comms` (explicit `@-mention`) over the full default roster when the question only needs a subset. The orchestrator runs a Gemini Flash classifier (~$0.0001) per non-mentioned agent to decide if they should chime in; explicit mentions skip that classifier entirely. For 1-2 specific agents, the ad-hoc form is faster and cheaper.

## Skill installation — Telegram cache

After installing a new skill (especially one with `user_invocable: true`) and restarting agents via `scripts/restart-all.sh`: **force-close Telegram on your phone** (swipe from app-switcher, not just minimize) to refresh the `/` autocomplete menu. Telegram caches it aggressively per session.

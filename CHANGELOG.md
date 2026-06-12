# Changelog

All notable changes to ClaudeClaw will be documented here.

## [unreleased] - 2026-05-01

### Fixed — per-agent provider selection
- Dashboard-created agents can now choose a full provider config at
  creation time instead of being limited to Claude model selection.
  The wizard supports Claude, OpenCode, Gemini, Codex, and custom ACP
  providers, including provider model, speed/runtime mode, thinking mode,
  and custom ACP command arguments.
- Agent cards now expose a provider editor so existing agents can switch
  provider/model/modes after creation. Sub-agent changes still surface the
  required restart prompt because agent config is loaded at process start.
- `/provider` now reports provider-specific model status for Codex,
  Gemini, OpenCode, and custom ACP providers instead of showing the
  misleading OpenCode fallback text for every non-Claude provider.
- Agent startup logs include the loaded provider config to make launchd
  and scheduled-task debugging clearer.

### Fixed — agent file-send awareness
- New agents created via the dashboard wizard now always include the
  `[SEND_FILE:...]` / `[SEND_PHOTO:...]` marker documentation in their
  CLAUDE.md, regardless of which template the user picked. The plumbing
  in `src/bot.ts:637` (`extractFileMarkers`) has always supported these
  for every agent — newly-created agents just didn't know the syntax
  existed and would say things like "I can't send files" when asked to
  attach an image they'd just generated.
- **Action required for existing agents:** after pulling this commit,
  run `bash scripts/upgrade-agent-claude-md.sh` once. It idempotently
  appends the section to any `agents/<id>/CLAUDE.md` (in either the
  repo or `$CLAUDECLAW_CONFIG`) that doesn't already mention
  `SEND_FILE`/`SEND_PHOTO`. Safe to re-run; skips already-patched
  files. Agents pick up the change on their next turn — no restart
  needed.

## [unreleased] - 2026-04-29

### Added — text war room
- Multi-agent text war room (`/warroom/text`) with real-time SSE streaming, sticky-addressee follow-ups, `/standup`, `/discuss`, ack short-circuit, and per-meeting persistence.
- Tool-call disclosure UX in agent bubbles — collapsed by default (`▸ N tool calls`), click to expand for full args + results.
- Prompt-injection delimiters wrapping every retrieved-from-DB block in war-room prompt assembly.

### Added — security hardening
- Centralized kill switches with `requireEnabled()` enforced at every LLM-spawning boundary (`runAgent`, war-room orchestrator, router, gate, voice bridge, Gemini `generateContent`). Refusal counters surfaced via `/api/health.killSwitchRefusals`.
- Single dashboard mutation middleware that returns 503 on every non-GET when `DASHBOARD_MUTATIONS_ENABLED=false`. Replaces scattered per-route checks.
- War-room tool boundary: default-deny side-effect tools (`Bash`, `Write`, `Edit`, `Skill`, all MCPs) unless agent explicitly opts in via `warroom_tools:` in `agent.yaml`. `permissionMode: 'default'` (no bypass). Per-turn 8-tool budget. Audit log writes for every tool call.
- CSRF middleware rejects cross-origin mutating requests outside the allowlist (`localhost`, configured `DASHBOARD_URL`).
- Response headers: `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Cache-Control: no-store` on `/api/`.
- Least-privilege SDK env scrubbing (`getScrubbedSdkEnv()`) drops `DASHBOARD_TOKEN`, third-party API keys, and pattern-matched secret-shaped vars before subprocess inheritance.
- Default bind address `127.0.0.1` (was `0.0.0.0`); `DASHBOARD_BIND` env opt-in for LAN exposure.
- Pre-migration backups written to `store/claudeclaw.db.pre-<version>.bak` with `chmod 0600`, 3-backup rotation, gitignored.

### Added — ops & reliability
- Memory ingestion swapped from Gemini to Claude Haiku via OAuth (no extra API key); Gemini retained as fallback. Quota-aware backoff (5-min cooldown on 429).
- `pruneWarRoomMeetings(retentionDays=90)` integrated into the daily decay sweep.
- `endTextMeeting` now clears SDK sessions tied to the meeting.
- `/api/warroom/voices/apply` 3s cooldown to prevent respawn-storm during voice config edits.
- Voice war room `agent_error` and `hand_down` RTVI frames on OAuth/timeout/bridge failures so the browser surfaces real reasons instead of vague Gemini stutter.

### Added — observability
- `/api/health` exposes `killSwitches`, `killSwitchRefusals`, `memoryIngestion`, `warroom.textOpenMeetings`.
- Audit log writes for every war-room tool call (table existed; now populated).
- Router classifier logs elapsed_ms + outcome (success / parse_failure / timeout_or_error) on every call.

### Tests
- `warroom-text-events.test.ts` (MeetingChannel + finalizedTurns guard).
- `warroom-text-db.test.ts` (saveWarRoomConversationTurn idempotency, multi-agent dedup, memory strict-agent isolation, retention prune).
- `kill-switches.test.ts` extended with `requireEnabled` + refusal-counter coverage.
- All 368+ tests pass.

### Docs
- `docs/release-smoke.md` — release runbook (10-step).
- `docs/incident-runbook.md` — kill switch playbook with symptom → action mapping.
- `docs/warroom-mcp-policy.md` — per-agent tool/MCP allowlist + opt-in via `agent.yaml`.
- `docs/redteam-results.md` — adversarial test results (5/5 PASS).
- `docs/voice-smoke-results.md` — voice fix verification.
- `scripts/audit-profile.sh` — isolated red-team harness with canary `.env`, fail-closed gates.
- `scripts/pre-commit-check.sh` — personal-reference scrub.

### Closes Codex adversarial review high findings
- LLM kill switch now enforced at every boundary, not just one route.
- Dashboard mutation kill switch enforced via single middleware on all non-GET routes.
- War-room tool authority restricted to per-agent allowlist; `permissionMode: 'bypassPermissions'` removed from war-room calls.

## [v1.1.1] - 2026-03-06

### Added
- Migration system with versioned migration files
- `add-migration` Claude skill for scaffolding new versioned migrations

# Incident Runbook — War Room

When something is on fire, you don't want to read source. Find the symptom, flip the kill switch.

## Kill switches (hot-reload, ~2s to take effect)

All flags live in `.env`. Flip a flag to `false`, save, and the change applies within ~1.5 seconds across all dashboard requests. No restart needed. Verify via `GET /api/health?token=$DASHBOARD_TOKEN` — the `killSwitches` map echoes current state.

| Flag | Disables | Use when |
|------|----------|----------|
| `LLM_SPAWN_ENABLED=false` | Every `query()` call (text + voice + agent chat + scheduler) | Tokens spiking, agent looping, runaway cost |
| `DASHBOARD_MUTATIONS_ENABLED=false` | All POST/PATCH/DELETE on dashboard | Suspicious activity, you want read-only mode |
| `WARROOM_TEXT_ENABLED=false` | Text war room sends only | Text-room-specific bug, voice still works |
| `WARROOM_VOICE_ENABLED=false` | Voice war room start only | Pipecat/Daily issue, text still works |
| `MISSION_AUTO_ASSIGN_ENABLED=false` | Mission task auto-assignment | Mission queue stuck or assigning to wrong agent |
| `SCHEDULER_ENABLED=false` | Cron-driven scheduled tasks + mission worker | Scheduled task is causing the problem |

## Symptom → Action

### Cost / token spike

1. `LLM_SPAWN_ENABLED=false` immediately
2. Check `/api/tokens` for the offender (highest recent usage)
3. Inspect `conversation_log` for the offending chat / agent
4. Once root cause clear, restore the flag

### War room won't start (voice)

1. `tail -50 /tmp/warroom-debug.log` — usually reveals OAuth token expiry, missing dependency, or Pipecat init error
2. Check Pipecat process: `pgrep -f warroom/server.py`. If absent, main agent should respawn it; if main is dead, `launchctl list | grep com.claudeclaw.main`
3. If it's a token issue: `claude login`, then trigger a respawn via `/api/warroom/voices/apply`

### War room (text) — turns stuck typing forever

1. Open `/api/warroom/text/abort` for the meeting (POST with meetingId + chatId)
2. If that fails: SSE drop reset is automatic on reconnect; have user reload the tab
3. If multiple turns affected: `WARROOM_TEXT_ENABLED=false` to stop the bleed, then investigate the orchestrator logs

### Cross-origin POST returning 403

This is the CSRF guard working. If the user is hitting from a legitimate URL:
1. Confirm `DASHBOARD_URL` in `.env` matches the URL they're using (without trailing slash, full origin)
2. Restart the main agent so the allowlist re-reads (Origin allowlist is computed at boot, NOT hot-reloaded — TODO if needed)

### Suspect a leaked DASHBOARD_TOKEN

1. `DASHBOARD_MUTATIONS_ENABLED=false` (stops state changes; reads still work but token is already known)
2. Generate a fresh token: `openssl rand -hex 32`
3. Update `.env` `DASHBOARD_TOKEN`
4. Restart main agent so the new token is required (this kills active SSE connections)
5. Audit `src/security.ts` audit_log for the suspect window: `sqlite3 store/claudeclaw.db "SELECT * FROM audit_log WHERE created_at > unix_at_concern ORDER BY created_at"`

### Migration failed mid-apply

1. `npm run migrate` saved a backup at `store/claudeclaw.db.pre-<version>.bak` BEFORE running
2. Stop the main agent
3. `cp store/claudeclaw.db.pre-<version>.bak store/claudeclaw.db` (and `-wal` if present)
4. Investigate the failed migration in the logs above
5. Fix the migration code, then `npm run migrate` again

### Voice agent stuck with hand-up animation

If the user reports "agent's hand has been up for 30 seconds and nothing's happening":
1. The 25s `answer_as_agent` timeout already fires `hand_down` (Phase 1 fix)
2. If the timer never fires (process died, panic), kill the warroom subprocess: `pgrep -f warroom/server.py | xargs kill`. Main respawns it in 300ms.

### High disk usage

1. `du -sh store/*` — `claudeclaw.db.pre-*.bak` are pre-migration backups, capped at 3 by default
2. `du -sh /tmp/warroom-*.log` — voice debug log; rotate or delete if growing
3. If `store/claudeclaw.db` itself is huge: check decay sweep (`runDecaySweep` should prune `wa_messages`/`slack_messages` at 3 days). Manually run `npx tsx scripts/decay-now.ts` if it exists, or restart main agent (decay runs at startup).

## Useful commands

```bash
# Watch live activity
tail -f /tmp/claudeclaw-main.log /tmp/warroom-debug.log

# Check current health
curl -s "http://localhost:8989/api/health?token=$DASHBOARD_TOKEN" | jq

# Verify a kill switch took effect
curl -s "http://localhost:8989/api/health?token=$DASHBOARD_TOKEN" | jq '.killSwitches'

# List launchd services
launchctl list | grep com.claudeclaw

# See all war-room subprocess ids
pgrep -f warroom/server.py
pgrep -f agent-voice-bridge

# Find recent audit-log entries
sqlite3 store/claudeclaw.db \
  "SELECT datetime(created_at,'unixepoch','localtime'), agent_id, action, substr(detail,1,80) \
   FROM audit_log ORDER BY created_at DESC LIMIT 20"
```

## When the runbook doesn't help

`pkill -9 -f 'node.*dist/index.js'` and let launchd respawn. Last-resort hammer; you'll lose in-flight turns but the system comes back clean.

## Max-plan throttle / rate limit hit

Symptom: agents start failing with 429s, `query()` returns rate-limit errors, or main agent goes silent on Telegram while logs show `Pro/Max plan limit exceeded`.

The Pro/Max plan assumes "ordinary individual usage" — an always-on multi-agent bot can hit limits faster than expected, especially during heavy mission days (deck builds, RAG ingestion, war-room sessions).

**Fast switch to API-key billing (no code change, no restart):**

1. Generate or retrieve an API key from `console.anthropic.com`.
2. Edit `.env`:
   ```
   ANTHROPIC_API_KEY=sk-ant-api03-...
   ```
   Save. The agent SDK prefers `ANTHROPIC_API_KEY` over `CLAUDE_CODE_OAUTH_TOKEN` when both are present.
3. Hot-reload: send `/respawn` to the main bot, or `sudo systemctl restart claudeclaw claudeclaw-{ops,comms,content,research}`.
4. Switching back to Pro/Max: comment out or remove the `ANTHROPIC_API_KEY` line and restart.

**Cost note:** API-key billing is per-token. Claude Opus 4.7 = $5/M input, $25/M output. A heavy day (~250 turns × 100K cache + 5K output average) lands around $5-15 USD. Use this as a fallback during throttle, not as a primary mode — Pro/Max is dramatically cheaper for typical use.

**Fallback pre-flight:** keep an unset `# ANTHROPIC_API_KEY=` line commented in `.env` so the rotation is faster — uncomment, paste key, save.

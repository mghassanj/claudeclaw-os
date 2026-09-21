#!/usr/bin/env bash
# Out-of-band heartbeat: publishes a tiny status file to a secret GitHub gist.
# .github/workflows/heartbeat-watch.yml (runs on GitHub, outside AWS) fails,
# and GitHub emails the owner, when the heartbeat is stale or not OK. A dead
# host, a DNS/network outage, or a stopped healthcheck timer all go stale, so
# this alert path works exactly when Telegram-based notify.sh cannot.
# Called from healthcheck.sh on every run (EXIT trap). Never prints secrets.
set -u

CCROOT=/home/ubuntu/claudeclaw-os
# shellcheck source=/dev/null
source "$CCROOT/.env"

if [ -z "${HEARTBEAT_GIST_ID:-}" ]; then
  echo "[heartbeat] HEARTBEAT_GIST_ID not set; skipping"
  exit 0
fi

problems=()

code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 \
  "http://127.0.0.1:${DASHBOARD_PORT:-8989}/api/health?token=${DASHBOARD_TOKEN:-}" || true)
[ "$code" = "200" ] || problems+=("dashboard:${code:-none}")

for s in claudeclaw claudeclaw-ops claudeclaw-comms claudeclaw-content claudeclaw-research \
         claudeclaw-scrum claudeclaw-comms-whatsapp jisr-chat-api; do
  st=$(systemctl is-active "$s" 2>/dev/null)
  [ "$st" = "active" ] || problems+=("${s}:${st:-unknown}")
done

# Credential health (src/cred-monitor.ts): count of probes currently failing.
creds=$(curl -s --max-time 5 \
  "http://127.0.0.1:${DASHBOARD_PORT:-8989}/api/cred-health?token=${DASHBOARD_TOKEN:-}" || true)
nfail=$(printf '%s' "$creds" | grep -o '"failing":[0-9]*' | head -1 | cut -d: -f2)
[ -z "$nfail" ] || [ "$nfail" = "0" ] || problems+=("creds:${nfail}")

wa=$(curl -s --max-time 5 "http://127.0.0.1:${WHATSAPP_QR_PORT:-9334}/health" || true)
case "$wa" in *READY*) ;; *) problems+=("whatsapp:not-ready") ;; esac

# Telegram reachability (the normal alert path) - any HTTP response counts.
tg=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 https://api.telegram.org/ || true)
[ "$tg" != "000" ] || problems+=("telegram-api:unreachable")

status=OK
[ ${#problems[@]} -eq 0 ] || status=DEGRADED

content=$(printf 'ts=%s\nstatus=%s\nproblems=%s\nhost=claudeclaw-aws\n' \
  "$(date -u +%s)" "$status" "${problems[*]:-none}")

if gh api -X PATCH "gists/${HEARTBEAT_GIST_ID}" \
     -f "files[heartbeat.txt][content]=${content}" >/dev/null 2>&1; then
  echo "[heartbeat] pushed status=${status} ${problems[*]:-}"
else
  echo "[heartbeat] push failed (network/DNS/GitHub); watcher will flag it as stale"
fi

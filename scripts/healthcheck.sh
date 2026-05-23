#!/usr/bin/env bash
# ClaudeClaw healthcheck — runs every 15 min via systemd timer.
# Curls /api/health, alerts via Telegram if any kill switch unexpectedly off.
set -u

CCROOT=/home/ubuntu/claudeclaw-os
STATE_DIR=/home/ubuntu/.cache/claudeclaw-healthcheck
mkdir -p "$STATE_DIR"

# shellcheck source=/dev/null
source "$CCROOT/.env"

PORT="${DASHBOARD_PORT:-8989}"
HEALTH_URL="http://127.0.0.1:${PORT}/api/health?token=${DASHBOARD_TOKEN}"

response=$(curl -sf --max-time 5 "$HEALTH_URL" || true)

if [ -z "$response" ]; then
  msg="ClaudeClaw healthcheck: /api/health did not respond on :${PORT}"
  echo "[$(date -u +%FT%TZ)] $msg"
  # Notify only if we previously saw a healthy state (avoid alert during boot)
  if [ -f "$STATE_DIR/last-healthy" ]; then
    "$CCROOT/scripts/notify.sh" "$msg" 2>/dev/null || true
  fi
  exit 1
fi

touch "$STATE_DIR/last-healthy"

# Check kill switches — alert on any unexpected off-state
unexpected_off=$(echo "$response" | jq -r '
  .killSwitches // {} |
  to_entries[] |
  select(.value == false) |
  .key' | tr "\n" "," | sed "s/,$//")

if [ -n "$unexpected_off" ]; then
  # Compare to last seen state — only alert on transitions
  prev=$(cat "$STATE_DIR/last-killswitches" 2>/dev/null || echo "")
  if [ "$prev" != "$unexpected_off" ]; then
    msg="ClaudeClaw kill switches OFF: ${unexpected_off}"
    echo "[$(date -u +%FT%TZ)] $msg"
    "$CCROOT/scripts/notify.sh" "$msg" 2>/dev/null || true
    echo "$unexpected_off" > "$STATE_DIR/last-killswitches"
  fi
else
  rm -f "$STATE_DIR/last-killswitches"
fi

# Verify all 5 services active
inactive=""
for s in claudeclaw claudeclaw-ops claudeclaw-comms claudeclaw-content claudeclaw-research claudeclaw-comms-whatsapp; do
  state=$(systemctl is-active "$s" 2>/dev/null)
  if [ "$state" != "active" ]; then
    inactive="${inactive}${s} "
  fi
done

if [ -n "$inactive" ]; then
  prev=$(cat "$STATE_DIR/last-inactive" 2>/dev/null || echo "")
  if [ "$prev" != "$inactive" ]; then
    msg="ClaudeClaw services INACTIVE: ${inactive}"
    echo "[$(date -u +%FT%TZ)] $msg"
    "$CCROOT/scripts/notify.sh" "$msg" 2>/dev/null || true
    echo "$inactive" > "$STATE_DIR/last-inactive"
  fi
else
  rm -f "$STATE_DIR/last-inactive"
fi

echo "[$(date -u +%FT%TZ)] healthcheck OK"

# === WhatsApp comms channel checks (added 2026-05-10) ===


# 1. WA Web auth health
WA_STATE=$(curl -s --max-time 5 http://127.0.0.1:9334/health 2>/dev/null | python3 -c "import sys, json; print(json.load(sys.stdin).get('state','unknown'))" 2>/dev/null || echo "unreachable")
if [ "$WA_STATE" = "READY" ]; then
  rm -f "$STATE_DIR/last-wa-state"
else
  prev=$(cat "$STATE_DIR/last-wa-state" 2>/dev/null || echo "")
  if [ "$prev" != "$WA_STATE" ]; then
    case "$WA_STATE" in
      QR_REQUIRED) "$CCROOT/scripts/notify.sh" "🔗 WhatsApp QR rescan needed: ssh -L 9334:127.0.0.1:9334 ubuntu@13.204.65.145 then http://localhost:9334/qr" 2>/dev/null || true ;;
      unreachable) "$CCROOT/scripts/notify.sh" "⚠️ WhatsApp /health endpoint unreachable" 2>/dev/null || true ;;
      *) "$CCROOT/scripts/notify.sh" "⚠️ WhatsApp state=$WA_STATE (expected READY)" 2>/dev/null || true ;;
    esac
    echo "$WA_STATE" > "$STATE_DIR/last-wa-state"
  fi
fi

# 2. Reply backlog
if [ -n "${DATABASE_URL:-}" ]; then
  BACKLOG=$(/usr/bin/psql "$DATABASE_URL" -At -c "SELECT count(*) FROM whatsapp_exchanges WHERE reply_at IS NULL AND inbound_at > now() - interval '5 minutes' AND error IS NULL" 2>/dev/null)
  if [ "${BACKLOG:-0}" -gt 5 ]; then
    last_alert=$(cat "$STATE_DIR/last-backlog-alerted" 2>/dev/null || echo "0")
    now=$(date +%s)
    if [ $((now - last_alert)) -ge 3600 ]; then
      "$CCROOT/scripts/notify.sh" "📨 WhatsApp reply backlog: $BACKLOG pending in last 5 min" 2>/dev/null || true
      echo "$now" > "$STATE_DIR/last-backlog-alerted"
    fi
  else
    rm -f "$STATE_DIR/last-backlog-alerted"
  fi
fi

# 3. codewiki MCP HTTP probe — Jisr code wiki the WA bot depends on
#    Hysteresis: requires 2 consecutive non-200 results before alerting (≈30 min of
#    failures), and state file is always written (never deleted on success) so a
#    flap 200->401->200->401 won't re-fire on each cycle. Recovery alerts notify
#    when codewiki comes back up after a real failure.
if [ -n "${JISR_CODEWIKI_TOKEN:-}" ]; then
  CW_CODE=$(curl -s --max-time 5 -o /dev/null -w "%{http_code}" \
    -X POST https://codewiki.jisr.dev/api/mcp \
    -H "Authorization: Bearer ${JISR_CODEWIKI_TOKEN}" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"healthcheck","version":"1"}}}' 2>/dev/null)
  CW_CODE="${CW_CODE:-curl_fail}"
  CW_STATE_FILE="$STATE_DIR/last-codewiki-state"
  CW_FAIL_FILE="$STATE_DIR/codewiki-fail-streak"
  cw_prev=$(cat "$CW_STATE_FILE" 2>/dev/null || echo "200")
  if [ "$CW_CODE" = "200" ]; then
    rm -f "$CW_FAIL_FILE"
    if [ "$cw_prev" != "200" ]; then
      "$CCROOT/scripts/notify.sh" "✅ codewiki MCP recovered (was $cw_prev)" 2>/dev/null || true
    fi
  else
    cw_streak=$(cat "$CW_FAIL_FILE" 2>/dev/null || echo "0")
    cw_streak=$((cw_streak + 1))
    echo "$cw_streak" > "$CW_FAIL_FILE"
    if [ "$cw_streak" -ge 2 ] && [ "$cw_prev" != "$CW_CODE" ]; then
      "$CCROOT/scripts/notify.sh" "🩺 codewiki MCP probe failed: $CW_CODE (fail #$cw_streak)" 2>/dev/null || true
    fi
  fi
  echo "$CW_CODE" > "$CW_STATE_FILE"
fi

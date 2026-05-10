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
for s in claudeclaw claudeclaw-ops claudeclaw-comms claudeclaw-content claudeclaw-research; do
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

# 1. Service liveness
if ! systemctl --user is-active --quiet claudeclaw-comms-whatsapp; then
  /home/ubuntu/claudeclaw-os/scripts/notify.sh "🚨 claudeclaw-comms-whatsapp service inactive"
fi

# 2. WA Web auth health
WA_STATE=$(curl -s --max-time 5 http://127.0.0.1:9334/health 2>/dev/null | python3 -c "import sys, json; print(json.load(sys.stdin).get('state','unknown'))" 2>/dev/null || echo "unreachable")
case "$WA_STATE" in
  READY) ;;
  QR_REQUIRED) /home/ubuntu/claudeclaw-os/scripts/notify.sh "🔗 WhatsApp QR rescan needed: ssh -L 9334:127.0.0.1:9334 ubuntu@13.204.65.145 then http://localhost:9334/qr" ;;
  unreachable) /home/ubuntu/claudeclaw-os/scripts/notify.sh "⚠️ WhatsApp /health endpoint unreachable" ;;
  *) /home/ubuntu/claudeclaw-os/scripts/notify.sh "⚠️ WhatsApp state=$WA_STATE (expected READY)" ;;
esac

# 3. Reply backlog
if [ -n "${DATABASE_URL:-}" ]; then
  BACKLOG=$(/usr/bin/psql "$DATABASE_URL" -At -c "SELECT count(*) FROM whatsapp_exchanges WHERE reply_at IS NULL AND inbound_at > now() - interval '5 minutes' AND error IS NULL" 2>/dev/null)
  if [ "${BACKLOG:-0}" -gt 5 ]; then
    /home/ubuntu/claudeclaw-os/scripts/notify.sh "📨 WhatsApp reply backlog: $BACKLOG pending in last 5 min"
  fi
fi

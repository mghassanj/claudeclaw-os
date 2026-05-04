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

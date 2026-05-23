#!/bin/bash
# Send a Telegram message mid-task.
# Usage: notify.sh "message text"
# Reads TELEGRAM_BOT_TOKEN and ALLOWED_CHAT_ID from .env in the project root.
# Logs message_id + text to ~/logs/notify-msgids.jsonl so floods can be bulk-deleted later.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"
LOG_FILE="$HOME/logs/notify-msgids.jsonl"
mkdir -p "$(dirname "$LOG_FILE")"

if [ ! -f "$ENV_FILE" ]; then
  echo "notify.sh: .env not found at $ENV_FILE" >&2
  exit 1
fi

TOKEN=$(grep -E "^TELEGRAM_BOT_TOKEN=" "$ENV_FILE" | cut -d"=" -f2- | tr -d "\"" | tr -d "'")
CHAT_ID=$(grep -E "^ALLOWED_CHAT_ID=" "$ENV_FILE" | cut -d"=" -f2- | tr -d "\"" | tr -d "'")

if [ -z "$TOKEN" ] || [ -z "$CHAT_ID" ]; then
  echo "notify.sh: TELEGRAM_BOT_TOKEN or ALLOWED_CHAT_ID not set in .env" >&2
  exit 1
fi

response=$(curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  -d chat_id="${CHAT_ID}" \
  -d text="${1}" \
  -d parse_mode="HTML")

# Log message_id + timestamp + first 80 chars of text for future bulk-delete by pattern
msg_id=$(echo "$response" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get(\"result\",{}).get(\"message_id\",\"\"))" 2>/dev/null)
if [ -n "$msg_id" ]; then
  ts=$(date -u +%FT%TZ)
  text_preview=$(printf "%s" "$1" | head -c 80 | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))")
  echo "{\"ts\":\"$ts\",\"chat_id\":$CHAT_ID,\"message_id\":$msg_id,\"text\":$text_preview}" >> "$LOG_FILE"
fi

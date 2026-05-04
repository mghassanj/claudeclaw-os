#!/usr/bin/env bash
# Daily disk hygiene for ClaudeClaw OS.
# Truncates noisy log files, caps SQLite migration backups at 3, vacuums DB.
set -u

CCROOT=/home/ubuntu/claudeclaw-os
LOG_TARGET_BYTES=$((100 * 1024 * 1024))  # 100 MB

echo "[$(date -u +%FT%TZ)] disk-hygiene starting"

# --- truncate log files past target size ---
for f in /tmp/warroom-*.log /tmp/claudeclaw-*.log; do
  [ -f "$f" ] || continue
  size=$(stat -c%s "$f" 2>/dev/null || echo 0)
  if [ "$size" -gt "$LOG_TARGET_BYTES" ]; then
    truncate -s "$LOG_TARGET_BYTES" "$f"
    echo "  truncated $f ($size -> $LOG_TARGET_BYTES bytes)"
  fi
done

# --- cap SQLite migration backups at 3 most recent ---
shopt -s nullglob
baks=("$CCROOT"/store/*.bak)
if [ "${#baks[@]}" -gt 3 ]; then
  ls -t "$CCROOT"/store/*.bak | tail -n +4 | xargs -r rm -v
  echo "  removed $((${#baks[@]} - 3)) old backup(s)"
fi

# --- vacuum SQLite if it has grown a lot of free pages (cheap weekly) ---
if [ "$(date -u +%u)" = "7" ]; then  # Sundays
  if command -v sqlite3 >/dev/null 2>&1; then
    db="$CCROOT/store/claudeclaw.db"
    [ -f "$db" ] && sqlite3 "$db" 'VACUUM;' && echo "  vacuumed $db"
  fi
fi

echo "[$(date -u +%FT%TZ)] disk-hygiene done"

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

# --- rotate notify-msgids.jsonl (size > 10MB OR oldest line > 30d) ---
NOTIFY_LOG=/home/ubuntu/logs/notify-msgids.jsonl
NOTIFY_SIZE_LIMIT=$((10 * 1024 * 1024))  # 10 MB
if [ -f "$NOTIFY_LOG" ]; then
  nsize=$(stat -c%s "$NOTIFY_LOG" 2>/dev/null || echo 0)
  rotate=0
  reason=""
  if [ "$nsize" -gt "$NOTIFY_SIZE_LIMIT" ]; then
    rotate=1
    reason="size ${nsize}B > ${NOTIFY_SIZE_LIMIT}B"
  fi
  if [ "$rotate" -eq 0 ] && [ -s "$NOTIFY_LOG" ]; then
    oldest_ts=$(head -1 "$NOTIFY_LOG" | sed -n 's/.*"ts":"\([^"]*\)".*/\1/p')
    if [ -n "$oldest_ts" ]; then
      oldest_epoch=$(date -u -d "$oldest_ts" +%s 2>/dev/null || echo 0)
      now_epoch=$(date -u +%s)
      age_days=$(( (now_epoch - oldest_epoch) / 86400 ))
      if [ "$oldest_epoch" -gt 0 ] && [ "$age_days" -gt 30 ]; then
        rotate=1
        reason="oldest line ${age_days}d old (>30d)"
      fi
    fi
  fi
  if [ "$rotate" -eq 1 ]; then
    archive="${NOTIFY_LOG}.$(date -u +%Y-%m-%d).gz"
    gzip -c "$NOTIFY_LOG" > "$archive" && : > "$NOTIFY_LOG"
    echo "  rotated $NOTIFY_LOG -> $archive ($reason)"
  else
    echo "  notify-msgids.jsonl skip -- under thresholds (${nsize}B)"
  fi
  find /home/ubuntu/logs -maxdepth 1 -name 'notify-msgids.jsonl.*.gz' -mtime +90 -print -delete | sed 's/^/  pruned old archive: /'
fi

# --- vacuum SQLite if it has grown a lot of free pages (cheap weekly) ---
if [ "$(date -u +%u)" = "7" ]; then  # Sundays
  if command -v sqlite3 >/dev/null 2>&1; then
    db="$CCROOT/store/claudeclaw.db"
    [ -f "$db" ] && sqlite3 "$db" 'VACUUM;' && echo "  vacuumed $db"
  fi
fi

echo "[$(date -u +%FT%TZ)] disk-hygiene done"

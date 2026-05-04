#!/usr/bin/env bash
# Restart all 5 ClaudeClaw bots and verify each came up active.
# Adapted from upstream README's launchd version; we use systemd.
set -e

SERVICES=(
  claudeclaw
  claudeclaw-ops
  claudeclaw-comms
  claudeclaw-content
  claudeclaw-research
)

echo "Restarting ${#SERVICES[@]} services..."
sudo systemctl restart "${SERVICES[@]}"

# Give them a few seconds to boot
sleep 4

echo
echo "Status check:"
all_active=1
for s in "${SERVICES[@]}"; do
  state=$(systemctl is-active "$s")
  printf "  %-25s %s\n" "$s" "$state"
  [ "$state" = "active" ] || all_active=0
done

if [ "$all_active" = "0" ]; then
  echo
  echo "WARNING: at least one service is not active. Inspect with:"
  echo "  sudo journalctl -u <service> -n 30 --no-pager -o cat"
  exit 1
fi

echo
echo "All ${#SERVICES[@]} services active."

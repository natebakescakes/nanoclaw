#!/bin/bash
# start-nanoclaw.sh — Start NanoClaw without systemd
# To stop: kill \$(cat /home/developer/nanoclaw/nanoclaw.pid)

set -euo pipefail

cd "/home/developer/nanoclaw"

# Stop existing instance if running
if [ -f "/home/developer/nanoclaw/nanoclaw.pid" ]; then
  OLD_PID=$(cat "/home/developer/nanoclaw/nanoclaw.pid" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping existing NanoClaw (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
fi

echo "Starting NanoClaw..."
nohup "/home/developer/.nvm/versions/node/v22.22.1/bin/node" "/home/developer/nanoclaw/dist/index.js" \
  >> "/home/developer/nanoclaw/logs/nanoclaw.log" \
  2>> "/home/developer/nanoclaw/logs/nanoclaw.error.log" &

echo $! > "/home/developer/nanoclaw/nanoclaw.pid"
echo "NanoClaw started (PID $!)"
echo "Logs: tail -f /home/developer/nanoclaw/logs/nanoclaw.log"

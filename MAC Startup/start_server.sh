#!/usr/bin/env bash
# Start TraderApp (macOS/Linux). Binds to 0.0.0.0 so iPhones/iPads on the
# same Wi-Fi network can open the app too.
set -e

MAC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARENT_DIR="$(cd "$MAC_DIR/.." && pwd)"
APP_DIR="$PARENT_DIR/App"
cd "$APP_DIR"

# shellcheck disable=SC1091
source "$MAC_DIR/find_python.sh"

# Stop any existing TraderApp server on port 5000
echo "[INFO] Stopping any existing TraderApp server..."
pkill -f "python.* app.py" 2>/dev/null || true

echo "[INFO] Using $PYTHON"
"$PYTHON" -V

echo "[INFO] Starting TraderApp..."
echo "[INFO] Press Ctrl+C to stop the server."

# Open the browser once the server is up (fall back gracefully on headless systems)
( sleep 2 && (open "http://127.0.0.1:5000/" 2>/dev/null || xdg-open "http://127.0.0.1:5000/" 2>/dev/null || true) ) &

export TRADERAPP_HOST="${TRADERAPP_HOST:-0.0.0.0}"
export TRADERAPP_PORT="${TRADERAPP_PORT:-5000}"
exec "$PYTHON" app.py

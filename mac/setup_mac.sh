#!/usr/bin/env bash
# macOS/Linux setup: ensure Python 3.10+ is available (via Homebrew if needed).
set -e

MAC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$MAC_DIR/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck disable=SC1091
source "$MAC_DIR/find_python.sh" 2>/dev/null && {
  echo "[OK] Python found: $PYTHON"
  "$PYTHON" -V
  exit 0
}

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is not installed. Install it from https://brew.sh"
  echo "or download Python from https://www.python.org/downloads/macos/"
  echo "then run ./mac/install_libs.sh and ./mac/start_server.sh again."
  exit 1
fi

echo "Installing Python via Homebrew..."
brew install python@3.13

echo
echo "Python installed. Now installing TraderApp dependencies..."
"$MAC_DIR/install_libs.sh"

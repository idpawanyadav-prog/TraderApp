#!/usr/bin/env bash
# macOS/Linux setup: ensure Python 3.10+ is available (via Homebrew if needed).
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# shellcheck disable=SC1091
source ./find_python.sh 2>/dev/null && {
  echo "[OK] Python found: $PYTHON"
  "$PYTHON" -V
  exit 0
}

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is not installed. Install it from https://brew.sh"
  echo "or download Python from https://www.python.org/downloads/macos/"
  echo "then run ./install_libs.sh and ./start_server.sh again."
  exit 1
fi

echo "Installing Python via Homebrew..."
brew install python@3.13

echo
echo "Python installed. Now installing TraderApp dependencies..."
./install_libs.sh

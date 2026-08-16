#!/usr/bin/env bash
# Locate a Python 3.10+ interpreter and export it as $PYTHON.
# Works on macOS and Linux. Sources: Homebrew, python.org framework,
# /usr/bin/python3, and any python3.x on PATH.
set -u

MAC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARENT_DIR="$(cd "$MAC_DIR/.." && pwd)"
export PYTHON=""

# Homebrew (Apple Silicon / Intel) and optional bundled runtime at repo root
for brew_py in \
  "$PARENT_DIR/python314/bin/python3" \
  /opt/homebrew/bin/python3 \
  /usr/local/bin/python3; do
  if [ -x "$brew_py" ]; then
    if "$brew_py" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
      export PYTHON="$brew_py"
      break
    fi
  fi
done

# python.org framework installs
if [ -z "$PYTHON" ]; then
  for d in /Library/Frameworks/Python.framework/Versions/*/bin; do
    [ -x "$d/python3" ] || continue
    if "$d/python3" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
      export PYTHON="$d/python3"
      break
    fi
  done
fi

# Generic python3 / python3.x on PATH
if [ -z "$PYTHON" ]; then
  for cmd in python3 python3.14 python3.13 python3.12 python3.11 python3.10 python; do
    if command -v "$cmd" >/dev/null 2>&1; then
      if "$cmd" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
        export PYTHON="$(command -v "$cmd")"
        break
      fi
    fi
  done
fi

if [ -z "$PYTHON" ]; then
  echo "[ERROR] No Python 3.10+ interpreter found."
  echo "        Install Python 3.14 from https://www.python.org/downloads/macos/"
  echo "        or run \"./MAC Startup/setup_mac.sh\" (installs via Homebrew)."
  exit 1
fi

"$PYTHON" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null || {
  echo "[ERROR] Python 3.10 or newer is required."
  "$PYTHON" -V
  exit 1
}
exit 0

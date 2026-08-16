#!/usr/bin/env bash
# Install TraderApp Python dependencies into the local libs/ folder (macOS/Linux).
set -e

MAC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$MAC_DIR/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck disable=SC1091
source "$MAC_DIR/find_python.sh"

echo "[INFO] Using $PYTHON"
"$PYTHON" -V

echo "[INFO] Clearing old vendored packages in ./libs/"
rm -rf "$ROOT_DIR/libs"
mkdir -p "$ROOT_DIR/libs"

"$PYTHON" -m pip install -r requirements.txt --target="$ROOT_DIR/libs" --upgrade --force-reinstall --ignore-installed

"$PYTHON" -c "import vendor_libs; vendor_libs.finish_install()" || true

echo
echo "Done! All libraries installed in ./libs/"

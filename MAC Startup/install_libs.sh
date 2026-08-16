#!/usr/bin/env bash
# Install TraderApp Python dependencies into App/libs (macOS/Linux).
set -e

MAC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARENT_DIR="$(cd "$MAC_DIR/.." && pwd)"
APP_DIR="$PARENT_DIR/App"
cd "$APP_DIR"

# shellcheck disable=SC1091
source "$MAC_DIR/find_python.sh"

echo "[INFO] Using $PYTHON"
"$PYTHON" -V

echo "[INFO] Clearing old vendored packages in App/libs/"
rm -rf "$APP_DIR/libs"
mkdir -p "$APP_DIR/libs"

"$PYTHON" -m pip install -r requirements.txt --target="$APP_DIR/libs" --upgrade --force-reinstall --ignore-installed

"$PYTHON" -c "import vendor_libs; vendor_libs.finish_install()" || true

echo
echo "Done! All libraries installed in App/libs/"

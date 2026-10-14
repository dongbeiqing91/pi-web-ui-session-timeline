#!/bin/sh
# Install the session-timeline plugin into the local pi-web-ui plugin directory.
# Usage: ./install.sh [--data-dir <dir>]
set -e

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_SRC="$SRC_DIR/plugins/session-timeline"

DATA_DIR="${PI_WEB_DATA_DIR:-$HOME/.pi-web}"
if [ "$1" = "--data-dir" ]; then
	[ -n "$2" ] || { echo "usage: ./install.sh [--data-dir <dir>]" >&2; exit 1; }
	DATA_DIR="$2"
fi

[ -d "$PLUGIN_SRC" ] || { echo "plugin source not found: $PLUGIN_SRC" >&2; exit 1; }

DEST="$DATA_DIR/plugins/session-timeline"
mkdir -p "$DATA_DIR/plugins"
rm -rf "$DEST"
cp -R "$PLUGIN_SRC" "$DEST"

echo "installed: $DEST"
echo
echo "next steps:"
echo "  1. restart the pi-web-ui server (pi-web-ui server restart, or in-app 'restart service')"
echo "  2. if the plugin is not auto-activated: Settings -> Plugins -> enable 会话时间线"
echo "  3. click the 🕘 button in the top bar to open the session timeline"

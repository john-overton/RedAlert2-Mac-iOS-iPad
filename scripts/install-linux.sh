#!/bin/bash
# Install (or remove) a built Linux app for the current user. No root, no
# system package: the asset tree is per-user and derived from your own retail
# files, so it lives under ~/.local/share like any other user data.
#
#   bash scripts/install-linux.sh              # build/linux/yr  -> ~/.local/share/ra2/yr
#   bash scripts/install-linux.sh --ra2        # build/linux/ra2 -> ~/.local/share/ra2/ra2
#   bash scripts/install-linux.sh --uninstall  # remove the yr install (combine with --ra2)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VARIANT=yr
UNINSTALL=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ra2) VARIANT=ra2 ;;
    --uninstall) UNINSTALL=1 ;;
    *) echo "Usage: $0 [--ra2] [--uninstall]" >&2; exit 1 ;;
  esac
  shift
done

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
DEST="$DATA_HOME/ra2/$VARIANT"
DESKTOP="$DATA_HOME/applications/ra2-$VARIANT.desktop"
ICON="$DATA_HOME/icons/hicolor/256x256/apps/ra2-$VARIANT.png"

refresh_desktop_db() {
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$DATA_HOME/applications" 2>/dev/null || true
}

if [[ $UNINSTALL == 1 ]]; then
  rm -rf "$DEST" "$DESKTOP" "$ICON"
  rmdir "$DATA_HOME/ra2" 2>/dev/null || true
  refresh_desktop_db
  echo "Removed $DEST, $DESKTOP and $ICON."
  echo "Saved games and options live in ~/.config/ra2-$VARIANT and were left in place."
  exit 0
fi

SRC="$ROOT/build/linux/$VARIANT"
if [[ "$VARIANT" == ra2 ]]; then BUILD_HINT=" --ra2"; else BUILD_HINT=""; fi
[[ -x "$SRC/run.sh" && -s "$SRC/Resources/GameRes/manifest.json" ]] \
  || { echo "No build at $SRC. Run: bash scripts/build-linux.sh$BUILD_HINT" >&2; exit 1; }

echo "==> Installing $SRC -> $DEST"
mkdir -p "$DEST" "$(dirname "$DESKTOP")"
rsync -a --delete "$SRC/" "$DEST/"
# The build tree's desktop entry points at build/; rewrite for the install location.
if [[ -s "$DEST/Resources/icon.png" ]]; then
  mkdir -p "$(dirname "$ICON")"
  cp "$DEST/Resources/icon.png" "$ICON"
  ICON_REF="ra2-$VARIANT"
else
  ICON_REF="applications-games"
fi
sed -e "s|^Exec=.*|Exec=$DEST/run.sh|" -e "s|^Icon=.*|Icon=$ICON_REF|" "$DEST/ra2.desktop" > "$DESKTOP"
chmod 644 "$DESKTOP"
refresh_desktop_db

echo "Installed. Launch from your app menu, or: $DEST/run.sh"
echo "Uninstall: bash scripts/install-linux.sh$BUILD_HINT --uninstall"

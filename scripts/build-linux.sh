#!/bin/bash
# Build the Linux (Omarchy/Arch) app: web engine + imported assets + Electron shell.
# Mirrors scripts/build-macos.sh. The result runs on the system Electron package
# (electron43 on Arch); nothing is downloaded.
#
#   bash scripts/build-linux.sh                       # Yuri's Revenge -> build/linux/yr
#   bash scripts/build-linux.sh --ra2                 # classic RA2   -> build/linux/ra2
#   bash scripts/build-linux.sh --no-web              # reuse redalert2/dist
#   bash scripts/build-linux.sh --retail-dir DIR      # app icon from the retail ICO
#   bash scripts/build-linux.sh --ra2 --campaign      # bundle the imported Allied missions
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.bun/bin:$PATH"
SKIP_WEB=0
CAMPAIGN=0
VARIANT=yr
RETAIL="${RA2_RETAIL_DIR:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-web) SKIP_WEB=1 ;;
    --ra2) VARIANT=ra2 ;;
    --campaign) CAMPAIGN=1 ;;
    --retail-dir)
      [[ $# -ge 2 && -d "$2" ]] || { echo "--retail-dir requires an existing directory" >&2; exit 1; }
      RETAIL="$2"; shift ;;
    *) echo "Usage: $0 [--no-web] [--ra2] [--campaign] [--retail-dir DIR]" >&2; exit 1 ;;
  esac
  shift
done
# Campaign packaging mirrors build-macos.sh: classic mode only, missions imported
# from the retail MAPS01.MIX by scripts/prepare-campaign.ts into campaign-export/.
if [[ $CAMPAIGN == 1 ]]; then
  [[ "$VARIANT" == ra2 ]] || { echo "--campaign currently requires --ra2" >&2; exit 1; }
  if [[ -n "$RETAIL" ]]; then bun "$ROOT/scripts/prepare-campaign.ts" "$RETAIL"; fi
  [[ -s "$ROOT/campaign-export/ra2/allied-01/all01t.map" && -s "$ROOT/campaign-export/ra2/allied-02/all02s.map" ]] || { echo "Import campaign missions with scripts/prepare-campaign.ts or supply --retail-dir" >&2; exit 1; }
fi
for required in redalert2/public/general.csf redalert2/public/generalmd.csf gameres-export/ra2.mix; do
  if [[ ! -s "$ROOT/$required" ]]; then
    echo "Missing $required. Run scripts/setup.sh with your retail install first." >&2
    exit 1
  fi
done
if [[ "$VARIANT" == yr && ! -s "$ROOT/gameres-export/ra2md.mix" ]]; then
  echo "Yuri's Revenge assets are missing; import them or use --ra2." >&2
  exit 1
fi
if [[ $SKIP_WEB == 0 ]]; then
  command -v bun >/dev/null 2>&1 || { echo "bun is required to build the web engine (curl -fsSL https://bun.sh/install | bash), or pass --no-web." >&2; exit 1; }
  (cd "$ROOT/redalert2" && bun run build)
fi
[[ -s "$ROOT/redalert2/dist/index.html" ]] || { echo "Missing web build" >&2; exit 1; }

OUT="$ROOT/build/linux/$VARIANT"
RES="$OUT/Resources"
mkdir -p "$OUT/app" "$RES"
# Assigned separately: an apostrophe inside ${VAR:-default} breaks bash's
# parameter expansion even within double quotes.
if [[ "$VARIANT" == ra2 ]]; then APP_NAME="Red Alert 2"; else APP_NAME="Yuri's Revenge"; fi

echo "==> Staging shell"
cp "$ROOT/linux/main.js" "$ROOT/linux/preload.js" "$OUT/app/"
(cd "$ROOT/redalert2" && bun run build:server)
cp "$ROOT/redalert2/dist-server/multiplayer.cjs" "$OUT/app/"
cp "$ROOT/redalert2/node_modules/ws/LICENSE" "$OUT/app/ws-LICENSE"
# Hyprland floats the game at its native window size with this rule (see the
# file for how to install it); harmless elsewhere.
cp "$ROOT/linux/hyprland-windowrules.lua" "$OUT/"

echo "==> Staging WebDist ($VARIANT)"
# Synchronize generated resources so rebuilds cannot retain obsolete assets.
# local-pack is the 430MB browser-import archive; the shell seeds from GameRes instead.
rsync -a --delete --exclude local-pack "$ROOT/redalert2/dist/" "$RES/WebDist/"
if [[ "$VARIANT" == ra2 ]]; then
  sed -i 's/^engine = yr/engine = ra2/; s/^csfFile = generalmd.csf/csfFile = general.csf/' "$RES/WebDist/config.ini"
fi
grep -E "^engine|^csfFile" "$RES/WebDist/config.ini"
if [[ $CAMPAIGN == 1 ]]; then
  echo "==> Staging campaign missions"
  mkdir -p "$RES/WebDist/campaign/ra2"
  rsync -a --delete --exclude audit.json --exclude '*result.json' --exclude '*.sha256' "$ROOT/campaign-export/ra2/" "$RES/WebDist/campaign/ra2/"
fi

echo "==> Staging GameRes ($VARIANT)"
# Both variants ship the full imported tree, like the macOS build (the iOS
# script strips YR mixes from the classic variant; that was tried here and did
# not change the classic variant's boot behaviour, so the known-good layout wins).
rsync -a --delete --exclude manifest.json "$ROOT/gameres-export/" "$RES/GameRes/"

if [[ -n "$RETAIL" ]]; then
  echo "==> App icon"
  ICON_SOURCE="$(python3 - "$RETAIL" "$VARIANT" <<'PY'
import pathlib, sys
name = 'ra2.ico' if sys.argv[2] == 'ra2' else 'ra2md.ico'
matches = [p for p in pathlib.Path(sys.argv[1]).iterdir() if p.name.lower() == name and p.is_file()]
if not matches:
    sys.exit(f'Missing retail icon {name} in {sys.argv[1]}')
print(matches[0])
PY
)"
  python3 "$ROOT/scripts/build-linux-icon.py" "$ICON_SOURCE" "$RES/icon.png"
elif [[ ! -s "$RES/icon.png" ]]; then
  # No retail ICO on this machine: fall back to the app icon the iOS build
  # already ships in the repo, so a fresh clone still gets a real icon.
  echo "==> App icon (fallback: iOS AppIcon.png; pass --retail-dir DIR for the retail ICO)"
  cp "$ROOT/ios/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png" "$RES/icon.png"
fi

echo "==> Generating GameRes manifest + app.json"
python3 - "$OUT" "$VARIANT" "$APP_NAME" <<'PY'
import json, pathlib, sys
out = pathlib.Path(sys.argv[1]); variant = sys.argv[2]; name = sys.argv[3]
root = out / 'Resources/GameRes'
files = [{'path': p.relative_to(root).as_posix(), 'size': p.stat().st_size}
         for p in sorted(root.rglob('*')) if p.is_file() and p.name not in ('.DS_Store', 'manifest.json')]
(root / 'manifest.json').write_text(json.dumps({'files': files}))
print(f"manifest: {len(files)} files, {sum(f['size'] for f in files)/1048576:.1f} MB")
(out / 'app/app.json').write_text(json.dumps({'name': name, 'variant': variant, 'version': '0.1.0'}, indent=1))
# Electron needs a package.json to load a directory. Its `name` also decides the
# per-app storage dir (~/.config/ra2-<variant>), so the two variants keep
# separate saves and options like the separate bundle ids on macOS.
(out / 'app/package.json').write_text(json.dumps({'name': f'ra2-{variant}', 'version': '0.1.0', 'main': 'main.js', 'private': True}, indent=1))
PY

echo "==> Launcher + desktop entry"
cat > "$OUT/run.sh" <<'SH'
#!/bin/bash
# Launch the game on the system Electron. Extra arguments are passed through
# (e.g. --remote-debugging-port=9223 for CDP, or RA2_INSPECT=1 for devtools).
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for candidate in electron43 electron; do
  if command -v "$candidate" >/dev/null 2>&1; then
    exec "$candidate" "$DIR/app" "$@"
  fi
done
echo "error: no Electron found. Install it: sudo pacman -S electron43" >&2
exit 1
SH
chmod +x "$OUT/run.sh"
{
  echo "[Desktop Entry]"
  echo "Type=Application"
  echo "Name=$APP_NAME"
  echo "Comment=Command & Conquer Red Alert 2 (Chrono Divide engine)"
  echo "Exec=$OUT/run.sh"
  echo "Icon=$RES/icon.png"
  echo "Terminal=false"
  echo "Categories=Game;StrategyGame;"
  echo "StartupWMClass=ra2-$VARIANT"
} > "$OUT/ra2.desktop"

echo "Built: $OUT"
echo "Run:   $OUT/run.sh"
if [[ "$VARIANT" == ra2 ]]; then INSTALL_FLAG=" --ra2"; else INSTALL_FLAG=""; fi
echo "Install for this user (menu entry + icon): bash scripts/install-linux.sh$INSTALL_FLAG"
echo "Hyprland users: see $OUT/hyprland-windowrules.lua (float at 1280x800), or run with --fullscreen"

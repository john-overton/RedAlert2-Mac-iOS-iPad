#!/bin/bash
# Build an Apple Silicon app using Xcode's Swift compiler; no XcodeGen required.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.bun/bin:$PATH"
SKIP_WEB=0
CAMPAIGN=auto
VARIANT=yr
RETAIL="${RA2_RETAIL_DIR:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-web) SKIP_WEB=1 ;;
    --ra2) VARIANT=ra2 ;;
    --campaign) CAMPAIGN=1 ;;
    --no-campaign) CAMPAIGN=0 ;;
    --retail-dir)
      [[ $# -ge 2 && -d "$2" ]] || { echo "--retail-dir requires an existing directory" >&2; exit 1; }
      RETAIL="$2"; shift ;;
    *) echo "Usage: $0 [--no-web] [--ra2] [--campaign | --no-campaign] [--retail-dir DIR]" >&2; exit 1 ;;
  esac
  shift
done
# Include supported campaigns on normal local rebuilds when imports are available.
if [[ "$CAMPAIGN" == auto ]]; then
  CAMPAIGN=0
  if [[ -n "$RETAIL" || ( -s "$ROOT/campaign-export/ra2/allied-01/all01t.map" && -s "$ROOT/campaign-export/ra2/allied-02/all02s.map" ) ]]; then
    CAMPAIGN=1
  fi
fi
if [[ $CAMPAIGN == 1 ]]; then
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
  (cd "$ROOT/redalert2" && bun run build)
fi
[[ -s "$ROOT/redalert2/dist/index.html" ]] || { echo "Missing web build" >&2; exit 1; }
APP="$ROOT/build/macos/$VARIANT/Red Alert 2.app"
mkdir -p "$APP/Contents/Helpers" "$APP/Contents/MacOS" "$APP/Contents/Resources" "$ROOT/build/macos/ModuleCache"
# Compile the existing server plus Bun into a standalone helper; players need no runtime install.
bun build --compile --target=bun-darwin-arm64 "$ROOT/redalert2/server/macos.ts" --outfile "$APP/Contents/Helpers/RA2Server"
codesign --force --sign - "$APP/Contents/Helpers/RA2Server"
mkdir -p "$APP/Contents/Resources/Licenses"
cp "$ROOT/macos/Licenses/Bun-LICENSE.md" "$APP/Contents/Resources/Licenses/"
bun --version > "$APP/Contents/Resources/Licenses/Bun-version.txt"
# Synchronize generated resources so rebuilds cannot retain obsolete assets.
rsync -a --delete --exclude local-pack "$ROOT/redalert2/dist/" "$APP/Contents/Resources/WebDist/"
if [[ $CAMPAIGN == 1 ]]; then
  mkdir -p "$APP/Contents/Resources/WebDist/campaign/ra2"
  rsync -a --delete --exclude audit.json --exclude '*result.json' --exclude '*.sha256' "$ROOT/campaign-export/ra2/" "$APP/Contents/Resources/WebDist/campaign/ra2/"
fi
rsync -a --delete "$ROOT/gameres-export/" "$APP/Contents/Resources/GameRes/"
if [[ -n "$RETAIL" ]]; then
  ICON_SOURCE="$(python3 - "$RETAIL" "$VARIANT" <<'PY'
import pathlib, sys
name = 'ra2.ico' if sys.argv[2] == 'ra2' else 'ra2md.ico'
matches = [p for p in pathlib.Path(sys.argv[1]).iterdir() if p.name.lower() == name and p.is_file()]
if not matches:
    sys.exit(f'Missing retail icon {name} in {sys.argv[1]}')
print(matches[0])
PY
)"
  python3 "$ROOT/scripts/build-macos-icon.py" "$ICON_SOURCE" "$APP/Contents/Resources/AppIcon.icns"
elif [[ ! -s "$APP/Contents/Resources/AppIcon.icns" ]]; then
  echo "No retail app icon found. Supply --retail-dir DIR to add one."
fi
python3 - "$APP" "$VARIANT" <<'PY'
import json, pathlib, plistlib, sys
app = pathlib.Path(sys.argv[1])
variant = sys.argv[2]
resources = app / 'Contents/Resources'
if variant == 'ra2':
    config = resources / 'WebDist/config.ini'
    config.write_text(config.read_text().replace('engine = yr', 'engine = ra2').replace('csfFile = generalmd.csf', 'csfFile = general.csf'))
root = resources / 'GameRes'
files = [{'path': p.relative_to(root).as_posix(), 'size': p.stat().st_size}
         for p in sorted(root.rglob('*')) if p.is_file() and p.name not in ('.DS_Store', 'manifest.json')]
(root / 'manifest.json').write_text(json.dumps({'files': files}))
info = dict(CFBundleExecutable='RA2', CFBundleIdentifier=f'com.ra2web.macos.{variant}',
        CFBundleName='Red Alert 2', CFBundleDisplayName="Yuri's Revenge" if variant == 'yr' else 'Red Alert 2',
        CFBundlePackageType='APPL', CFBundleShortVersionString='0.1.0', CFBundleVersion='1',
        NSLocalNetworkUsageDescription='Host and join Red Alert 2 multiplayer games on your local network.',
        NSAppTransportSecurity={'NSAllowsLocalNetworking': True},
        LSMinimumSystemVersion='14.0', NSHighResolutionCapable=True, NSPrincipalClass='NSApplication')
if (resources / 'AppIcon.icns').is_file():
    info['CFBundleIconFile'] = 'AppIcon.icns'
with (app / 'Contents/Info.plist').open('wb') as f:
    plistlib.dump(info, f)
PY
xcrun swiftc -O -swift-version 5 -target arm64-apple-macos14.0 \
  -module-cache-path "$ROOT/build/macos/ModuleCache" \
  -framework AppKit -framework WebKit -framework UniformTypeIdentifiers \
  "$ROOT/ios/Sources/BundleSchemeHandler.swift" "$ROOT/ios/Sources/PerformanceLogWriter.swift" "$ROOT/macos/Sources/MultiplayerHost.swift" "$ROOT/macos/Sources/main.swift" \
  -o "$APP/Contents/MacOS/RA2"
codesign --force --sign - "$APP"
echo "Built: $APP"
file "$APP/Contents/MacOS/RA2"

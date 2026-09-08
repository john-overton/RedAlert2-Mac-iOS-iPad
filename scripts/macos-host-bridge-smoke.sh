#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT="$ROOT/build/macos/hosting-smoke/HostingSmoke.app/Contents"
mkdir -p "$OUTPUT/MacOS" "$ROOT/build/macos/ModuleCache"
xcrun swiftc -swift-version 5 -target arm64-apple-macos14.0 \
  -module-cache-path "$ROOT/build/macos/ModuleCache" -framework AppKit -framework WebKit -framework UniformTypeIdentifiers \
  "$ROOT/ios/Sources/BundleSchemeHandler.swift" "$ROOT/macos/Sources/MultiplayerHost.swift" "$ROOT/macos/Tests/HostingSmoke/main.swift" \
  -o "$OUTPUT/MacOS/HostingSmoke"
ln -sfn "$ROOT/build/macos/yr/Red Alert 2.app/Contents/Resources" "$OUTPUT/Resources"
cp "$ROOT/build/macos/yr/Red Alert 2.app/Contents/Info.plist" "$OUTPUT/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleExecutable HostingSmoke' "$OUTPUT/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier com.ra2web.hosting-smoke' "$OUTPUT/Info.plist"
if [[ "${1:-}" == --ui ]]; then
  "$OUTPUT/MacOS/HostingSmoke" "$ROOT/build/macos/yr/Red Alert 2.app/Contents/Helpers/RA2Server" "$ROOT/macos/Tests/HostingSmoke/ui.js"
else
  "$OUTPUT/MacOS/HostingSmoke" "${1:-$ROOT/build/macos/yr/Red Alert 2.app/Contents/Helpers/RA2Server}"
fi

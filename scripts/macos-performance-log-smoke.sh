#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT="$ROOT/build/macos/performance-log-smoke/PerformanceLogSmoke.app/Contents"
mkdir -p "$OUTPUT/MacOS" "$ROOT/build/macos/ModuleCache"
xcrun swiftc -swift-version 5 -target arm64-apple-macos14.0 \
  -module-cache-path "$ROOT/build/macos/ModuleCache" -framework AppKit -framework WebKit \
  "$ROOT/ios/Sources/PerformanceLogWriter.swift" "$ROOT/macos/Tests/PerformanceLogSmoke/main.swift" \
  -o "$OUTPUT/MacOS/PerformanceLogSmoke"
cat > "$OUTPUT/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>PerformanceLogSmoke</string>
<key>CFBundleIdentifier</key><string>com.ra2web.performance-log-smoke</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
PLIST
PAYLOAD="${1:-$ROOT/build/slowdown-live-chromium-download.json}"
if [[ ! -f "$PAYLOAD" && $# -eq 0 ]]; then
  PAYLOAD="$ROOT/build/macos/performance-log-smoke/report-fixture.json"
  printf '%s\n' '{"schemaVersion":1,"enabled":true,"metrics":{"render.submit":{"calls":1,"maxMs":75}},"slowEvents":[{"name":"render.submit","value":75}]}' > "$PAYLOAD"
fi
"$OUTPUT/MacOS/PerformanceLogSmoke" "$PAYLOAD"

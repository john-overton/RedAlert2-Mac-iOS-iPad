#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT="$ROOT/build/macos/performance-log-tests"
mkdir -p "$OUTPUT" "$ROOT/build/macos/ModuleCache"
xcrun swiftc -swift-version 5 -target arm64-apple-macos14.0 \
  -module-cache-path "$ROOT/build/macos/ModuleCache" -framework Foundation -framework WebKit \
  "$ROOT/ios/Sources/PerformanceLogWriter.swift" "$ROOT/macos/Tests/PerformanceLogs/main.swift" \
  -o "$OUTPUT/PerformanceLogTests"
"$OUTPUT/PerformanceLogTests"

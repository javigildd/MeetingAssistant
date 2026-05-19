#!/usr/bin/env bash
# Builds marec and wraps it in a proper marec.app bundle so macOS TCC
# (Screen Recording + Microphone permissions) treats it as a real app.
#
# Without the .app bundle wrapping, a raw CLI Swift binary cannot register
# stable usage description strings or get a persistent entry in System
# Settings > Privacy & Security. Ad-hoc codesigning gives it a stable
# code-design identity so permissions survive rebuilds.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

OUT_DIR="${1:-$HERE/../desktop/resources/bin}"
APP="$OUT_DIR/marec.app"

echo "▸ Building marec (release)"
swift build -c release >/dev/null

echo "▸ Assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
mkdir -p "$APP/Contents/Resources"
cp .build/release/marec "$APP/Contents/MacOS/marec"
cp Info.plist "$APP/Contents/Info.plist"

echo "▸ Ad-hoc codesigning so TCC has a stable identity"
codesign --force --sign - --identifier com.javigildd.meetingassistant.marec \
  --options=runtime --timestamp=none \
  "$APP" >/dev/null 2>&1 || codesign --force --sign - \
  --identifier com.javigildd.meetingassistant.marec "$APP" >/dev/null 2>&1

# Verify signature
if codesign -dv "$APP" 2>&1 | grep -q "Identifier=com.javigildd.meetingassistant.marec"; then
  echo "✓ marec.app built at $APP"
else
  echo "! signing might have failed; the app may still work but TCC could re-prompt." >&2
fi

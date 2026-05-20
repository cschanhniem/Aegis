#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# Minimal DMG builder for AEGIS.app — pure hdiutil, no AppleScript.
#
# Tauri's bundled `bundle_dmg.sh` calls osascript to prettify the
# Finder window (icon positions, drag-to-Applications layout),
# which requires the running process to have "Send Apple Events
# to Finder" automation permission. That's a per-app grant in
# System Settings → Privacy & Security → Automation. CI runners
# (and headless `cargo tauri build` invocations from non-Terminal
# parents) don't have it.
#
# This script sidesteps the entire AppleScript path by packaging
# the .app + an /Applications symlink into a UDZO DMG via
# hdiutil. The result is plain — no background image, no fixed
# icon positions — but it mounts, runs, drag-installs, and ships.
#
# Usage:
#   apps/desktop/scripts/make-dmg.sh [/path/to/AEGIS.app] [output.dmg]
#
# Defaults match `cargo tauri build` output:
#   src-tauri/target/release/bundle/macos/AEGIS.app
#   src-tauri/target/release/bundle/dmg/AEGIS_<version>_<arch>.dmg
# ─────────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")/.."
DESKTOP_ROOT="$(pwd)"

APP_SRC="${1:-$DESKTOP_ROOT/src-tauri/target/release/bundle/macos/AEGIS.app}"
if [ ! -d "$APP_SRC" ]; then
  echo "error: .app not found at $APP_SRC"
  echo "       run 'cargo tauri build --bundles app' first"
  exit 1
fi

VERSION="$(grep -m1 '^version' "$DESKTOP_ROOT/src-tauri/tauri.conf.json" \
          | sed -E 's/.*"([0-9.]+)".*/\1/' || echo 0.1.0)"
ARCH_RAW="$(uname -m)"
case "$ARCH_RAW" in
  arm64) ARCH=aarch64 ;;
  x86_64) ARCH=x64 ;;
  *) ARCH="$ARCH_RAW" ;;
esac

DMG_OUT="${2:-$DESKTOP_ROOT/src-tauri/target/release/bundle/dmg/AEGIS_${VERSION}_${ARCH}.dmg}"
mkdir -p "$(dirname "$DMG_OUT")"
rm -f "$DMG_OUT"

# Stage a temp directory holding only AEGIS.app + an Applications symlink.
# hdiutil snapshots whatever's in -srcfolder into the resulting DMG.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp -R "$APP_SRC" "$STAGE/"
ln -sf /Applications "$STAGE/Applications"

GREEN='\033[0;32m'; NC='\033[0m'
printf "${GREEN}▸${NC} Packaging AEGIS_${VERSION}_${ARCH}.dmg (UDZO, no AppleScript)\n"

hdiutil create \
  -volname "AEGIS" \
  -srcfolder "$STAGE" \
  -ov \
  -format UDZO \
  -imagekey zlib-level=9 \
  "$DMG_OUT" >/dev/null

printf "${GREEN}▸${NC} Wrote $DMG_OUT (%s)\n" "$(du -h "$DMG_OUT" | awk '{print $1}')"

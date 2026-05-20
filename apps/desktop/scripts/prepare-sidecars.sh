#!/usr/bin/env bash
# Thin shim — the real implementation moved to prepare-sidecars.mjs so
# the same code path runs on macOS, Linux, and Windows CI. This script
# is kept so `tauri.conf.json#beforeBuildCommand` and pre-existing
# muscle memory both keep working.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/prepare-sidecars.mjs "$@"

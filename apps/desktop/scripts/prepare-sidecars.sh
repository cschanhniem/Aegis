#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# Stage everything Tauri needs to bundle a release .dmg/.exe.
# Run by `cargo tauri build` via tauri.conf.json#beforeBuildCommand.
#
# Output layout (under apps/desktop/sidecar-stage/):
#
#   cockpit-static/         Cockpit standalone (Node + .next/standalone)
#       server.js
#       apps/compliance-cockpit/
#       node_modules/
#
#   gateway-bin/            Gateway dist + production deps
#       server.js
#       node_modules/
#
#   node-runtime/           Portable Node binary for the target platform
#       bin/node
#
# Tauri's resource bundler picks these up from `bundle.resources` in
# tauri.conf.json and ships them inside the app bundle. Runtime spawn
# logic lives in src-tauri/src/lib.rs.
# ─────────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")/.."
DESKTOP_ROOT="$(pwd)"
REPO_ROOT="$(cd ../.. && pwd)"
STAGE="$DESKTOP_ROOT/sidecar-stage"

GREEN='\033[0;32m'; YELLOW='\033[0;33m'; NC='\033[0m'
log() { printf "${GREEN}▸${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}!${NC} %s\n" "$*"; }

rm -rf "$STAGE"
mkdir -p "$STAGE"

# ── Cockpit standalone ─────────────────────────────────────────────
log "Building Cockpit standalone"
(
  cd "$REPO_ROOT/apps/compliance-cockpit"
  npm run build >/dev/null
)
log "Staging Cockpit"
mkdir -p "$STAGE/cockpit-static"
cp -R "$REPO_ROOT/apps/compliance-cockpit/.next/standalone/." "$STAGE/cockpit-static/"
# Public assets aren't auto-included in standalone — copy them manually
cp -R "$REPO_ROOT/apps/compliance-cockpit/public" \
      "$STAGE/cockpit-static/apps/compliance-cockpit/public"
cp -R "$REPO_ROOT/apps/compliance-cockpit/.next/static" \
      "$STAGE/cockpit-static/apps/compliance-cockpit/.next/static"

# ── Gateway ────────────────────────────────────────────────────────
log "Building gateway"
(
  cd "$REPO_ROOT/packages/gateway-mcp"
  npm run build >/dev/null
)
log "Staging gateway"
mkdir -p "$STAGE/gateway-bin"
cp -R "$REPO_ROOT/packages/gateway-mcp/dist/." "$STAGE/gateway-bin/"
cp "$REPO_ROOT/packages/gateway-mcp/package.json" "$STAGE/gateway-bin/"
# Production-only deps. Use --omit=dev to skip jest/typescript/etc.
(
  cd "$STAGE/gateway-bin"
  npm install --omit=dev --no-audit --no-fund --silent
)
# better-sqlite3 native module needs to match the *runtime* architecture.
# Tauri prepare runs on the build machine, so this works for like-for-like
# builds. Cross-builds need a CI matrix — out of scope for Phase A.2.

# ── Node runtime ───────────────────────────────────────────────────
NODE_VERSION="$(node --version | sed 's/^v//')"
NODE_DIST_BASE="https://nodejs.org/dist/v${NODE_VERSION}"
ARCH="$(uname -m)"
OS="$(uname -s)"

case "$OS-$ARCH" in
  Darwin-arm64)   NODE_ARCH="darwin-arm64" ;;
  Darwin-x86_64)  NODE_ARCH="darwin-x64" ;;
  Linux-x86_64)   NODE_ARCH="linux-x64" ;;
  Linux-aarch64)  NODE_ARCH="linux-arm64" ;;
  *)
    warn "Unknown OS-ARCH $OS-$ARCH — copying system Node binary instead"
    NODE_ARCH=""
    ;;
esac

mkdir -p "$STAGE/node-runtime/bin"
if [ -n "$NODE_ARCH" ]; then
  TARBALL="node-v${NODE_VERSION}-${NODE_ARCH}.tar.gz"
  CACHE="$STAGE/../.node-cache"
  mkdir -p "$CACHE"
  if [ ! -f "$CACHE/$TARBALL" ]; then
    log "Downloading Node v${NODE_VERSION} ($NODE_ARCH)"
    curl -fsSL -o "$CACHE/$TARBALL" "$NODE_DIST_BASE/$TARBALL"
  fi
  tar -xzf "$CACHE/$TARBALL" -C "$STAGE/node-runtime" --strip-components=1
else
  cp "$(command -v node)" "$STAGE/node-runtime/bin/node"
fi
log "Staged Node $(${STAGE}/node-runtime/bin/node --version)"

log "Sidecars staged under $STAGE"

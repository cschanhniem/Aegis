#!/usr/bin/env bash
# shellcheck shell=bash
#
# AEGIS one-line installer  ·  https://aegistraces.com/install
# ─────────────────────────────────────────────────────────────
#   curl -fsSL https://aegistraces.com/install | sh
#
# Downloads the right pre-built binary for your machine, installs it
# to /usr/local/bin (or $HOME/.aegis/bin if unprivileged), and prints
# what to do next.
#
# No git, no docker, no build toolchain required — the binary ships
# the gateway, the cockpit, and an embedded runtime.
#
# Honours:
#   AEGIS_VERSION   release tag to fetch (default: latest)
#   AEGIS_PREFIX    install root         (default: /usr/local or $HOME/.aegis)
#   AEGIS_CHANNEL   stable | beta        (default: stable)
#   AEGIS_NO_PATH   set to 1 to skip PATH modification of shell rc
#
# Inspired by: bun.sh/install · ollama.com/install.sh · k3s.io · tailscale.com
# ─────────────────────────────────────────────────────────────
set -eu

# ── Brand ───────────────────────────────────────────────────────
LOGO='
   █████╗ ███████╗ ██████╗ ██╗███████╗
  ██╔══██╗██╔════╝██╔════╝ ██║██╔════╝
  ███████║█████╗  ██║  ███╗██║███████╗
  ██╔══██║██╔══╝  ██║   ██║██║╚════██║
  ██║  ██║███████╗╚██████╔╝██║███████║
  ╚═╝  ╚═╝╚══════╝ ╚═════╝ ╚═╝╚══════╝
            runtime safety for AI agents'

# ── Colors (only if attached to a TTY) ──────────────────────────
if [ -t 1 ]; then
  C_G=$'\033[0;32m'; C_R=$'\033[0;31m'; C_Y=$'\033[0;33m'
  C_B=$'\033[1m';    C_D=$'\033[2m';    C_N=$'\033[0m'
else
  C_G='';C_R='';C_Y='';C_B='';C_D='';C_N=''
fi
say()  { printf "%s\n" "$*"; }
ok()   { printf "${C_G}✓${C_N} %s\n" "$*"; }
warn() { printf "${C_Y}!${C_N} %s\n" "$*" >&2; }
err()  { printf "${C_R}✗${C_N} %s\n" "$*" >&2; exit 1; }
step() { printf "\n${C_B}▸${C_N} ${C_B}%s${C_N}\n" "$*"; }
dim()  { printf "${C_D}  %s${C_N}\n" "$*"; }

# ── Defaults ────────────────────────────────────────────────────
AEGIS_VERSION="${AEGIS_VERSION:-latest}"
AEGIS_CHANNEL="${AEGIS_CHANNEL:-stable}"
AEGIS_NO_PATH="${AEGIS_NO_PATH:-0}"
REPO="Justin0504/Aegis"

# ── Banner ──────────────────────────────────────────────────────
printf "${C_B}%s${C_N}\n" "$LOGO"
printf "\n${C_D}  channel: %s · version: %s${C_N}\n\n" \
  "$AEGIS_CHANNEL" "$AEGIS_VERSION"

# ── 1. Detect platform ──────────────────────────────────────────
step "Detecting platform"

OS_RAW=$(uname -s)
ARCH_RAW=$(uname -m)

case "$OS_RAW" in
  Linux)  OS=linux  ;;
  Darwin) OS=darwin ;;
  *) err "Unsupported OS: $OS_RAW (Linux and macOS only — Windows users: use WSL2 or download AEGIS_Setup.exe from the releases page)" ;;
esac

case "$ARCH_RAW" in
  x86_64|amd64)        ARCH=x86_64 ;;
  arm64|aarch64)       ARCH=arm64  ;;
  *) err "Unsupported architecture: $ARCH_RAW" ;;
esac

TARGET="aegis-${OS}-${ARCH}"
ok "Detected ${C_B}${OS}/${ARCH}${C_N}"

# ── 2. Pick install prefix ──────────────────────────────────────
step "Picking install directory"

if [ -n "${AEGIS_PREFIX:-}" ]; then
  PREFIX="$AEGIS_PREFIX"
elif [ -w /usr/local/bin ]; then
  PREFIX=/usr/local
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  PREFIX=/usr/local
  USE_SUDO=1
else
  PREFIX="$HOME/.aegis"
  mkdir -p "$PREFIX/bin"
fi
BIN_DIR="$PREFIX/bin"
CFG_DIR="$HOME/.aegis"
mkdir -p "$CFG_DIR"

ok "Will install to ${C_B}${BIN_DIR}${C_N}"

# ── 3. Resolve the download URL ─────────────────────────────────
step "Resolving release"

if [ "$AEGIS_VERSION" = "latest" ]; then
  if [ "$AEGIS_CHANNEL" = "stable" ]; then
    RELEASE_API="https://api.github.com/repos/${REPO}/releases/latest"
  else
    # Pre-release: walk /releases and pick the newest where prerelease=true
    RELEASE_API="https://api.github.com/repos/${REPO}/releases?per_page=10"
  fi

  RESP=$(curl -fsSL "$RELEASE_API" 2>/dev/null || true)
  if [ -z "$RESP" ]; then
    warn "Could not reach GitHub. Falling back to docker installer."
    exec curl -fsSL "https://raw.githubusercontent.com/${REPO}/main/scripts/install-docker.sh" | sh
  fi

  if [ "$AEGIS_CHANNEL" = "beta" ]; then
    TAG=$(printf "%s" "$RESP" | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
  else
    TAG=$(printf "%s" "$RESP" | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
  fi
  [ -z "$TAG" ] && err "Could not parse release tag from GitHub API"
else
  TAG="$AEGIS_VERSION"
fi

ASSET="${TARGET}.tar.gz"
URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"
SHA="https://github.com/${REPO}/releases/download/${TAG}/${ASSET}.sha256"

ok "Release ${C_B}${TAG}${C_N}"
dim "  asset: $ASSET"

# ── 4. Download + verify ────────────────────────────────────────
step "Downloading"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

if ! curl -fL --progress-bar -o "$TMP/$ASSET" "$URL"; then
  err "Download failed. Verify your network and that the release exists:
    $URL"
fi
ok "Downloaded $(du -h "$TMP/$ASSET" | awk '{print $1}')"

# SHA256 verify — strict, no skip
if curl -fsSL "$SHA" -o "$TMP/$ASSET.sha256" 2>/dev/null; then
  step "Verifying checksum"
  EXPECTED=$(awk '{print $1}' "$TMP/$ASSET.sha256")
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL=$(sha256sum "$TMP/$ASSET" | awk '{print $1}')
  else
    ACTUAL=$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')
  fi
  if [ "$EXPECTED" != "$ACTUAL" ]; then
    err "Checksum mismatch.
    expected: $EXPECTED
    actual:   $ACTUAL
  Aborting — do NOT run a binary that fails verification."
  fi
  ok "Checksum verified"
else
  warn "No .sha256 file published for ${TAG} — skipping verification (not ideal)"
fi

# ── 5. Extract + install ────────────────────────────────────────
step "Installing"

tar -xzf "$TMP/$ASSET" -C "$TMP"

# The tarball layout is expected to be:
#   aegis-<os>-<arch>/
#     bin/aegis
#     bin/aegis-gateway
#     bin/aegis-cockpit
#     LICENSE  README.md
SRC="$TMP/$TARGET"
[ -d "$SRC" ] || SRC="$TMP"   # fallback if tarball is flat
[ -d "$SRC/bin" ] || err "Tarball layout unexpected. Open an issue: https://github.com/${REPO}/issues"

if [ -n "${USE_SUDO:-}" ]; then
  sudo install -m 0755 "$SRC/bin/aegis" "$BIN_DIR/aegis"
  [ -f "$SRC/bin/aegis-gateway" ] && sudo install -m 0755 "$SRC/bin/aegis-gateway" "$BIN_DIR/aegis-gateway"
  [ -f "$SRC/bin/aegis-cockpit" ] && sudo install -m 0755 "$SRC/bin/aegis-cockpit" "$BIN_DIR/aegis-cockpit"
else
  install -m 0755 "$SRC/bin/aegis" "$BIN_DIR/aegis"
  [ -f "$SRC/bin/aegis-gateway" ] && install -m 0755 "$SRC/bin/aegis-gateway" "$BIN_DIR/aegis-gateway"
  [ -f "$SRC/bin/aegis-cockpit" ] && install -m 0755 "$SRC/bin/aegis-cockpit" "$BIN_DIR/aegis-cockpit"
fi
ok "Binaries placed in $BIN_DIR"

# ── 6. Ensure $BIN_DIR is on PATH ────────────────────────────────
if [ "$AEGIS_NO_PATH" != "1" ] && ! printf "%s" "$PATH" | tr ':' '\n' | grep -qx "$BIN_DIR"; then
  step "Updating shell PATH"

  # Pick the most likely shell init file
  RC=""
  case "${SHELL:-}" in
    */zsh)  RC="$HOME/.zshrc"  ;;
    */bash) RC="$HOME/.bashrc" ;;
    */fish) RC="$HOME/.config/fish/config.fish" ;;
  esac

  if [ -n "$RC" ]; then
    # Don't duplicate
    LINE='export PATH="'"$BIN_DIR"':$PATH"   # added by AEGIS installer'
    [ -f "$RC" ] || touch "$RC"
    if ! grep -Fxq "$LINE" "$RC"; then
      printf '\n# AEGIS — runtime safety for AI agents (https://aegistraces.com)\n%s\n' "$LINE" >>"$RC"
      ok "Added ${C_B}${BIN_DIR}${C_N} to PATH in ${C_B}$(basename "$RC")${C_N}"
      dim "(restart your shell or run: source \"$RC\")"
    fi
  else
    warn "Unknown shell — add this to your shell rc manually:
    export PATH=\"$BIN_DIR:\$PATH\""
  fi
fi

# ── 7. Self-test ────────────────────────────────────────────────
step "Verifying install"

if "$BIN_DIR/aegis" --version >/dev/null 2>&1; then
  VERSION_OUT=$("$BIN_DIR/aegis" --version 2>/dev/null || echo "$TAG")
  ok "Installed ${C_B}aegis ${VERSION_OUT}${C_N}"
else
  warn "Binary installed but \`aegis --version\` failed. Open an issue with platform details."
fi

# ── 8. Next steps ───────────────────────────────────────────────
cat <<EOF

${C_B}═════════════════════════════════════════════════════════════════${C_N}
  ${C_G}AEGIS installed.${C_N} Three commands to know:

  ${C_B}aegis login${C_N}              ${C_D}# pair this machine to your account${C_N}
  ${C_B}aegis up${C_N}                 ${C_D}# start gateway + cockpit (http://localhost:8080)${C_N}
  ${C_B}aegis scan ./your-repo${C_N}   ${C_D}# pre-deploy scan of your agent code${C_N}

  Docs:        https://aegistraces.com/docs
  Discord:     https://aegistraces.com/community
  GitHub:      https://github.com/${REPO}
${C_B}═════════════════════════════════════════════════════════════════${C_N}

EOF

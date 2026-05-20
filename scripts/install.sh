#!/usr/bin/env bash
# shellcheck shell=bash
#
# AEGIS One-Command Installer
# ─────────────────────────────────────────────────────────────
# Usage (from anywhere):
#
#   curl -fsSL https://raw.githubusercontent.com/Justin0504/Aegis/main/scripts/install.sh | bash
#
# Or, with a custom install directory:
#
#   curl -fsSL https://raw.githubusercontent.com/Justin0504/Aegis/main/scripts/install.sh \
#     | AEGIS_DIR=$HOME/aegis bash
#
# Environment variables:
#   AEGIS_DIR          target directory (default: ./aegis)
#   AEGIS_BRANCH       git branch to clone (default: main)
#   AEGIS_REPO         git URL (default: https://github.com/Justin0504/Aegis.git)
#   AEGIS_SKIP_PULL    set to 1 to skip 'docker compose pull'
#   AEGIS_NO_START     set to 1 to clone + write .env but NOT start docker
#
# This script:
#   1. Validates required tools (git, docker, docker compose)
#   2. Clones the repo into $AEGIS_DIR (or updates if it already exists)
#   3. Creates .env from .env.example if missing
#   4. Runs `docker compose up -d`
#   5. Polls /health and prints the dashboard URL + bootstrap API key
# ─────────────────────────────────────────────────────────────
set -euo pipefail

AEGIS_DIR="${AEGIS_DIR:-./aegis}"
AEGIS_BRANCH="${AEGIS_BRANCH:-main}"
AEGIS_REPO="${AEGIS_REPO:-https://github.com/Justin0504/Aegis.git}"
AEGIS_SKIP_PULL="${AEGIS_SKIP_PULL:-0}"
AEGIS_NO_START="${AEGIS_NO_START:-0}"

# ── Terminal colors (no-op if stdout is not a TTY) ────────────
if [ -t 1 ]; then
  GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'
  DIM='\033[2m'; BOLD='\033[1m'; NC='\033[0m'
else
  GREEN=''; RED=''; YELLOW=''; DIM=''; BOLD=''; NC=''
fi
info()  { printf "${GREEN}%s${NC}\n" "$*"; }
warn()  { printf "${YELLOW}%s${NC}\n" "$*"; }
err()   { printf "${RED}%s${NC}\n" "$*" >&2; }
dim()   { printf "${DIM}%s${NC}\n" "$*"; }
step()  { printf "\n${BOLD}▸ %s${NC}\n" "$*"; }

# ── 1. Pre-flight ────────────────────────────────────────────
step "Pre-flight checks"

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Linux|Darwin) ;;
  *) err "Unsupported OS: $OS (this installer supports Linux and macOS)"; exit 1;;
esac
case "$ARCH" in
  x86_64|amd64|arm64|aarch64) ;;
  *) warn "Untested architecture: $ARCH (continuing anyway)";;
esac
dim "  OS:   $OS"
dim "  Arch: $ARCH"

# macOS users almost always want the .dmg — it ships the gateway, the
# Cockpit, and a Node runtime in one self-contained app. Surface that
# path before walking them through git clone + Docker.
if [ "$OS" = "Darwin" ] && [ -z "${AEGIS_FORCE_DOCKER:-}" ]; then
  echo
  warn "Detected macOS. The fastest install is the native .dmg:"
  echo "  https://github.com/Justin0504/Aegis/releases/latest"
  echo
  echo "  - Apple Silicon (M1+): AEGIS_*_aarch64.dmg"
  echo "  - Intel:                AEGIS_*_x64.dmg"
  echo
  dim "  Continuing with the Docker path below in 5s — Ctrl+C to abort"
  dim "  (Skip this nudge by setting AEGIS_FORCE_DOCKER=1)"
  sleep 5
  echo
fi

for bin in git curl docker; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    err "Required: $bin (not found in PATH)"
    case "$bin" in
      docker) echo "  Install Docker Desktop: https://docs.docker.com/get-docker/";;
      git)    echo "  Install git via your package manager.";;
      curl)   echo "  Install curl via your package manager.";;
    esac
    exit 1
  fi
done

# Detect docker compose v1 (docker-compose) vs v2 (docker compose)
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  err "Docker Compose not found (neither 'docker compose' nor 'docker-compose')."
  exit 1
fi
dim "  Compose: $COMPOSE"

# Docker daemon reachable? (only required if we are actually going to start)
if [ "$AEGIS_NO_START" != "1" ]; then
  if ! docker info >/dev/null 2>&1; then
    err "Docker daemon is not reachable. Start Docker Desktop / dockerd and retry."
    exit 1
  fi
fi

# ── 2. Clone or update ───────────────────────────────────────
step "Fetching AEGIS into $AEGIS_DIR"

if [ -d "$AEGIS_DIR/.git" ]; then
  dim "  Existing checkout detected — pulling latest from $AEGIS_BRANCH"
  git -C "$AEGIS_DIR" fetch --depth 1 origin "$AEGIS_BRANCH"
  git -C "$AEGIS_DIR" checkout "$AEGIS_BRANCH"
  git -C "$AEGIS_DIR" pull --ff-only origin "$AEGIS_BRANCH"
else
  git clone --depth 1 --branch "$AEGIS_BRANCH" "$AEGIS_REPO" "$AEGIS_DIR"
fi
cd "$AEGIS_DIR"

# ── 3. .env bootstrap ────────────────────────────────────────
if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  dim "  Created .env from .env.example"
fi

if [ "$AEGIS_NO_START" = "1" ]; then
  info "Clone complete. Skipping docker startup (AEGIS_NO_START=1)."
  echo "To start later: cd $AEGIS_DIR && $COMPOSE up -d"
  exit 0
fi

# ── 4. Pull images + start ───────────────────────────────────
step "Starting AEGIS"

if [ "$AEGIS_SKIP_PULL" != "1" ]; then
  $COMPOSE pull
fi
$COMPOSE up -d --build

# ── 5. Wait for gateway ──────────────────────────────────────
printf "Waiting for gateway"
HEALTHY=0
for _ in $(seq 1 30); do
  if curl -sf http://localhost:8080/health >/dev/null 2>&1; then
    HEALTHY=1; printf "\n"; break
  fi
  printf "."; sleep 2
done

if [ $HEALTHY -ne 1 ]; then
  err "Gateway did not become healthy within 60s."
  echo "Inspect logs: $COMPOSE logs gateway"
  exit 1
fi
info "Gateway is healthy."

# ── 6. Bootstrap dashboard key ───────────────────────────────
KEY=""
KEY="$(curl -sf http://localhost:8080/api/v1/auth/key 2>/dev/null \
  | sed -n 's/.*"api_key":"\([^"]*\)".*/\1/p' || true)"

# ── 7. Done ──────────────────────────────────────────────────
echo
echo "═══════════════════════════════════════════════════════════════"
info "  AEGIS is running."
echo "═══════════════════════════════════════════════════════════════"
echo
echo "  Cockpit  : ${BOLD}http://localhost:3000${NC}"
echo "  Gateway  : ${BOLD}http://localhost:8080${NC}"
if [ -n "$KEY" ]; then
  echo "  API Key  : ${BOLD}$KEY${NC}"
  dim "  (paste into the Cockpit Settings tab on first load)"
fi
echo
echo "  Add the SDK to your agent (one line):"
dim "    python -c \"import agentguard; agentguard.auto('http://localhost:8080', agent_id='my-agent')\""
echo
dim "  Stop:    cd $AEGIS_DIR && $COMPOSE down"
dim "  Logs:    cd $AEGIS_DIR && $COMPOSE logs -f"
dim "  Update:  cd $AEGIS_DIR && git pull && $COMPOSE up -d --build"
echo

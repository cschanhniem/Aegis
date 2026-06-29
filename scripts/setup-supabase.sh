#!/usr/bin/env bash
# AEGIS — Supabase project bootstrap.
#
# Supabase = managed Postgres + auth + storage. We use ONLY the managed
# Postgres part (auth lives in our own control-plane). This script:
#
#   1. Ensures supabase CLI is installed + logged in.
#   2. Creates a project (or re-uses one by name).
#   3. Pulls the connection string into apps/control-plane/.env.local
#      (preserving any existing keys via merge, never blind-overwrite).
#   4. Runs migrations against the new DB via existing scripts/migrate.mjs.
#
# Usage:
#   ./scripts/setup-supabase.sh                          # interactive
#   SUPABASE_PROJECT=aegis-prod \
#   SUPABASE_REGION=us-west-1 \
#   SUPABASE_ORG_ID=xxxxxxxx \
#   SUPABASE_DB_PASSWORD=… \
#     ./scripts/setup-supabase.sh                        # non-interactive

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/apps/control-plane/.env.local"

GREEN='\033[0;32m'; YELLOW='\033[0;33m'; DIM='\033[2m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { printf "${GREEN}✓ %s${NC}\n" "$*"; }
step() { printf "\n${GREEN}▸ %s${NC}\n" "$*"; }
warn() { printf "${YELLOW}! %s${NC}\n" "$*"; }
die()  { printf "${RED}✗ %s${NC}\n" "$*"; exit 1; }
dim()  { printf "${DIM}%s${NC}\n" "$*"; }

command -v supabase >/dev/null 2>&1 || die "supabase CLI required. brew install supabase/tap/supabase"
command -v jq >/dev/null 2>&1 || die "jq required.  brew install jq"

step "1. Supabase CLI auth"
if ! supabase projects list >/dev/null 2>&1; then
  echo "Run: supabase login"
  exit 1
fi
ok "Authenticated."

# ── Inputs ────────────────────────────────────────────────────────────
PROJECT_NAME="${SUPABASE_PROJECT:-}"
REGION="${SUPABASE_REGION:-us-west-1}"
ORG_ID="${SUPABASE_ORG_ID:-}"
DB_PASSWORD="${SUPABASE_DB_PASSWORD:-}"

if [ -z "$PROJECT_NAME" ]; then
  read -rp "Supabase project name (e.g. aegis-prod): " PROJECT_NAME
fi
[ -z "$PROJECT_NAME" ] && die "Project name required."

if [ -z "$ORG_ID" ]; then
  echo
  dim "Your Supabase orgs:"
  supabase orgs list
  echo
  read -rp "Org ID to create project under: " ORG_ID
fi
[ -z "$ORG_ID" ] && die "Org ID required."

if [ -z "$DB_PASSWORD" ]; then
  read -rsp "New DB password (≥16 chars, used for connection string): " DB_PASSWORD
  echo
fi
[ ${#DB_PASSWORD} -lt 16 ] && die "Password too short."

# ── Project create / reuse ────────────────────────────────────────────
step "2. Project"
PROJECT_REF="$(supabase projects list -o json 2>/dev/null \
  | jq -r ".[] | select(.name==\"$PROJECT_NAME\") | .id" | head -1)"

if [ -n "$PROJECT_REF" ]; then
  ok "Existing project found: $PROJECT_REF (re-using)"
else
  step "   Creating $PROJECT_NAME in $REGION (~30s)..."
  CREATE_OUT="$(supabase projects create "$PROJECT_NAME" \
      --org-id "$ORG_ID" \
      --region "$REGION" \
      --db-password "$DB_PASSWORD" \
      -o json)"
  PROJECT_REF="$(echo "$CREATE_OUT" | jq -r '.id // .ref')"
  [ -z "$PROJECT_REF" ] || [ "$PROJECT_REF" = "null" ] && die "Project create failed: $CREATE_OUT"
  ok "Created: $PROJECT_REF"
  dim "Waiting 20s for project to come online…"
  sleep 20
fi

# ── Connection strings ────────────────────────────────────────────────
step "3. Connection strings"
# Pooled (transaction mode, port 6543) — recommended for serverless / Next.js routes
POOLER_URL="postgres://postgres.${PROJECT_REF}:${DB_PASSWORD}@aws-0-${REGION}.pooler.supabase.com:6543/postgres"
# Direct (port 5432) — recommended for migrations + long-lived connections
DIRECT_URL="postgres://postgres.${PROJECT_REF}:${DB_PASSWORD}@aws-0-${REGION}.pooler.supabase.com:5432/postgres"
ok "Pooled: $(echo "$POOLER_URL" | sed 's/:[^:@]*@/:****@/')"
ok "Direct: $(echo "$DIRECT_URL" | sed 's/:[^:@]*@/:****@/')"

# ── Merge into .env.local (preserve other keys) ───────────────────────
step "4. Updating $ENV_FILE"
mkdir -p "$(dirname "$ENV_FILE")"
TMP="$(mktemp)"
# Copy non-DB lines through
if [ -f "$ENV_FILE" ]; then
  grep -v -E '^(DATABASE_URL|DATABASE_URL_DIRECT|SUPABASE_PROJECT_REF|SUPABASE_REGION)=' "$ENV_FILE" >"$TMP" || true
fi
{
  echo "# --- Supabase (managed Postgres) ---"
  echo "DATABASE_URL=$POOLER_URL"
  echo "DATABASE_URL_DIRECT=$DIRECT_URL"
  echo "SUPABASE_PROJECT_REF=$PROJECT_REF"
  echo "SUPABASE_REGION=$REGION"
} >>"$TMP"
mv "$TMP" "$ENV_FILE"
ok "Updated (existing keys preserved)."

# ── Run migrations ────────────────────────────────────────────────────
step "5. Running migrations"
# Migrations use long-lived connection — use direct, not pooler.
DATABASE_URL="$DIRECT_URL" node "$REPO_ROOT/apps/control-plane/scripts/migrate.mjs"
ok "Schema applied to $PROJECT_REF."

step "Done"
echo
dim "Supabase dashboard: https://supabase.com/dashboard/project/$PROJECT_REF"
dim "Restart control-plane to pick up the new DATABASE_URL:"
echo "    ( cd apps/control-plane && npm run dev )"
echo
warn "Don't forget: in Supabase Dashboard → Settings → Database, set the"
warn "'Connection pooler' to TRANSACTION mode for the pooler URL to behave"
warn "correctly with Next.js API routes."

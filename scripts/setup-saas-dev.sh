#!/usr/bin/env bash
# AEGIS — SaaS control-plane local-dev setup.
#
# Stands up Postgres in Docker, runs migrations, fills .env.local
# with sane dev defaults, prints the run commands for control-plane
# + gateway.
#
# Use this to validate the control-plane scaffold WITHOUT signing up
# for Supabase / Stripe / Cloudflare yet. Everything stays on localhost.

set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[0;33m'; DIM='\033[2m'; NC='\033[0m'
ok()    { printf "${GREEN}✓ %s${NC}\n" "$*"; }
warn()  { printf "${YELLOW}! %s${NC}\n" "$*"; }
dim()   { printf "${DIM}%s${NC}\n" "$*"; }
step()  { printf "\n${GREEN}▸ %s${NC}\n" "$*"; }

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CP_DIR="$REPO_ROOT/apps/control-plane"

[ -d "$CP_DIR" ] || { echo "apps/control-plane not found — run from monorepo root"; exit 1; }

step "1. Postgres in Docker"
if docker ps --format '{{.Names}}' | grep -q '^aegis-saas-pg$'; then
  ok "aegis-saas-pg already running."
else
  docker run -d \
    --name aegis-saas-pg \
    -p 54330:5432 \
    -e POSTGRES_USER=aegis \
    -e POSTGRES_PASSWORD=devpass \
    -e POSTGRES_DB=aegis \
    postgres:16-alpine >/dev/null
  ok "Started aegis-saas-pg on localhost:54330."
  echo -n "Waiting for Postgres "
  for i in {1..20}; do
    docker exec aegis-saas-pg pg_isready -U aegis >/dev/null 2>&1 && { echo " ready"; break; }
    echo -n "."
    sleep 0.5
  done
fi

step "2. Write .env.local"
DATABASE_URL="postgres://aegis:devpass@localhost:54330/aegis"
NEXTAUTH_SECRET="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | xxd -p -c 32)"

cat > "$CP_DIR/.env.local" <<EOF
DATABASE_URL=$DATABASE_URL
NEXTAUTH_SECRET=$NEXTAUTH_SECRET
NEXTAUTH_URL=http://localhost:14000
APP_URL=http://localhost:14000
NODE_ENV=development
LOG_LEVEL=info

# Stripe — set when ready to test billing
STRIPE_SECRET_KEY=sk_test_REPLACE_ME
STRIPE_WEBHOOK_SECRET=whsec_REPLACE_ME
STRIPE_PRICE_ID_PRO_MONTHLY=
STRIPE_PRICE_ID_PRO_ANNUAL=
STRIPE_PRICE_ID_TEAM_MONTHLY=
STRIPE_PRICE_ID_TEAM_ANNUAL=

# Gateway — internal URL the control plane proxies to
GATEWAY_INTERNAL_URL=http://localhost:8080
GATEWAY_ADMIN_KEY=

# Cloudflare — for *.aegis.dev tenant subdomains (skip in dev)
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_ZONE_ID=
TENANT_DNS_TARGET=
EOF
ok "Wrote $CP_DIR/.env.local"

step "3. Install + migrate"
# Install at workspace ROOT so the monorepo lockfile stays in sync
# (CI runs \`npm ci\` at root; a child-only install drifts the lockfile).
( cd "$REPO_ROOT" && npm install --no-audit --no-fund )
( cd "$CP_DIR" && npm run migrate )

step "4. Done"
dim "Control plane:"
echo "  cd apps/control-plane && npm run dev   # http://localhost:14000"
echo
dim "Gateway (separate terminal, points at the same Postgres):"
echo "  cd packages/gateway-mcp && DB_URL='$DATABASE_URL' AEGIS_LICENSE_TIER=pro npm run dev"
echo
dim "Wipe everything:"
echo "  docker rm -f aegis-saas-pg"
echo
ok "Test the signup flow:  http://localhost:14000"

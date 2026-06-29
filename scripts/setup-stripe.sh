#!/usr/bin/env bash
# AEGIS — Stripe products + prices + webhook one-shot setup.
#
# Usage:
#   ./scripts/setup-stripe.sh                 # uses test mode
#   STRIPE_MODE=live ./scripts/setup-stripe.sh
#
# What this does:
#   1. Verifies stripe CLI is installed + logged in.
#   2. Creates 2 products: aegis-pro, aegis-team.
#   3. Creates 4 prices: pro-monthly $19, pro-annual $190,
#                        team-monthly $99, team-annual $990.
#   4. Creates a webhook endpoint pointing at
#        $WEBHOOK_URL (default http://localhost:14000/api/stripe/webhook)
#      subscribed to the 5 events we handle.
#   5. Prints all IDs + the webhook signing secret in shell-paste-able
#      form so you can drop them straight into .env.local.
#
# Idempotent: re-running with existing products by name skips creation.

set -euo pipefail

MODE="${STRIPE_MODE:-test}"
WEBHOOK_URL="${WEBHOOK_URL:-http://localhost:14000/api/stripe/webhook}"

if [ "$MODE" != "test" ] && [ "$MODE" != "live" ]; then
  echo "STRIPE_MODE must be 'test' or 'live'"
  exit 1
fi

GREEN='\033[0;32m'; YELLOW='\033[0;33m'; DIM='\033[2m'; NC='\033[0m'
ok()    { printf "${GREEN}✓ %s${NC}\n" "$*"; }
step()  { printf "\n${GREEN}▸ %s${NC}\n" "$*"; }
dim()   { printf "${DIM}%s${NC}\n" "$*"; }

command -v stripe >/dev/null 2>&1 || {
  echo "stripe CLI required.  brew install stripe/stripe-cli/stripe"
  exit 1
}

step "1. Stripe CLI auth check (mode=$MODE)"
if ! stripe config --list 2>/dev/null | grep -q "test_mode_api_key\|live_mode_api_key"; then
  echo "Run: stripe login"
  exit 1
fi
ok "Authenticated."

# Helper — create a product or return its existing id by name.
ensure_product() {
  local name="$1"
  local existing
  existing="$(stripe products list --limit 100 --"$MODE"-mode 2>/dev/null \
    | jq -r ".data[] | select(.name==\"$name\") | .id" | head -1)"
  if [ -n "$existing" ]; then
    echo "$existing"
    return
  fi
  stripe products create \
    --name "$name" \
    --description "AEGIS hosted SaaS — $name" \
    --"$MODE"-mode 2>/dev/null \
    | jq -r '.id'
}

# Helper — create a recurring price or return its existing id.
ensure_price() {
  local product="$1"
  local nickname="$2"
  local amount_cents="$3"
  local interval="$4"     # month | year
  local existing
  existing="$(stripe prices list --product "$product" --limit 100 --"$MODE"-mode 2>/dev/null \
    | jq -r ".data[] | select(.nickname==\"$nickname\") | .id" | head -1)"
  if [ -n "$existing" ]; then
    echo "$existing"
    return
  fi
  stripe prices create \
    --product "$product" \
    --currency usd \
    --unit-amount "$amount_cents" \
    -d "recurring[interval]=$interval" \
    --nickname "$nickname" \
    --"$MODE"-mode 2>/dev/null \
    | jq -r '.id'
}

step "2. Products"
PRO_PRODUCT="$(ensure_product 'aegis-pro')"
TEAM_PRODUCT="$(ensure_product 'aegis-team')"
ok "Pro product:  $PRO_PRODUCT"
ok "Team product: $TEAM_PRODUCT"

step "3. Prices"
PRO_MONTHLY="$(ensure_price  "$PRO_PRODUCT"  'pro-monthly'  1900   month)"
PRO_ANNUAL="$( ensure_price  "$PRO_PRODUCT"  'pro-annual'   19000  year)"
TEAM_MONTHLY="$(ensure_price "$TEAM_PRODUCT" 'team-monthly' 9900   month)"
TEAM_ANNUAL="$( ensure_price "$TEAM_PRODUCT" 'team-annual'  99000  year)"
ok "Pro monthly  \$19  : $PRO_MONTHLY"
ok "Pro annual   \$190 : $PRO_ANNUAL"
ok "Team monthly \$99  : $TEAM_MONTHLY"
ok "Team annual  \$990 : $TEAM_ANNUAL"

step "4. Webhook endpoint"
EVENTS="checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.payment_failed"
EXISTING_HOOK="$(stripe webhook_endpoints list --limit 100 --"$MODE"-mode 2>/dev/null \
  | jq -r ".data[] | select(.url==\"$WEBHOOK_URL\") | .id" | head -1)"
if [ -n "$EXISTING_HOOK" ]; then
  WEBHOOK_ID="$EXISTING_HOOK"
  ok "Webhook endpoint already exists: $WEBHOOK_ID"
  dim "(re-using; signing secret is only revealed on creation — if you need it, delete + recreate)"
  WEBHOOK_SECRET=""
else
  WEBHOOK_JSON="$(stripe webhook_endpoints create \
    --url "$WEBHOOK_URL" \
    --enabled-events "$EVENTS" \
    --"$MODE"-mode 2>/dev/null)"
  WEBHOOK_ID="$(echo "$WEBHOOK_JSON" | jq -r '.id')"
  WEBHOOK_SECRET="$(echo "$WEBHOOK_JSON" | jq -r '.secret')"
  ok "Created webhook: $WEBHOOK_ID"
fi

step "5. Paste into apps/control-plane/.env.local"
SECRET_KEY_LINE="STRIPE_SECRET_KEY="
if [ "$MODE" = "test" ]; then
  SECRET_KEY_LINE+="(your sk_test_ key from https://dashboard.stripe.com/test/apikeys)"
else
  SECRET_KEY_LINE+="(your sk_live_ key — DO NOT commit)"
fi

cat <<EOF

# --- Stripe ($MODE mode) ---
$SECRET_KEY_LINE
STRIPE_WEBHOOK_SECRET=${WEBHOOK_SECRET:-(re-create the webhook to get this)}
STRIPE_PRICE_ID_PRO_MONTHLY=$PRO_MONTHLY
STRIPE_PRICE_ID_PRO_ANNUAL=$PRO_ANNUAL
STRIPE_PRICE_ID_TEAM_MONTHLY=$TEAM_MONTHLY
STRIPE_PRICE_ID_TEAM_ANNUAL=$TEAM_ANNUAL
EOF

if [ -n "$WEBHOOK_SECRET" ]; then
  echo
  ok "All set. The webhook signing secret above is shown ONCE — save it now."
fi

step "Local dev tip"
dim "To test webhooks against localhost without ngrok, run:"
echo "    stripe listen --forward-to $WEBHOOK_URL --$MODE-mode"
dim "That command prints a webhook secret too — use that instead of the"
dim "one created above when you're forwarding via the CLI."

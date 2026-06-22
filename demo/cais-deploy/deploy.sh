#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# CAIS 2026 Demo — Quick Deploy & Seed
# ═══════════════════════════════════════════════════════════════
#
# Option A: Deploy to Render (recommended for reviewers)
#   1. Push this repo to GitHub
#   2. Go to https://dashboard.render.com/blueprints
#   3. New Blueprint Instance → select this repo
#   4. Wait for both services to deploy (~5 min)
#   5. Run this script with the gateway URL:
#      ./deploy.sh https://aegis-gateway-demo.onrender.com
#
# Option B: Deploy locally with Docker Compose
#   cd /path/to/agentguard
#   docker compose up -d
#   ./demo/cais-deploy/deploy.sh http://localhost:8080
#

set -e

GATEWAY_URL="${1:-http://localhost:8080}"

echo ""
echo "════════════════════════════════════════════"
echo "  AEGIS CAIS Demo — Seeding Data"
echo "  Gateway: $GATEWAY_URL"
echo "════════════════════════════════════════════"
echo ""

# Wait for gateway to be healthy
echo "[deploy] Waiting for gateway..."
for i in $(seq 1 30); do
    if curl -sf "$GATEWAY_URL/health" > /dev/null 2>&1; then
        echo "[deploy] Gateway is healthy!"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "[deploy] ERROR: Gateway not reachable after 30 attempts"
        exit 1
    fi
    sleep 2
done

# Seed rich demo data
echo ""
echo "[deploy] Seeding demo data..."
python3 "$(dirname "$0")/seed_rich.py" --gateway "$GATEWAY_URL"

echo ""
echo "════════════════════════════════════════════"
echo "  Done! Dashboard is ready."
echo ""
echo "  Gateway:  $GATEWAY_URL"
echo "  Cockpit:  (check your Render dashboard)"
echo "════════════════════════════════════════════"
echo ""

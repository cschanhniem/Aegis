#!/usr/bin/env bash
# AEGIS — Quick cockpit screenshot helper.
#
# Walks you through capturing all 7 P0/P1 screenshots that the marketing
# site needs. Resizes Chrome to 1440x900, opens each URL one at a time,
# prompts you to ⌘+Shift+4 (macOS) the content area, then renames the
# capture into apps/marketing/public/screenshots/.
#
# Prereqs:
#   - macOS (uses osascript to resize Chrome)
#   - Cockpit running at http://localhost:13003
#   - Gateway running with seed data (see scripts/seed-demo.mjs)
#   - Google Chrome installed

set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[0;33m'; DIM='\033[2m'; NC='\033[0m'
ok()    { printf "${GREEN}✓ %s${NC}\n" "$*"; }
step()  { printf "\n${GREEN}▸ %s${NC}\n" "$*"; }
dim()   { printf "${DIM}%s${NC}\n" "$*"; }

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$REPO_ROOT/apps/marketing/public/screenshots"
mkdir -p "$OUT"

# (URL, output filename, "what to capture")
SHOTS=(
  "http://localhost:13003/traces|traces-overview.png|Traces tab, mix of allow/pending/block decisions"
  "http://localhost:13003/approvals|approvals-detail.png|Expand a pending row; counterfactual visible + Approve/Block buttons"
  "http://localhost:13003/?tab=anomalies|anomalies-timeline.png|Anomalies tab; time-series chart with at least one spike"
  "http://localhost:13003/policies|policies-dsl.png|Policies list, expand one row into the DSL YAML editor"
  "http://localhost:13003/audit-log|audit-merkle.png|Click into one trace, show the Merkle proof tree"
  "http://localhost:13003/?tab=costs|cost-breakdown.png|Costs tab; 24h chart + per-model breakdown table"
)

step "Resizing Chrome to 1440x900"
osascript <<EOF || true
tell application "Google Chrome"
  activate
  set bounds of front window to {0, 0, 1440, 900}
end tell
EOF
ok "Window sized."

for ENTRY in "${SHOTS[@]}"; do
  URL="${ENTRY%%|*}"
  REST="${ENTRY#*|}"
  FILE="${REST%%|*}"
  HINT="${REST#*|}"

  step "Capture: $FILE"
  dim "URL : $URL"
  dim "Crop: $HINT"
  open -a "Google Chrome" "$URL"

  echo
  echo "  1. Wait for the page to fully render."
  echo "  2. Press ⌘⇧4 then space → click the page CONTENT area"
  echo "     (NOT the browser chrome — the Screenshot.astro wrapper"
  echo "      adds its own chrome later)."
  echo "  3. macOS saves to ~/Desktop/Screenshot ...png"
  echo "  4. When done, press ENTER here — I'll find the newest"
  echo "     screenshot on your desktop and rename it to $FILE"
  read -r

  LATEST="$(ls -t ~/Desktop/Screenshot*.png 2>/dev/null | head -1 || true)"
  if [ -z "$LATEST" ]; then
    echo "  ⚠ No Screenshot found on Desktop — skipping."
    continue
  fi
  mv "$LATEST" "$OUT/$FILE"
  ok "Saved $OUT/$FILE"
done

step "Flipping USE_PLACEHOLDERS = false"
INDEX="$REPO_ROOT/apps/marketing/src/pages/index.astro"
if grep -q "USE_PLACEHOLDERS = true" "$INDEX"; then
  sed -i.bak 's/USE_PLACEHOLDERS = true/USE_PLACEHOLDERS = false/' "$INDEX" && rm "$INDEX.bak"
  ok "Flipped flag in index.astro."
else
  dim "Flag already false; no change."
fi

step "Final"
ls -lh "$OUT"
echo
ok "Done. Build + push:"
echo "  cd apps/marketing && npm run build"
echo "  git add apps/marketing && git commit -m 'feat: real cockpit screenshots'"

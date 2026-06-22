#!/usr/bin/env bash
# AEGIS — Homebrew tap one-time setup.
#
# Run this once. It:
#   1. Creates the Justin0504/homebrew-aegis repo via gh CLI.
#   2. Walks you through generating a fine-grained PAT (manual — GitHub
#      doesn't expose PAT creation via API).
#   3. Stores it as HOMEBREW_TAP_PAT secret on the AEGIS repo.
#
# After this, every `git push --tags` in AEGIS auto-PRs the tap repo.

set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[0;33m'; DIM='\033[2m'; NC='\033[0m'
ok()    { printf "${GREEN}✓ %s${NC}\n" "$*"; }
warn()  { printf "${YELLOW}! %s${NC}\n" "$*"; }
dim()   { printf "${DIM}%s${NC}\n" "$*"; }
step()  { printf "\n${GREEN}▸ %s${NC}\n" "$*"; }

command -v gh >/dev/null 2>&1 || {
  echo "gh CLI required. Install: brew install gh"
  exit 1
}

USER_OR_ORG="${HOMEBREW_TAP_OWNER:-Justin0504}"
TAP="${USER_OR_ORG}/homebrew-aegis"
SOURCE_REPO="${HOMEBREW_SOURCE_REPO:-Justin0504/Aegis}"

step "1. Creating tap repo $TAP"
if gh repo view "$TAP" >/dev/null 2>&1; then
  ok "Tap repo already exists — skipping create."
else
  gh repo create "$TAP" --public \
    --description "Homebrew tap for AEGIS" \
    --add-readme
  ok "Created $TAP."
fi

step "2. Generate a fine-grained PAT"
dim "Open the URL below and create a fine-grained PAT with:"
dim "  - Resource owner:    $USER_OR_ORG"
dim "  - Repository access: Only select repos → homebrew-aegis"
dim "  - Permissions:       Contents (Read & write), Pull requests (Read & write)"
echo
echo "  https://github.com/settings/personal-access-tokens/new"
echo
read -r -p "Paste the PAT here (input hidden): " -s PAT
echo

if [ -z "$PAT" ]; then
  warn "Empty PAT — aborting."
  exit 1
fi

step "3. Storing PAT as HOMEBREW_TAP_PAT secret on $SOURCE_REPO"
echo "$PAT" | gh secret set HOMEBREW_TAP_PAT --repo "$SOURCE_REPO" --body -
ok "Secret stored."

step "4. Test PAT permissions"
if curl -s -H "Authorization: Bearer $PAT" "https://api.github.com/repos/$TAP" \
   | grep -q '"full_name"'; then
  ok "PAT can read the tap repo."
else
  warn "PAT couldn't read the tap repo — double-check scope."
fi

echo
ok "All set. Next \`git push --tags\` triggers the brew formula PR."
dim "Workflow: .github/workflows/release.yml → update-homebrew-tap"

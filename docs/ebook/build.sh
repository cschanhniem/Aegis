#!/usr/bin/env bash
# Compile the 12 AEGIS blog posts into a single PDF e-book.
#
# Order is the reading order we want — start with the introduction,
# move through threats/defenses, then comparisons, then deep dives.
# Each article keeps its own H1 (Pandoc demotes to H2 inside the book).

set -euo pipefail

cd "$(dirname "$0")"
BLOG="../../apps/marketing/src/content/blog"
OUT="aegis-agent-runtime-safety-handbook"

# Reading order — different from filesystem alphabetical
ORDER=(
  "what-is-ai-agent-runtime-safety"            # 1. introduction
  "prompt-injection-langchain"                 # 2. attack surface — direct
  "indirect-prompt-injection-examples"         # 3. attack surface — indirect
  "llm-tool-call-auditing-setup"               # 4. ops setup
  "llm-judge-calibration"                      # 5. judge layer + real ECE
  "cryptographic-audit-logs-merkle-sigstore"   # 6. audit layer
  "ai-agent-safety-fintech-pci-dss"            # 7. fintech vertical
  "stablecoin-agent-security-travel-rule"      # 8. stablecoin vertical
  "hipaa-compliant-ai-agents"                  # 9. healthcare vertical
  "aegis-vs-lakera-guard"                      # 10. comparison
  "self-hosted-vs-saas-agent-guardrails"       # 11. deployment model
  "open-source-ai-safety-tools-field-guide"    # 12. field guide
)

# Strip YAML frontmatter, demote H1 to H2 (so each article reads as a
# chapter under the book's overall H1), and concatenate.
TMP=$(mktemp)
trap "rm -f $TMP" EXIT

# Cover + TOC
cat << 'EOF' > "$TMP"
---
title: "The AEGIS Agent Runtime Safety Handbook"
subtitle: "What we measured, what we built, and what to ship in 2026"
author: "Justin Yuan"
date: "June 2026"
abstract: |
    Twelve essays on intercepting AI agent tool calls before they
    execute. Real measurements (gpt-4o-mini ECE 26.5%, Anthropic
    haiku-4-5 ECE 29.2%), real attack patterns (five indirect
    prompt-injection case studies), real architectures (parameter-
    level taint propagation, RFC 6962 Merkle audit, three-layer
    detection chain). Written for engineers and CISOs shipping
    LLM agents into production in 2026.
toc: true
toc-depth: 2
documentclass: article
papersize: a4
geometry: margin=2.5cm
fontfamily: charter
fontsize: 11pt
linkcolor: "[HTML]{0a4d6e}"
urlcolor:  "[HTML]{0a4d6e}"
header-includes: |
    \usepackage{fancyhdr}
    \pagestyle{fancy}
    \fancyhf{}
    \fancyhead[L]{\small AEGIS Agent Runtime Safety Handbook}
    \fancyhead[R]{\small aegistraces.com}
    \fancyfoot[C]{\thepage}
    \renewcommand{\headrulewidth}{0.4pt}
---

\newpage

# Preface

This book is a snapshot of what we've learnt building AEGIS — an
open-source runtime safety layer for AI agents — through mid-2026. It
exists for three audiences:

- **Engineers** about to ship an agent into production who want a
  concrete checklist of what to defend against and how.
- **CISOs and compliance leads** evaluating which controls map to
  PCI-DSS, SOC 2, HIPAA, and the FATF Travel Rule.
- **Researchers** interested in the gap between published guard-model
  benchmarks (which look great) and real production calibration
  (which doesn't).

The chapters are independent — read them in any order, or read the
introduction (Chapter 1) and skip to whichever vertical or
architecture chapter matters to you. Every claim is sourced; every
code snippet is reproducible from the public AEGIS repo at
[github.com/Justin0504/Aegis](https://github.com/Justin0504/Aegis).

\newpage

EOF

# Append each article — strip frontmatter, demote H1 → H2
for slug in "${ORDER[@]}"; do
  echo "  • including: $slug"
  # 1) cut everything between the first two `---` lines (the YAML
  #    frontmatter)
  # 2) prepend a chapter break
  echo -e "\n\\\\newpage\n" >> "$TMP"
  awk 'BEGIN{f=0} /^---$/{f++; next} f==2{print}' "$BLOG/$slug.md" \
    | sed -E 's/^# /## /' \
    >> "$TMP"
done

echo ""
echo "→ Compiling PDF via pandoc + xelatex / weasyprint…"

# Try xelatex first (best typography); fall back to weasyprint via
# HTML if no LaTeX engine is available.
if command -v xelatex >/dev/null 2>&1; then
  pandoc "$TMP" \
    -o "$OUT.pdf" \
    --pdf-engine=xelatex \
    --toc \
    --toc-depth=2
  echo "✓ Wrote $OUT.pdf (via xelatex)"
elif command -v weasyprint >/dev/null 2>&1; then
  # Pandoc → HTML → weasyprint
  pandoc "$TMP" \
    -o "$OUT.html" \
    --toc --toc-depth=2 \
    --standalone \
    --css=ebook.css
  weasyprint "$OUT.html" "$OUT.pdf"
  echo "✓ Wrote $OUT.pdf (via weasyprint)"
else
  echo "✗ Neither xelatex nor weasyprint found." >&2
  exit 1
fi

# Also drop a standalone HTML version for distribution as a single file
pandoc "$TMP" \
  -o "$OUT.html" \
  --toc --toc-depth=2 \
  --standalone \
  --css=ebook.css \
  --metadata title="The AEGIS Agent Runtime Safety Handbook"
echo "✓ Wrote $OUT.html"

# Print size summary
ls -lh "$OUT".{pdf,html} 2>/dev/null

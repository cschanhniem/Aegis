# Product Screenshots

Real product screenshots — captured from the running cockpit / CLI / scanner.
The marketing site falls back to placeholders until these PNGs exist.

When all P0 files below are present, edit `apps/marketing/src/pages/index.astro`
and flip `USE_PLACEHOLDERS = false`. Do the same on each `/features/*` page
that has a placeholder.

## Capture environment

- Browser window: **1440 × 900** (exactly — use Chrome → Toggle Device Toolbar → Responsive → 1440 × 900)
- DevTools: **closed**
- Theme: cockpit is warm-light only — leave it as is
- Cursor: out of frame
- Sensitive data: replace org name, agent UUIDs, real emails with `acme-corp` / `agent-0001` / `alice@acme.dev` via the cockpit's seed data before capturing
- File format: **PNG**, no compression beyond what macOS / `pngquant --quality 80` produces
- Target file size: under 400 KB per screenshot — run `pngquant --quality=70-90 *.png --ext .png --force` after capturing

## How to start the cockpit with realistic data

```bash
cd /Users/justin/agentguard
# 1. start the gateway
cd packages/gateway-mcp && node dist/server.js &

# 2. seed it
node scripts/seed-demo.js     # populates ~120 traces, 5 policies, 3 anomalies

# 3. start the cockpit
cd ../../apps/compliance-cockpit && npm run build && npm start
# → http://localhost:3000
```

---

## P0 — must capture before launch

| File | What to capture | Notes |
|---|---|---|
| `traces-overview.png` | `/` (Traces tab) with the table populated, mix of allow / pending / block | This is THE money shot — front-page hero replacement |
| `approvals-detail.png` | `/approvals/[id]` — pending row expanded, showing counterfactual + Approve/Block buttons | Used on `/features/policy-generator` |
| `anomalies-timeline.png` | `/anomalies` — time-series chart with at least one spike highlighted | Used on `/features` + homepage |

## P1 — strongly recommended

| File | What to capture |
|---|---|
| `policies-dsl.png` | `/policies` list + one row expanded into the DSL YAML editor |
| `audit-merkle.png` | `/audit/[id]` — single trace with Merkle proof tree shown |
| `cli-scan.png` | iTerm (warm light theme, font Berkeley Mono / JetBrains Mono 14pt) running `agentguard scan ~/some-repo` — capture from `$ agentguard scan ...` through `SUMMARY: ...` |
| `cost-breakdown.png` | `/costs` — 24h line chart + per-model breakdown table |

## P2 — nice to have

| File | What to capture |
|---|---|
| `sessions-timeline.png` | `/sessions/[id]` — a 30-min agent session with full call chain |
| `settings-sso.png` | `/settings/identity` — SAML / OIDC / SCIM config card |
| `predeploy-sarif.png` | GitHub PR view showing SARIF annotations from `agentguard ci-scan` |

---

## Where each screenshot is consumed

```
homepage              → traces-overview.png, anomalies-timeline.png
/features/scanner     → cli-scan.png
/features/policy-gen  → approvals-detail.png, policies-dsl.png
/features/predeploy   → predeploy-sarif.png
/features/customize   → policies-dsl.png
/security             → audit-merkle.png, settings-sso.png
```

## Tip: chrome on top

The `<Screenshot>` component wraps every image in a fake browser chrome
(red/yellow/green dots + URL bar). So **don't capture the actual browser
chrome** — just the page body. Crop to the content area only.

# Visual state — what's done and what's still open

A reference for picking up where this design pass left off. Last
refreshed alongside this commit.

## What's locked in

### Palette
- Pure monochrome. Brand color = black. Only chromatic accents are
  semantic status pills (`--status-ok` / `--status-attn` / `--status-drift`).
- Light: white `#fff` background, near-pure-black text.
- Dark: near-pure-black background, **off-white at 88%** text (not 100%
  — burns at night otherwise).
- Status tokens calibrated for both modes; never use raw `green` / `red`
  hex literals.

### Tokens (globals.css)
- All view-local `const TEXT = 'hsl(0 0% 15%)'`-style constants
  have been replaced with `hsl(var(--foreground))` so they theme-flip.
- All `bg-card` / `bg-secondary` / `bg-popover` map to theme tokens.
- Zero hardcoded `#fff` / `#ffffff` / `hsl(0 0% 9X%)` surfaces remain
  in `components/` — verified with grep.

### Tool icons
- `lib/tool-icons.tsx` renders a colored circular badge per tool.
- Brand-specific overrides for Gmail / Slack / Stripe / GitHub / AWS /
  Postgres / Notion / OpenAI / Anthropic (real Simple Icons paths,
  brand colors).
- Generic categories fall back to a Lucide-on-color badge with
  category-appropriate brand-ish tones.

### Logo
- Pure typographic AEGIS wordmark (Plus Jakarta 800w, tracking 2px).
- No decorative shield / underline / slash.

### Marketing
- Hero uses `<DecisionLog />` (live decision stream visual).
- Logo wall has real brand SVGs (gilbarbara + lobe-icons), not text.
- `/demo` page = 5-step walkthrough (scan → workflow → NL policy →
  vertical packs → live block).
- `/pricing` set to $19 Pro / $99 Team (credit-card-friction tier).

## Still open

### Screenshots
The marketing site has placeholder slots that will swap in real
cockpit screenshots when they exist. Only one is in place
(`apps/marketing/public/screenshots/traces-overview.png`). The flag
`USE_PLACEHOLDERS = false` in `apps/marketing/src/pages/index.astro`
is honored by the `<Screenshot placeholder>` component, so
placeholders render with a diagonal-stripe block until each PNG drops.

Capture list — same as `apps/marketing/public/screenshots/README.md`:

| File | Where | Notes |
|---|---|---|
| `traces-overview.png` | `/` cockpit Traces tab | ✓ Already captured |
| `approvals-detail.png` | `/approvals/[id]` expanded | one pending row + counterfactual + buttons |
| `anomalies-timeline.png` | `/` Anomalies tab | needs Enterprise tier in dev gateway |
| `policies-dsl.png` | `/policies` row expanded | DSL YAML editor visible |
| `audit-merkle.png` | `/audit/[trace_id]` | Merkle proof tree visible |
| `cli-scan.png` | iTerm (not browser) | `agentguard scan ~/repo`, warm light theme |
| `cost-breakdown.png` | `/` Costs tab | 24h chart + per-model table |

Capture rules:
- Chrome window exactly 1440 × 900
- DevTools closed
- Cockpit theme: light
- Sensitive data redacted (use seed data — see
  `packages/gateway-mcp/scripts/seed-demo.mjs`)
- File format PNG, target < 400 KB after `pngquant --quality=70-90`
- Crop to content area only — the `<Screenshot>` component adds
  browser chrome itself

After all P0 screenshots land:

```bash
# In apps/marketing/src/pages/index.astro
- const USE_PLACEHOLDERS = true
+ const USE_PLACEHOLDERS = false
```

Then rebuild + push. The `<Screenshot>` component auto-upgrades each
placeholder to the real image based on file presence.

### Things explicitly NOT in scope yet
- Cockpit logo placement / animation
- Marketing site brand-color accent (still black-only)
- Dark mode photo / illustration assets (the 3 Unsplash photos on
  `/security`, `/docs`, `/features/scanner` are bright; dark mode
  shows them as-is, no dark variants)
- Mobile breakpoint pass on `/demo` (5-section page is responsive but
  not optimized below 480px)

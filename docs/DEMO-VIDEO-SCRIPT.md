# AEGIS demo video — recording script

90-second hero video for `aegistraces.com` homepage. Shows the **scan → workflow
→ NL policy → blocking** end-to-end loop. No talking head, all screen +
captions. Captions are baked in (not subtitles) — autoplays muted on the
homepage hero.

## Pre-recording setup (one-time)

1. **Display**: External 1440×900 monitor or laptop set to that resolution.
2. **Browser**: Chrome, single window, no extensions, **bookmark bar OFF**.
   - Tab 1: `http://localhost:8080/scan` (the scanner UI)
   - Tab 2: `http://localhost:13003` (cockpit)
3. **Terminal**: Warp or iTerm2, dark theme, font size 18, single pane.
4. **Seed**: run `node packages/gateway-mcp/scripts/seed-demo.mjs --days 7`
   so the cockpit looks alive.
5. **Tool**: [Screen Studio](https://screen.studio) (auto-zoom + cursor
   smoothing) — far better than QuickTime/Loom for product demos.

## Shot list (90 seconds)

### Beat 1 — Cold open (0:00 – 0:08)
- **Visual**: Black screen. White serif text fades in:
  > "Your AI agent can call any tool."
  Pause 1.5s. Text replaces:
  > "Are you sure that's a good idea?"
- **Audio**: Light synth swell, single piano note on the second line.
- **Purpose**: Set the problem in 8 seconds.

### Beat 2 — Scan the repo (0:08 – 0:22)
- **Visual**: Terminal full-screen. Type (live, monospace, 18pt):
  ```
  $ aegis scan ./my-agent-repo
  ```
  Press enter. Output streams over ~3s:
  ```
  → Analyzing 24 files…
  → Detected agent framework: LangGraph
  → Found 7 tools: send_email, web_search, http_post, db_query,
                    shell, file_write, stripe_charge
  → Workflow graph: 3 agents (Customer Support, Data Pipeline,
                                Security Triage)
  → Risk: 2 HIGH (shell, stripe_charge), 3 MEDIUM, 2 LOW
  ✓ Scan complete in 1.4s
  ```
- **Caption (bottom)**: "Static scan — no code change, no SDK install."
- **Cut to**: ASCII workflow graph rendered in the terminal (router →
  3 agent nodes → 7 tool nodes). Fade for 2s.

### Beat 3 — Natural-language policy (0:22 – 0:42)
- **Visual**: Cockpit "New policy" modal. Cursor types into the
  description field (real typing, not paste):
  > "Block emails to personal addresses during checkout flow. Allow
  >  ops@acme.io but flag anything to gmail, outlook, or icloud."
- Wait 1s. Click "✨ Generate". 1.5s loading shimmer.
- **Reveal**: Generated DSL appears below the textarea:
  ```yaml
  rule: "block-personal-email-in-checkout"
  when:
    - tool.name == "send_email"
    - context.workflow == "checkout"
  recipient:
    deny: ["@gmail.com", "@outlook.com", "@icloud.com"]
    allow: ["@acme.io"]
  action: BLOCK
  ```
- **Caption**: "Plain English → enforceable policy. No DSL to learn."

### Beat 4 — Watch it block (0:42 – 1:10)
- **Visual**: Cockpit "Activity" view, full-screen. The activity chart
  shows a healthy curve. A new row slides in at the top:
  ```
  [Gmail icon] Emailed alice@gmail.com  [alice avatar]  220ms  [🛡 BLOCKED]
  ```
  The row pulses red softly, then settles.
- Click the row → trace detail panel slides in from the right.
- Detail shows:
  - **What it tried**: `→ alice@gmail.com · "Q3 retro notes"`
  - **Decision**: BLOCKED by `block-personal-email-in-checkout`
  - **Integrity**: ✓ Verified · #0a16
- **Caption**: "Same gateway. Real-time. Cryptographically audited."

### Beat 5 — Vertical packs (1:10 – 1:22)
- **Visual**: Cockpit "Policy packs" page. 4 cards: Payments (PCI-DSS) /
  Healthcare (HIPAA) / Finance (SOX/BSA) / SaaS (GDPR). Hover Healthcare,
  click "Install". 5 policies fan in.
- **Caption**: "Pre-built for the verticals you ship to."

### Beat 6 — Close (1:22 – 1:30)
- **Visual**: Fade to white. Centered:
  > **AEGIS**
  > Runtime safety for AI agents.
  > [aegistraces.com](https://aegistraces.com)
- Tiny line below: "MIT licensed · self-host or hosted free"
- **Audio**: Synth resolves.

## Recording checklist

- [ ] Bookmarks bar off, notifications silenced (`Do Not Disturb` on)
- [ ] Seed DB with `--days 7` so the chart is full
- [ ] Cockpit on the new monochrome dark theme (toggle if not default)
- [ ] Cursor visible + Screen Studio "auto-zoom on click" enabled
- [ ] Mic muted (no ambient noise — music gets added in post)
- [ ] Record at 1440×900, export at 2880×1800 @ 60fps for retina

## Post-production

1. Cut to exact timings above. Drop anything that takes longer than the
   beat budget — viewers bounce at ~12s if nothing changes.
2. Add captions in **Inter Display 600**, 32pt, bottom-center, 4% bottom
   margin, slight black backdrop at 30% opacity.
3. Music: free-license stock with a single resolving chord at 1:22.
   Suggestions: Tom Misch "Quiet" intro, or [Pixabay AI music tag].
4. Export as:
   - `demo.mp4` — H.264, 1080p, 6 Mbps, autoplay-friendly
   - `demo.webm` — VP9 fallback
   - `demo-poster.jpg` — first frame after Beat 1 fade-in
5. Drop into `apps/marketing/public/demo.mp4` etc.

## Homepage embed (after recording)

Edit `apps/marketing/src/pages/index.astro` hero — replace the
`<DecisionLog />` placeholder with:

```astro
<video
  class="hero-video"
  src="/demo.mp4"
  poster="/demo-poster.jpg"
  autoplay muted loop playsinline preload="metadata"
  aria-label="90-second AEGIS product walkthrough"
/>
```

## Fallback — interactive guided tour (no video needed)

If recording slips, ship a `/tour` page that runs the same 5 beats as
timed React states (no video file, no audio). Beat 1 = headline + sub.
Beat 2 = animated terminal output. Beat 3 = typewriter into textarea +
fake API delay + reveal DSL. Beat 4 = mock activity row slide-in. Beat
5 = pack-install animation. Same content, ~50KB instead of 8MB,
shareable as a deep-link. Build this if the video takes more than a day.

## Why this script

- **No talking head**: cuts production cost to zero, also lets
  international visitors follow with captions on mute.
- **8-second cold open**: the homepage video has ~6s before they scroll.
  The problem statement has to land in that window.
- **Each beat = one new idea**: scan, policy gen, blocking, packs. If a
  beat has two ideas, cut one.
- **End on "MIT licensed · self-host or hosted free"**: mirrors the
  pricing page's two-path framing, so the CTA below the video makes
  sense without any context switch.

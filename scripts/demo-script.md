# AEGIS Demo Script — DSL + Hardening Refresh

Recording guide for refreshing `docs/images/readme_demo1.gif` and
`readme_demo2.gif` with the P1.1–P1.5 features (per-tenant config,
Policy DSL, Cockpit editor, hardening).

Audience: GitHub README viewers, recruiters, potential design
partners. Goal is to show **customization** and **fail-safe** in
under 30 seconds.

---

## Pre-recording setup

```bash
# 1. Clean start on a dedicated DB so the demo isn't polluted
PORT=8080 DB_PATH=./demo.db LOG_LEVEL=warn node packages/gateway-mcp/dist/server.js &
cd apps/compliance-cockpit && npm run dev

# 2. Open Cockpit in browser at 1440x900 (or 1280x800 — same aspect as the
#    existing GIFs). Use a clean profile, no extensions, no notifications.

# 3. Resize browser to ~1280x800 with chrome bar visible. Use macOS Cmd+Shift+5
#    → "Record selected portion" to capture only the relevant region.
```

Optimal recording tool:
- macOS: **Kap** (free, exports gif/mp4 with great compression) or built-in
  Screen Recording (Cmd+Shift+5)
- Frame rate: 24–30 fps
- Length: each clip ≤ 25 s, ≤ 8 MB after compression

Compression:
```bash
# After recording demo.mov:
ffmpeg -i demo.mov -vf "fps=24,scale=1280:-1:flags=lanczos" \
  -c:v libx264 -crf 28 -preset slow -pix_fmt yuv420p \
  docs/images/readme_demo1.mp4
```

GitHub doesn't render `<video>` from external sources in the README
unless they're committed to the repo; MP4 in `docs/images/` works.

---

## Demo 1 — "Per-tenant DSL in 20 seconds"

**Goal**: show that a customer can author a rule that tightens behavior
without redeploying, and that a save is hot-reloaded.

| Beat | Action | What's on screen |
|---|---|---|
| 0:00 | Open Cockpit, click **DSL** in sidebar | Editor view, empty state ("No DSL saved") |
| 0:03 | Click **Load example…** → "Pending on high anomaly" | Monaco editor populates with `anomaly.score > 0.7 → pending` |
| 0:08 | Click **Save** | Toast: "DSL saved. Live for new tool calls." Status bar: "Saved DSL: 1 rule(s)" |
| 0:12 | In a terminal split (or second window), curl /check with a benign call → `decision: allow` | Show JSON response |
| 0:16 | Switch to a higher-anomaly call (or mock context in Dry-run panel) | Decision changes to `pending`, the matched rule name is visible |
| 0:22 | Cut |

Optional flourish at 0:18: hover the **Decision merge** cheat-sheet box so
viewers see the strictness order `block > pending > allow`.

---

## Demo 2 — "Fail-safe is real"

**Goal**: show that even a permissive DSL CANNOT override the AJV
block of a SQL-injection. This is the most credible single demo for
enterprise viewers.

| Beat | Action | What's on screen |
|---|---|---|
| 0:00 | DSL editor with a single permissive rule: `{name: yolo, then: {decision: allow}}` | Editor showing the DSL |
| 0:04 | Click Save | Toast: saved |
| 0:08 | Cut to a Playground / curl panel, send: `tool_name: run_sql, arguments: {sql: "DROP TABLE users"}` | `decision: block` — AJV wins |
| 0:14 | Highlight the response JSON: the `dsl` field shows the `yolo` rule matched (decision: allow), but the top-level `decision` is `block`, reason cites the SQL injection policy | Annotate or zoom into the JSON |
| 0:20 | Cut |

End-frame text overlay (1–2 s):
> "DSL only ever tightens. Defaults never move."

---

## README replacement

Once the MP4 clips are in `docs/images/`, replace the two `<img src=…gif>`
tags in `README.md` (lines ~50 and ~58) with the new files. Keep them as
GIFs *or* MP4; GIFs autoplay on GitHub without controls.

```bash
# After recording, compress to GIF if you prefer that over MP4:
ffmpeg -i demo1.mov -vf "fps=18,scale=1080:-1:flags=lanczos" \
  -loop 0 docs/images/readme_demo1.gif
# Target size < 10 MB to keep README fast
```

Update README captions:

```markdown
**A real Claude-powered research assistant, fully integrated with AEGIS,
demoing the new per-tenant Policy DSL.**

**The Cockpit DSL editor: write, save, dry-run — all hot-loaded into the
gateway with no restart.**
```

---

## What needs to happen next (Justin's side)

1. Record both clips per the script (~10 minutes including retakes)
2. Drop the MP4s into `docs/images/`
3. Update README `<img src=…>` tags
4. Commit & push

I can't record the screen myself — the rest is yours.

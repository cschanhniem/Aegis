# Changelog

All notable user-visible changes to AEGIS, by release. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
versioning follows [SemVer](https://semver.org/).

## [Unreleased]

In flight on `main`, slated for the next release.

### Added
- **Audit-chain integrity verification** — three surfaces:
  - CLI: `agentguard integrity verify <agent-id>` (exits 0 on
    intact chain, 1 on break, 2 on gateway error).
  - REST: `GET /api/v1/integrity/verify?agent_id=...`.
  - Cockpit: `/audit-log` page has an inline "Verify chain"
    widget; clicking any `resource_type=agent` row's id auto-fills
    the widget and smooth-scrolls back to it.
  Linkage check only in this release (catches insertion / deletion /
  reorder of trace rows). Per-row content-tamper detection is v0.4 —
  the gateway's PII redaction happens before insert, so re-hashing
  stored rows can't match the SDK's pre-redaction hash. Optional
  Ed25519 signature path covers the residual threat model today.
- **Audit-log attribution + search** — every audit row now records
  the calling API key as `name (prefix)` so SOC 2 reviewers can
  answer "which actor changed this." The `/audit-log` page filters
  by action, resource type, resource id, free-text on the JSON
  details (debounced 350ms server-side LIKE), and date range; CSV
  export ships the visible page.
- **`/alignment` standalone Cockpit page** — interactive composer for
  declared-goal + thought-chain + tool-call, runs through the same
  `/api/v1/alignment/check` endpoint as the SDK callbacks. Three
  starters cover on-task and two flavours of drift. Dashboard's
  prior "Alignment" tab renamed to "Recent Audits" so the
  interactive page and the passive findings panel don't collide.
- **Framework-agnostic alignment helper** — `agentguard.integrations.
  alignment.check(...)` mirrors the existing code_shield helper:
  POSTs to `/api/v1/alignment/check`, validates inputs, buffers
  the verdict for the closed-loop bridge. Pair with the JS-side
  `alignmentCheck()` in `@justinnn/agentguard`. Reach for this
  when you're not on LangChain or CrewAI.
- **JS alignment helper + 15 tests** — `@justinnn/agentguard` now
  exports `alignmentCheck` / `alignmentConsume` and the same
  closed-loop bridge plumbs the verdict into the next `/check`.
  JS SDK suite grew 17 → 32 tests.
- **Demo seed populates Code Scans + (opt-in) Alignment tabs.**
  `python demo/seed.py` now also hits `/code-shield/scan` for each
  agent, so a fresh install's dashboard isn't empty on those two
  tabs. Bootstrap API key automatically if none provided.
  `--include-alignment` opts in to LLM-paid alignment seed.
- **Framework-agnostic example** at
  `packages/sdk-python/examples/custom_agent_alignment.py` —
  hand-rolled 3-step ReAct loop that exercises both helpers on
  drift / clean / code-gen patterns.
- **`agentguard code-shield`** CLI subcommand — `scan FILE...`
  posts each file to the gateway and prints severity-coloured
  findings; respects `--language`, `--disable RULE_IDS`, and
  `--fail-on LOW|MEDIUM|HIGH|CRITICAL` for pre-commit hooks and
  CI. `agentguard code-shield rules` lists the catalog offline.
- **`agentguard doctor`** — five-step health probe (gateway up,
  API key authenticates, policies loaded, code-shield reachable,
  alignment endpoint reachable). Exit 2 distinguishes
  "unreachable" from "reachable but unhealthy" (exit 1).

### Changed
- `agentguard status` exits **2** (not 1) when the gateway is
  unreachable, matching `agentguard doctor`'s convention. Exit 1
  is now reserved for "command ran, server returned a problem we
  want a script to handle." Scripts that branched on exit code
  may need to update.
- `agentguard configure` gains `--api-key` and `--bootstrap`
  flags; the shared HTTP helper now picks up `AEGIS_API_KEY` /
  `AEGIS_GATEWAY_URL` from env (with `AGENTGUARD_*` kept as
  legacy aliases) or the `api_key` field in
  `~/.agentguard/cli.json`.
- **DSL builtin examples** — two new starter docs returned by
  `GET /api/v1/dsl/examples`: `block-unsafe-code-gen` (blocks on
  `code_shield.worst == CRITICAL`) and `pause-on-alignment-drift`
  (pending when `alignment.drifted` or `alignment.score < 0.5`).
- **Cockpit dark mode** — full dark palette behind an explicit
  `.dark` class and `prefers-color-scheme: dark`; three-state
  Light / System / Dark switch in the sidebar footer; no-flash
  inline bootstrap so the right theme is applied before first
  paint.
- **CodeShield** — fast, local-only static scanner for code that
  an agent is about to commit or execute. 19 curated regex rules
  across Python, JavaScript, shell, SQL, and cross-language secret
  formats. Sub-millisecond scans, no LLM round-trip. Exposed at
  `POST /api/v1/code-shield/scan` (with `GET /recent` for the
  Cockpit panel), and the worst severity flows into the Policy
  DSL via `code_shield.*`.
- **Closed-loop alignment** — the LangChain `AlignmentCallback`
  now drops each verdict into an in-process buffer keyed by
  `agent_id`. The SDK's auto-instrumentation interceptor reads
  from the buffer when it next calls `/check` for the same agent
  and splices the verdict in under `alignment`. Policy DSL rules
  like `alignment.score < 0.5` now fire on the same hop as the
  tool call, with no extra wiring in user code. Verdicts expire
  after 30 s and are consumed once.
- **Tray deep-link** — clicking the AEGIS tray icon when at least
  one unprotected agent is detected now lands on
  `/welcome?pid=<top>` and the matching card auto-expands +
  scrolls into view with a 2 s highlight ring.
- Public roadmap at `ROADMAP.md`; nav bar in the README links to
  Download / Roadmap / Security / Contributing.
- CI build jobs for **macOS Intel (x64)**, **Linux x64**, and
  **Linux arm64** in `.github/workflows/release.yml`. Each gets a
  separate artifact uploaded to the GitHub Release on tag push.
- `prepare-sidecars.mjs` — cross-platform replacement for the old
  bash script. Handles Windows `.zip` Node tarballs, Mac/Linux
  `.tar.gz` tarballs, and the `npm install --install-links` dance
  that turns the gateway's workspace dep into a real copy.
- `install.sh` now nudges macOS users toward the native .dmg before
  walking them through the Docker path. `AEGIS_FORCE_DOCKER=1`
  skips the nudge.
- `docs/AUTO-UPDATE.md` documents the 4-step `tauri-plugin-updater`
  setup (key generation, pubkey in config, private key as CI
  secret, signed `latest.json` manifest).

### Changed
- Cockpit dashboard overview now shows a friendly empty state
  (pulsing "Listening" indicator + CTA into `/welcome`) when no
  traces have come through. Previously: a wall of empty cards
  reading "No data yet".
- Tray icon swaps to a warning variant (translucent shield + red
  dot) when `> 0` unprotected agents are detected; clears back to
  the normal icon when the count drops to zero.

---

## [0.1.0] — 2026-05-20

First downloadable build. Double-click to install, no Docker, no
`npm install`, no shell paste.

### Added
- **Self-contained desktop app** (Tauri shell) at
  `apps/desktop/`. Bundles the gateway, the Cockpit (Next.js
  standalone), and a portable Node runtime into a 164 MB DMG.
  Sidecars bind to `127.0.0.1:18080` (gateway) and `127.0.0.1:13001`
  (Cockpit) so they don't collide with a parallel `docker compose`
  install.
- **Welcome onboarding** at `/welcome` in the Cockpit. Detects
  running Python/Node agent processes that haven't been routed
  through AEGIS yet; shows a tailored SDK-init snippet per process
  with the PID pre-filled as the agent ID; auto-redirects to the
  dashboard the moment a trace arrives.
- **Live tray badge** showing the unprotected-agent count, refreshed
  every 30 s. Clicking the tray icon shows the main window and
  jumps to `/welcome` directly.
- **Live Cockpit status bar** above every dashboard route:
  Protected ● · 142 traces · 9 agents (24h) · 3 blocked (24h) ·
  1 pending. Polls `/stats` every 10 s.
- **Per-tenant Policy DSL** at `packages/gateway-mcp/src/policies/dsl/`.
  YAML-or-JSON ruleset with safe AST evaluator (no `eval`,
  pre-compiled regex), `all`/`any`/`not` combinators, dotted-path
  field access (e.g. `tool.args.url`), `==`/`!=`/`<`/`>`/`in`/
  `matches` operators. 100-rule cap, hot-reload on tenant config
  change. **Fail-safe**: a DSL rule can only tighten a decision,
  never relax an AJV or anomaly block.
- **Cockpit DSL editor** at `/dsl`. Monaco editor + 5 ready-made
  examples + a dry-run panel that evaluates the draft against a
  sample context without persisting.
- **5 deployment templates**: dev (L1 only, 7 d retention), standard
  (L1+L2, 90 d), strict (180 d), financial (7-year SOX retention,
  mandatory PII masking), healthcare (6-year HIPAA retention).
- **Cost-aware L1 → L2 → L3 cascade** (gateway):
  pattern rules → XGBoost classifier over 15 structural features
  → LLM judge. 99.9 % block rate at 1.1 ms median, $0.05/run on a
  5,525-call benchmark.
- **14 framework SDK integrations**: Python — Anthropic, OpenAI,
  LangChain, CrewAI, Gemini, Bedrock, Mistral, LlamaIndex,
  smolagents; JS/TS — Anthropic, OpenAI, Vercel AI SDK, Mastra;
  Go — official SDK. All auto-instrument on import via
  `agentguard.auto(...)`.
- **Tamper-evident audit trail**: SHA-256 hash chain across traces
  plus optional Ed25519 signatures.
- **One-command install script** at `scripts/install.sh`
  (`curl ... | bash` style) for users who prefer the Docker path.
- **Beige + black UI palette** across homepage, Cockpit, and the
  desktop shell. Instrument Serif headings + Inter body — Tiempos
  / Söhne-shaped, no Anthropic licensed fonts required.
- **Personal homepage** at `apps/homepage/` (Astro static).
  Hero + AEGIS feature card + Writing + Now. Dedicated `/download`
  page with platform-detection JS.
- **CI release pipeline** at `.github/workflows/release.yml`.
  Tag-triggered. PyPI + npm + GHCR + GitHub Release in one shot;
  desktop builds added in later commits.
- **SECURITY.md** with reporting flow, SLAs by severity, in-scope /
  out-of-scope list, and a "hardening already in place" recap for
  vendor security reviews.

### Architectural notes
- The DSL document lives inside `organizations.settings` (existing
  JSON column) rather than a new `tenant_config` table — keeps the
  schema small and reuses the existing `ConfigBus` event for
  hot-reload.
- The standalone Cockpit bundle ships as a Node sidecar rather than
  a `next export` static site, so the existing API routes
  (gateway proxy, SSE stream, replay, AI policy generator) keep
  working unchanged inside the desktop app.
- Custom `scripts/make-dmg.sh` packages the .app via `hdiutil`
  alone, dodging Tauri's bundled `bundle_dmg.sh` which calls
  AppleScript and needs `Automation → Finder` granted on the
  build machine.

### Known limits
- **Unsigned binary.** Gatekeeper warns on first open; right-click
  AEGIS → Open → Open. Apple Developer signing arrives in 0.2.
- **macOS Apple Silicon only on the downloadable .dmg.** Intel,
  Windows, and Linux builds are scaffolded in CI but the first
  green run lands with v0.2.
- **No auto-update.** Wired up via `docs/AUTO-UPDATE.md` once the
  signing key is generated.
- **Cockpit has no dark mode yet** — the homepage does. Tracked in
  ROADMAP for v0.3.

[Unreleased]: https://github.com/Justin0504/Aegis/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Justin0504/Aegis/releases/tag/v0.1.0

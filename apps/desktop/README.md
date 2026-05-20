# AEGIS Desktop

A Tauri shell that ships the Cockpit + gateway as a single signed
desktop app. The goal is a "download .dmg, double-click, protected"
experience — like the security utilities of the Web 2.0 era, but for
AI agents instead of browser plug-ins.

## Status

| Phase | What | State |
|-------|------|-------|
| A.1   | Tauri scaffold + WebView + system tray | ✅ shipped |
| A.2.1 | Cockpit `output: 'standalone'` build | ✅ shipped |
| A.2.2 | `scripts/prepare-sidecars.sh` stages gateway + cockpit + portable Node | ✅ shipped |
| A.2.3 | Rust spawn logic in `src/sidecars.rs` — release builds spin up both Node servers, kill on exit | ✅ shipped (cargo check clean) |
| A.2.4 | Actually produce a signed `.dmg` via `cargo tauri build` end-to-end | not started — needs prepare-sidecars to run + bundle.resources uncommented + Apple Developer signing |
| B     | First-run flow + agent discovery (process scanner) | not started |
| C     | Auto-update + code signing (Apple Developer, Win cert) | not started |

## Develop

```bash
# Requirements (one-time)
#   - Rust toolchain (rustup): https://rustup.rs
#   - Tauri CLI: cargo install tauri-cli --version "^2.0" --locked
#   - The Cockpit running locally on http://localhost:3000

# Start Cockpit in another terminal
cd ../compliance-cockpit && npm run dev

# Start the desktop shell
npm run dev
```

The dev shell loads `http://localhost:3000` inside the Tauri WebView,
so changes to the Cockpit hot-reload as usual.

## Build a distributable

```bash
# Generate icons from the homepage favicon (one-time)
npm run icons

# Build release bundle (.dmg on macOS, .msi on Windows, .AppImage on Linux)
npm run build
```

Outputs land in `src-tauri/target/release/bundle/`.

## Building a release bundle

```bash
# Just the .app (faster, what you usually want for iterative testing)
cd apps/desktop && cargo tauri build --bundles app
#  → src-tauri/target/release/bundle/macos/AEGIS.app          (~388 MB)

# .dmg packager (pure hdiutil — no AppleScript / no Finder automation prompt)
cd apps/desktop && bash scripts/make-dmg.sh
#  → src-tauri/target/release/bundle/dmg/AEGIS_<version>_<arch>.dmg  (~171 MB)
```

### Why a custom make-dmg.sh?

Tauri's built-in `bundle_dmg.sh` calls `osascript` to set the Finder
window layout (drag-to-Applications icon positions, background image,
etc.). That AppleEvents call needs `System Settings → Privacy &
Security → Automation → Terminal → Finder` to be granted on the
build machine, which CI / non-interactive shells don't have. Our
`make-dmg.sh` skips the prettification entirely and uses raw
`hdiutil` — the resulting DMG mounts, contains AEGIS.app and an
`/Applications` symlink, and drag-installs as users expect. Less
pretty, more reliable.

## What still needs to happen

1. **Bundle resources auto-wiring** — automate uncomment-then-build so
   step 2 above isn't a manual edit. Probably a thin wrapper script that
   templates `tauri.conf.json` from a JSONC source.
2. **Bundled SDKs** — installer should drop pip wheels and an
   "Install in venv" affordance.
3. **Agent process scanner** — detect running Python/Node processes
   with agent libs loaded and offer one-click instrumentation
   (Phase B).
4. **Code signing** — Apple Developer account + notarization for
   `.dmg`; Authenticode cert for `.exe`. Both are paid yearly.

## How spawn works (Phase A.2.3 contract)

Release builds gate sidecar spawn behind `#[cfg(not(debug_assertions))]`.
On startup `Sidecars::spawn_all`:

1. Resolves `app.path().resource_dir()` and `app.path().app_data_dir()`.
2. Spawns `node node-runtime/bin/node gateway-bin/server.js` with
   `PORT=18080`, `HOST=127.0.0.1`, `DB_PATH=<app-data>/aegis.db`.
3. Polls TCP 18080 for up to 20 s.
4. Spawns the Cockpit sidecar at `PORT=13001`,
   `GATEWAY_URL=http://127.0.0.1:18080`.
5. Polls TCP 13001 for up to 20 s.
6. `lib.rs` then `window.location.replace('http://127.0.0.1:13001')`
   and reveals the window.

`Sidecars` is stored in Tauri's managed state. On `CloseRequested`
and again on `Drop`, every spawned child receives `SIGTERM`. Picked
non-standard ports (18080 / 13001) so a parallel
`docker compose up` keeps working alongside the desktop app.

## Why Tauri (and not Electron)

- 5–15 MB binary vs Electron's 100+ MB.
- No bundled Chromium → no Chromium CVE surface in a security
  product. (This matters when you're shipping the firewall.)
- WebView is the platform's, not bundled. Fast, native feel.
- Rust as the supervisor process gives us a credible story for
  process-level integrations (Endpoint Security, network
  extensions) later if/when entitlements allow.

Trade-offs we accepted:

- Slightly less ecosystem (no `electron-builder` polish, fewer
  prebuilt updaters).
- Rust learning curve for any deep system integration.

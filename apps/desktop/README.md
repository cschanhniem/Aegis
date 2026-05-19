# AEGIS Desktop

A Tauri shell that ships the Cockpit + gateway as a single signed
desktop app. The goal is a "download .dmg, double-click, protected"
experience — like the security utilities of the Web 2.0 era, but for
AI agents instead of browser plug-ins.

## Status

| Phase | What | State |
|-------|------|-------|
| A.1   | Tauri scaffold + WebView pointed at Cockpit, system tray | **scaffold landed**, not yet built |
| A.2   | Bundle the gateway as a sidecar binary (pkg/nexe + better-sqlite3) | not started |
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

## What still needs to happen

1. **Sidecar gateway binary** — the current shell points at
   `http://localhost:8080` and assumes the user has the gateway
   running separately (via `docker compose` or `npm run dev`).
   Phase A.2 will bundle a self-contained gateway binary and spawn
   it on app start.
2. **Bundled SDKs** — installer should drop pip wheels and an
   "Install in venv" affordance.
3. **Agent process scanner** — detect running Python/Node processes
   with agent libs loaded and offer one-click instrumentation.
4. **Code signing** — Apple Developer account + notarization for
   `.dmg`; Authenticode cert for `.exe`. Both are paid yearly.

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

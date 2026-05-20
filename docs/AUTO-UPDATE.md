# AEGIS desktop auto-update setup

The desktop app does not yet check for updates on launch. Wiring it up
is a four-step process — the only blocker is generating a signing key,
which is one command but creates a file that must NEVER land in git.

## Why signed updates?

Tauri's updater requires cryptographic signatures on every artifact. An
attacker who hijacks a GitHub release (or a CDN edge) can't ship a
malicious .dmg that the running app accepts, because that .dmg won't be
signed with our private key. The public key is baked into the binary.

This is *separate* from Apple Developer code signing — the latter is
about Gatekeeper letting the .dmg open at all; this one is about the
running AEGIS app trusting an update payload.

## Step 1 — Generate the signing key

Run **once, on your machine**, never in CI:

```bash
cd apps/desktop
cargo tauri signer generate -w ~/.ssh/aegis-updater.key
```

This writes:

- `~/.ssh/aegis-updater.key` — **private key**. Keep it offline,
  back it up to 1Password or similar. If you lose it, you can't
  ship new updates to existing installs; users have to re-download
  manually.
- The terminal prints the **public key** as a single base64 line.
  Copy this.

## Step 2 — Wire the public key into the app

Edit `apps/desktop/src-tauri/tauri.conf.json` and add an `updater`
block under `plugins`:

```json
"plugins": {
  "shell": { "open": true },
  "updater": {
    "endpoints": [
      "https://github.com/Justin0504/Aegis/releases/latest/download/latest.json"
    ],
    "pubkey": "PASTE_PUBLIC_KEY_HERE"
  }
}
```

Then add the plugin to `apps/desktop/src-tauri/Cargo.toml`:

```toml
[dependencies]
tauri-plugin-updater = "2"
```

And in `apps/desktop/src-tauri/src/lib.rs` register it inside the
builder:

```rust
.plugin(tauri_plugin_updater::Builder::new().build())
```

Optionally, in `setup()`, kick off a background check:

```rust
let handle = app.handle().clone();
tauri::async_runtime::spawn(async move {
    if let Ok(update) = handle.updater().unwrap().check().await {
        if let Some(update) = update {
            // Either prompt the user via a window event, or just
            // download + install on next launch.
            let _ = update.download_and_install(|_, _| {}, || {}).await;
        }
    }
});
```

## Step 3 — Add the private key to CI as a secret

GitHub → repo → Settings → Secrets and variables → Actions →
**New repository secret**:

| Name | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | contents of `~/.ssh/aegis-updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | (empty unless you set a password during generate) |

Then update `.github/workflows/release.yml`'s desktop jobs to
expose them as env vars during `cargo tauri build`:

```yaml
env:
  TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
```

`cargo tauri build` notices the env vars and signs every artifact +
emits a `latest.json` manifest alongside the .dmg / .msi / .AppImage.

## Step 4 — Ship a release and watch it propagate

```bash
git tag v0.2.0
git push origin v0.2.0
```

CI runs, uploads:

- `AEGIS_0.2.0_aarch64.dmg`
- `AEGIS_0.2.0_aarch64.dmg.sig`
- `latest.json` (Tauri-generated, contains the signed download URL)

Already-installed v0.1.0 apps query `latest.json`, verify the
signature against the embedded public key, download + replace
themselves on next launch (or after the user clicks the "Update
available" toast you wire in).

## What about Apple Developer signing?

Independent track. Once that lands, the `.dmg` is *also* notarized
by Apple, and Gatekeeper opens it without the right-click workaround.
Tauri's updater signature is still required on top — they're not
substitutes.

## Risks to know

- **Lose the private key → game over for that release line.** You
  ship a v0.2 with key A, lose key A, and now there's no way to
  push a v0.3 the v0.2 installs will accept. Users have to manually
  uninstall and re-download. Back the key up immediately after
  generating.
- **Rotating the key requires a forced re-download.** If you ever
  decide to rotate, document it loudly — every existing install
  needs to be replaced manually because the new key isn't trusted
  yet.
- **`continue-on-error` Windows job + signing**: the Windows job in
  `release.yml` is currently allowed to fail. Don't enable updater
  signing on a job that can fail silently — you'll ship updates the
  Windows installs can't verify.

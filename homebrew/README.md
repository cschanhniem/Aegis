# AEGIS Homebrew Formula

This directory holds the canonical `aegis.rb` Homebrew formula. The
actual `brew tap` lives in a sibling repo,
[`Justin0504/homebrew-aegis`](https://github.com/Justin0504/homebrew-aegis)
(create when ready to ship), with this file copied to `Formula/aegis.rb`.

## End-user install

```bash
brew tap Justin0504/aegis
brew install aegis
```

What you get:

| Binary | What it does |
|---|---|
| `agentguard` | Main CLI — scan, inject, status, traces, costs, kill-switch |
| `aegis-mcp-proxy` | MCP server proxy for Claude Desktop |
| `aegis-http-proxy` | HTTP proxy for OpenAI-compatible SDKs |

## First-time tap setup (one-time)

The release workflow automates everything *after* this. Do it once:

1. **Create the tap repo.** It must be named `homebrew-aegis` and
   live under the same user/org that owns AEGIS:

   ```bash
   gh repo create Justin0504/homebrew-aegis \
     --public \
     --description "Homebrew tap for AEGIS" \
     --add-readme
   ```

2. **Add a release-bot PAT to AEGIS repo secrets.** Generate a
   fine-grained PAT scoped only to `Justin0504/homebrew-aegis` with
   `Contents: write` + `Pull requests: write`:

   ```
   GitHub → Settings → Developer settings → Personal access tokens
       → Fine-grained tokens → Generate new token
   ```

   Then on the AEGIS repo: Settings → Secrets and variables → Actions →
   `New repository secret`:

   ```
   Name:   HOMEBREW_TAP_PAT
   Value:  <the PAT>
   ```

3. **Push your first formula.** Tag a release in AEGIS; the
   `build-cli-tarball` + `update-homebrew-tap` workflow jobs run
   automatically and PR the formula into the tap repo.

## Releasing a new version (automated)

```bash
# In the AEGIS repo:
git tag v1.1.0
git push --tags
```

That triggers:

1. **`build-cli-tarball`** in `.github/workflows/release.yml`
   builds `packages/cli/dist`, tars it as
   `agentguard-cli-1.1.0.tar.gz`, computes SHA-256, and attaches it
   to the GitHub release.
2. **`update-homebrew-tap`** copies `homebrew/aegis.rb` to
   `Formula/aegis.rb` in the tap repo, injects the new version + SHA,
   opens a PR.
3. Merge the PR → `brew install aegis` picks up the new version
   on next `brew update`.

## Testing the formula locally

```bash
brew install --build-from-source ./aegis.rb
brew test aegis
brew audit --strict aegis
```

## Why a separate tap repo

Homebrew taps are git repos shaped a specific way: `Formula/<name>.rb`
at the root, no other source. Keeping the formula here in the main
AEGIS repo and copying it to the tap on release means:

- One source of truth for the formula
- PRs can update the formula + CLI source together
- The tap repo stays clean (Homebrew CI hates extra files)

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

## Releasing a new version

1. Tag + release in this repo (e.g. `v1.1.0`).
2. The release CI emits `agentguard-cli-1.1.0.tar.gz` containing
   `dist/`, `package.json`, and `package-lock.json` for `npm install --production`.
3. CI computes the SHA-256 and opens a PR against `homebrew-aegis`
   updating `version` + `sha256` in `Formula/aegis.rb`.
4. Merge that PR — `brew install aegis` immediately picks up the new
   version.

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

# AEGIS Pre-Deployment Scan — GitHub Action

Run AEGIS's static-analysis pre-deployment scan on every PR. Wraps
[HeadyZhang/agent-audit](https://github.com/HeadyZhang/agent-audit) (53
OWASP-Agentic-Top-10-mapped rules, AST + taint, MIT) with:

- **GitHub Code Scanning** — SARIF v2.1.0 upload so findings appear on
  the Security tab and inline in the diff view.
- **PR comment** — auto-posted / updated finding summary, top-30 rows.
- **Fail-on gate** — fail the job on critical / high / medium / low,
  configurable.
- **Job summary** — rendered on the workflow-run page.

## Quick start

`.github/workflows/aegis-predeploy.yml`:

```yaml
name: AEGIS Pre-Deployment Scan
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents:        read
  pull-requests:   write     # for PR comments
  security-events: write     # for SARIF upload to Code Scanning
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: AEGIS scan
        uses: Justin0504/Aegis/tools/github-action@main
        with:
          fail-on: critical          # critical | high | medium | low | never
          agent-audit-version: 0.18.2
```

## Inputs

| name | default | description |
|------|---------|-------------|
| `path` | `$GITHUB_WORKSPACE` | Repo path to scan |
| `agent-audit-version` | `0.18.2` | Pinned scanner version |
| `fail-on` | `critical` | Severity threshold — `critical / high / medium / low / never` |
| `upload-sarif` | `true` | Upload SARIF to Code Scanning |
| `comment-pr` | `true` | Post / update PR comment |
| `output-path` | `aegis-scan.sarif` | SARIF output location |

## Outputs

| name | description |
|------|-------------|
| `total` | Total findings |
| `critical` | Critical-severity findings |
| `high` | High-severity findings |
| `block` | BLOCK-tier findings (critical + high) |
| `sarif-path` | Path to the SARIF file (for further upload) |

## How it composes with the rest of AEGIS

| Layer | Where it lives | What it catches |
|-------|----------------|-----------------|
| **Pre-deployment scan** (this action) | CI | Static AST findings — prompt injection, hardcoded secrets, MCP shadowing, etc. |
| AEGIS gateway | Runtime | Per-call policy enforcement (AJV + DSL) |
| AEGIS Layer 2 | Runtime | Anomaly detection (IF + HST + Mahalanobis + Conformal + ADWIN + AAD) |
| AEGIS rollback | Post-execution | Saga-style compensating actions + delayed-effect outbox |

Every layer writes signed Merkle audit leaves so a customer can verify
the full lifecycle of a request offline.

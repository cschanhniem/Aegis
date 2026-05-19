# Security Policy

AEGIS is a security product. We take vulnerability reports seriously and
will work with researchers, customers, and downstream operators to
remediate issues quickly.

## Supported versions

Security fixes land on the `main` branch and the latest tagged release.
Older releases are not back-ported except for critical issues affecting
customers under a support agreement.

| Version  | Supported          |
|----------|--------------------|
| `main`   | ✅ active           |
| latest tag | ✅ critical fixes |
| < latest | ❌ no fixes         |

## Reporting a vulnerability

**Please do not file a public GitHub issue** for security reports.

Email **`aojieyua@usc.edu`** with:

- A clear description of the issue and the affected component
  (`gateway-mcp`, `sdk-python`, `sdk-js`, `compliance-cockpit`,
  `cli`, infra)
- Minimum reproducer (config, repo, commit hash, request payload)
- Impact assessment — what an attacker could achieve
- Your name / handle for credit (optional)

Encrypted reports welcome — request a PGP key in the first message
and we'll exchange one out of band.

## Response timeline

| Stage                     | Target |
|---------------------------|--------|
| Initial response (ack)    | 2 business days |
| Triage + severity rating  | 5 business days |
| Fix in a private branch   | depends on severity (see below) |
| Coordinated disclosure    | 90 days from initial report by default |

**Severity targets for the private fix:**

- Critical (RCE, auth bypass, full audit-trail forgery): 7 days
- High (privilege escalation, data exfil, policy bypass): 30 days
- Medium (information disclosure, DoS, partial bypass): 60 days
- Low (hardening): next regular release

We coordinate the public release of the advisory with the reporter.
If you need a different disclosure window (regulatory deadline,
upstream coordination) tell us up front and we'll work to it.

## Scope

In scope for this policy:

- **Gateway** (`packages/gateway-mcp`) — REST endpoints under
  `/api/v1/*`, the policy engine, AJV compilation, the Policy DSL
  evaluator, the MCP proxy, auth middleware, RBAC, audit log.
- **SDKs** (`packages/sdk-python`, `packages/sdk-js`,
  `packages/sdk-go`) — auto-instrumentation hooks, request signing,
  payload handling.
- **CLI** (`packages/cli`) — credential storage, command execution
  paths.
- **Compliance Cockpit** (`apps/compliance-cockpit`) — Next.js app,
  the gateway proxy route under `/api/gateway/[...path]`, auth
  cookie / API-key handling.
- **Docker images** under `ghcr.io/justin0504/aegis-*`.
- **Default policies** shipped in `db/database.ts` — incorrect or
  bypassable patterns count.

Out of scope:

- Third-party services (Anthropic / OpenAI / etc.) — report to
  the vendor.
- Issues that require physical access to the operator's machine.
- Social-engineering attacks against AEGIS maintainers.
- Vulnerabilities in `research/` (academic benchmark code, not
  the production gateway).

## Hall of fame

Reporters who follow this policy and submit a valid vulnerability
will be credited in:

1. The CHANGELOG entry for the release containing the fix.
2. An optional listing here, with name and handle of your choice.

(Empty for now — be the first.)

## Hardening already in place

For completeness, the gateway ships with the following defensive
posture out of the box (current `main`):

- Strict CSP, X-Frame-Options, Referrer-Policy, Permissions-Policy
  headers
- HSTS with `max-age=31536000; includeSubDomains`
- Per-tenant rate limit (composite `${orgId}:${agent_id|ip}` key)
- 2&nbsp;MB JSON body cap (configurable via `JSON_BODY_LIMIT`)
- Zod validation on all `/api/v1/*` write paths
- API-key auth (`aegis_…`) with hashed storage, per-key scopes,
  revocation timestamps, expiration
- RBAC roles: `owner`, `admin`, `auditor`, `viewer`
- Tamper-evident audit trail: SHA-256 hash chain over traces,
  optional Ed25519 signing
- Webhook payload signing: HMAC-SHA256 in `X-AEGIS-Signature`
- Kill-switch for run-time agent revocation
- Production error middleware redacts stack traces; logs include
  correlation IDs

We are working toward SOC 2 Type II readiness. Contact us if you
need vendor security questionnaire support.

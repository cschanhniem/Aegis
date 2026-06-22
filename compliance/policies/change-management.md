# Change Management Policy

**Document owner:** Head of Engineering
**Version:** 1.0
**Effective date:** 2026-06-03

## 1. Scope

All changes to AEGIS production code, configuration, infrastructure, or
data schemas. This includes feature work, bug fixes, dependency
upgrades, and emergency patches.

## 2. Change Classes

| Class | Examples | Approval |
|---|---|---|
| Standard | Bug fix, feature increment, dep upgrade | 1 reviewer + green CI |
| Significant | Schema migration, auth flow change, new external dep | 1 reviewer + security signoff |
| Emergency | Security patch, customer-facing outage fix | Post-hoc CISO review within 24h |

## 3. Workflow

1. Author opens PR against `main`. PR description states class +
   rationale. Significant + emergency PRs use a labelled template that
   captures rollback plan + monitoring.
2. CI runs the gateway, SDK, scanner, and cockpit test suites
   (currently 800+ tests across 73 suites). All must pass.
3. At least one reviewer (not the author) approves.
4. Branch protection (configured on the `main` branch of the
   `Justin0504/Aegis` repo) prevents merge without these checks.
5. Merge triggers automated release pipeline (when configured).

## 4. Database Migrations

Schema migrations live in `packages/gateway-mcp/src/db/database.ts`
inside the `migrations` array. Each migration is idempotent and
forward-only (additive columns + indices). Destructive migrations
require a separate PR + explicit `DESTRUCTIVE: true` line in the title.

## 5. Dependency Management

- `npm audit` is run on every PR; HIGH or CRITICAL vulnerabilities
  block merge unless an exception is filed.
- Dependabot / Renovate is configured to open weekly PRs for
  non-breaking updates.
- New runtime dependencies require security-team review and a SBOM
  entry.

## 6. Configuration Changes

Tenant-level configuration changes flow through TenantConfigService and
emit `tenant.config.updated` events recorded in the audit log. Operator
override (`platform_config` table) requires admin role and is recorded
with actor + timestamp.

## 7. Rollback

- Every production deploy preserves the prior artifact for at least 7
  days. Rollback procedure: `runbooks/backup-restore.md` §3.
- The Saga + Snapshot-based rollback system handles in-flight
  tool-action reversal for agent operations (see
  `services/snapshot-capture.ts`, `services/saga.ts`).

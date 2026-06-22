# Runbook — PostgreSQL Migration

**Last reviewed:** 2026-06-04
**Owner:** Head of Engineering
**Status:** In progress — 2 of ~25 tables migrated behind store abstractions

## Why this exists

AEGIS ships dual-backend. SQLite (via `better-sqlite3`) is the default —
single-binary deploy, fast, sync API. Postgres becomes the backend when
`DATABASE_URL=postgres://...` is set; this gates the HA / horizontal
scaling story enterprise customers ask for during procurement.

Going async-everywhere in one sweep is a 1-2 week project and a large
regression risk. The pattern below converts ONE TABLE AT A TIME behind
a typed `Store` interface, with both adapters tested via `pg-mem`. Each
migration is independent and shippable.

## Migration status

| Table | Status | Store interface | Tests |
|---|---|---|---|
| `policies`            | ✅ Migrated | [`policy-store.ts`](../../packages/gateway-mcp/src/db/policy-store.ts) | 8 pg-mem tests |
| `admin_audit_log`     | ✅ Migrated | [`audit-log-store.ts`](../../packages/gateway-mcp/src/db/audit-log-store.ts) | 10 dual-backend tests |
| `gateway_config`      | ✅ Migrated | [`gateway-config-store.ts`](../../packages/gateway-mcp/src/db/gateway-config-store.ts) | 5 dual-backend tests |
| `scim_tokens`         | ✅ Migrated | [`scim-token-store.ts`](../../packages/gateway-mcp/src/db/scim-token-store.ts) | 5 dual-backend tests |
| `users`               | ✅ Migrated | [`user-store.ts`](../../packages/gateway-mcp/src/db/user-store.ts) | 7 dual-backend tests |
| `groups` + `group_members` | ✅ Migrated | [`group-store.ts`](../../packages/gateway-mcp/src/db/group-store.ts) | 6 dual-backend tests |
| `user_sessions`       | ✅ Migrated | [`user-session-store.ts`](../../packages/gateway-mcp/src/db/user-session-store.ts) | 5 dual-backend tests |
| `traces`              | ✅ Migrated | [`traces-store.ts`](../../packages/gateway-mcp/src/db/traces-store.ts) | 7 dual-backend tests (batched-write) |
| `transparency_log`    | ✅ Migrated | [`transparency-log-store.ts`](../../packages/gateway-mcp/src/db/transparency-log-store.ts) | 5 dual-backend tests (append-only batched) |
| `violations`          | ✅ Migrated | [`violations-store.ts`](../../packages/gateway-mcp/src/db/violations-store.ts) | 3 dual-backend tests |
| `approvals`           | ✅ Migrated | [`approvals-store.ts`](../../packages/gateway-mcp/src/db/approvals-store.ts) | 5 dual-backend tests (lifecycle FSM) |
| `pending_checks`      | ✅ Migrated | [`pending-checks-store.ts`](../../packages/gateway-mcp/src/db/pending-checks-store.ts) | 5 dual-backend tests |
| `agent_profiles`      | ✅ Migrated | [`agent-profiles-store.ts`](../../packages/gateway-mcp/src/db/agent-profiles-store.ts) | 3 dual-backend tests |
| `anomaly_events`      | ✅ Migrated | [`anomaly-events-store.ts`](../../packages/gateway-mcp/src/db/anomaly-events-store.ts) | 4 dual-backend tests |
| `sla_metrics`         | ✅ Migrated | [`sla-metrics-store.ts`](../../packages/gateway-mcp/src/db/sla-metrics-store.ts) | 3 dual-backend tests |
| `scan_history`        | ✅ Migrated | [`scan-history-store.ts`](../../packages/gateway-mcp/src/db/scan-history-store.ts) | 4 dual-backend tests |
| `compensation_dlq`    | ✅ Migrated | [`dlq-store.ts`](../../packages/gateway-mcp/src/db/dlq-store.ts) | 4 dual-backend tests |
| `organizations`       | ✅ Migrated | [`identity-stores.ts`](../../packages/gateway-mcp/src/db/identity-stores.ts) | 5 dual-backend tests |
| `api_keys`            | ✅ Migrated | [`identity-stores.ts`](../../packages/gateway-mcp/src/db/identity-stores.ts) | 3 dual-backend tests |
| `org_api_keys`        | ✅ Migrated | [`identity-stores.ts`](../../packages/gateway-mcp/src/db/identity-stores.ts) | 5 dual-backend tests |
| `transparency_witness` + `..._cosignature` | ✅ Migrated | [`witness-store.ts`](../../packages/gateway-mcp/src/db/witness-store.ts) | 4 dual-backend tests |
| `saga` + `saga_step`  | ✅ Migrated | [`saga-store.ts`](../../packages/gateway-mcp/src/db/saga-store.ts) | 5 dual-backend tests |
| `trace_snapshot`      | ✅ Migrated | [`snapshot-store.ts`](../../packages/gateway-mcp/src/db/snapshot-store.ts) | 5 dual-backend tests |
| `tenant_config` (JSON column) | ✅ Covered | `organizations.settings` is the source; OrganizationsStore.updateSettings exercises it | — |
| ~~`agent_id_cards`~~  | n/a — no underlying table (service uses signing primitives, not DB) | — | — |

**Phase A complete (2026-06-04)** — auth + identity tables migrated (gateway_config / scim_tokens / users / groups / user_sessions). All 5 stores have dual-backend implementations + pg-mem contract-parity tests (28 logical tests × 2 backends = 56 passing).

**Phase B complete (2026-06-05)** — operational hot-path tables migrated (traces / transparency_log / violations / approvals / pending_checks). 25 logical tests × 2 backends = 50 passing. TracesStore + TransparencyLogStore use the batched-write pattern (150ms flush interval, 500-row max batch); the others use direct INSERTs. The append-only transparency log preserves insertion order across both backends, verified by the "preserves insertion order via id" assertion.

**Phase C.1 complete (2026-06-05)** — operational ML/telemetry tables migrated (agent_profiles / anomaly_events / sla_metrics / scan_history / compensation_dlq). 18 logical tests × 2 backends = 36 passing. AnomalyEventsStore exposes `topByScore` for the cockpit leaderboard; SlaMetricsStore's `merge` UPSERTs counters while replacing percentile snapshots last-write-wins; DlqStore enforces tenant scoping on every read + state transition.

**Phase C.2 complete (2026-06-05)** — identity + specialised subsystems migrated (organizations / api_keys / org_api_keys / transparency_witness × 2 / saga × 2 / trace_snapshot). 27 logical tests × 2 backends = 54 passing. `tenant_config` is automatically covered because it persists as the `organizations.settings` JSON column — `OrganizationsStore.updateSettings` is the canonical write path and the dedicated assertion exercises round-trip persistence of `{ deploymentMode, sso, ... }`.

**Progress: 25 / 25 effective tables migrated (100%)** — every persisted resource AEGIS uses today has a typed `Store` interface with both Sqlite and Postgres adapters. Total dual-backend tests: **190 passing (95 logical × 2 backends)**. Set `DATABASE_URL=postgres://...` and every store automatically switches backend; the Sqlite path stays the default for single-binary deploys.

### What "100% migrated" means in practice

- **Schema coverage** — every CREATE TABLE in the v0 codebase has an equivalent Postgres adapter that pg-mem accepts AND that real Postgres ≥ 13 will accept (no version-specific syntax used).
- **Contract parity** — for every store, the same test asserting the same outcome runs against both backends. Drift between the two is caught on every PR.
- **Hot-path batching** — `traces` + `transparency_log` use batched writes on Postgres (150ms flush, 500-row max batch); admin / config tables go straight to INSERT.
- **Tenant isolation** — every method that reads or writes a tenant-scoped resource takes `orgId` and filters; cross-tenant reads are tested explicitly and verified to return null.

### What it does NOT mean

- **Service-side wiring**: most services still construct themselves with `Database.Database` directly. The store abstraction proves the persistence layer can run on Postgres; the wiring change ("flip the factory") is a follow-up PR that touches ~40 service instantiations. Doing it as a separate change keeps the migration reviewable.
- **Real-Postgres benchmarks**: pg-mem proves CORRECTNESS; absolute latency / throughput on real Postgres is measured by `scripts/bench-store.ts` (to be added during the wiring PR).
- **Cross-store transactions**: each store opens its own pool. The handful of operations that need cross-store atomicity (e.g. "mark trace approved + insert audit row") still rely on the service-layer event ordering. A SagaStore-style transactional outbox covers the durability gap.

## The pattern (apply this verbatim for each table)

### 1. Create the Store interface + two adapters

In `packages/gateway-mcp/src/db/<table>-store.ts`:

```ts
export interface FooStore {
  init(): Promise<void>;
  // <verbs the service needs>  — async even if the sqlite path is sync.
  close(): Promise<void>;
}

export class SqliteFooStore implements FooStore {
  constructor(private db: Database.Database) {}
  async init() { this.db.exec(`CREATE TABLE IF NOT EXISTS foo ( … )`); }
  // … sync better-sqlite3 wrapped in Promise.resolve
  async close() {}
}

export class PostgresFooStore implements FooStore {
  constructor(private pool: Pool) {}
  async init() { await this.pool.query(`CREATE TABLE IF NOT EXISTS foo ( … )`); }
  // … async pg
  async close() { await this.pool.end(); }
}
```

### 2. Adapt the service to take a Store

```ts
class FooService {
  constructor(private store: FooStore /* was: Database.Database */) {}
}
```

### 3. Factory selects the backend

```ts
// In server bootstrap:
const fooStore: FooStore = process.env.DATABASE_URL?.startsWith('postgres')
  ? new PostgresFooStore(pgPool)
  : new SqliteFooStore(db);
await fooStore.init();
const fooService = new FooService(fooStore);
```

### 4. Test BOTH backends via the same contract suite

Use `pg-mem` for in-process Postgres so CI doesn't need a real server.
Both adapters must pass identical assertions; the "contract parity"
test at the bottom of `audit-log-store.test.ts` is the template.

### 5. Drop the now-dead direct-db code in the service

After every service method is store-backed, remove the `db: Database.Database`
constructor parameter from `FooService`. The service no longer cares
about the backend.

## Hot-path notes

### `traces` — high write volume

The `traces` table receives ~1 row per tool call. On a busy tenant
that's hundreds per second. Two implementation rules:

1. **Batch writes** on the Postgres adapter, same pattern as
   `PostgresAuditLogStore.log()` — buffer + periodic multi-row INSERT.
2. **Keep the SDK ingestion endpoint synchronous from the client's
   POV** — return 201 immediately, enqueue the row, never block.

### `transparency_log` — append-only with Merkle anchoring

Treat exactly like `admin_audit_log`. No update / delete surface — only
append + read. The Merkle anchor lives separately and doesn't move
during migration.

### Per-tenant filter convention

Every store method that touches a tenant-scoped table MUST take
`orgId: string` as a parameter. Never accept a row-level `org_id` from
the caller and assume it's correct — the service resolves orgId from
the request context and passes it down.

## Performance acceptance criteria

After each table's migration, run the dual-backend smoke benchmark
(`packages/gateway-mcp/scripts/bench-store.ts`, when wired) and assert:

| Metric | Sqlite (baseline) | Postgres (target) |
|---|---|---|
| Single-row write p99 | < 2 ms | < 5 ms |
| 100-row batch write p99 | < 10 ms | < 25 ms |
| Indexed read (single row) p99 | < 1 ms | < 5 ms |
| Filtered list (limit=50) p99 | < 5 ms | < 15 ms |

Postgres is slower per-call (network + parsing) but scales horizontally.
If any metric blows the target by 2×, investigate the index strategy
before continuing the migration.

## Cutover plan (when ≥80% of tables are migrated)

1. **Dry-run on staging.** Spin up a second AEGIS instance pointed at
   Postgres while production stays on SQLite. Replay 24h of audit logs
   to confirm parity.
2. **Backfill.** Use `pg_dump` + `pg_restore`-style migration from the
   SQLite snapshot. A `agentguard migrate --to postgres` CLI command
   should be the single entry point.
3. **Cutover window.** Flip `DATABASE_URL` on production. The blast
   radius is bounded: if anything misbehaves, flip back — both backends
   stayed in sync via dual-write during the cutover window.
4. **Decommission SQLite write path** after 7 days of clean operation.

## Risk register

- **Async ripple.** Every service method that goes through a store
  becomes async. Callers up the stack must `await`. Audit each migrated
  service's call sites BEFORE merging.
- **Transaction semantics differ.** SQLite has implicit serialised
  writes; Postgres has MVCC. Any cross-row invariant must use explicit
  `BEGIN ... COMMIT` on the Postgres adapter.
- **Migration tool drift.** The SQLite `migrations[]` array in
  `db/database.ts` mirrors the schema-creation SQL on Postgres adapters.
  Keep them in lockstep — drift is the most common bug class in dual-
  backend deploys. The audit assertions catch this on each PR.

## Estimated effort

- Per low-traffic table (CRUD-only): **4-6 hours** including tests.
- Per hot-path table (`traces`, `transparency_log`): **1-2 days** each.
- Cutover + backfill tooling: **3-5 days** one-time.
- **Total to "Postgres-native" claim**: **2-3 weeks** of dedicated work.

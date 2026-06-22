# Runbook — Business Continuity / Disaster Recovery

**Last reviewed:** 2026-06-03
**Owner:** CTO / Eng lead

## 1. Goal

Maintain AEGIS service availability through localised failure (single
instance, single region) and recover cleanly from broader disasters
(region loss, data corruption, supply-chain compromise).

## 2. Architecture Resilience

| Layer | Resilience strategy |
|---|---|
| Gateway | Stateless behind LB; horizontal scaling; Postgres + Litestream stream replication |
| Storage | Litestream → S3 (for SQLite) or managed Postgres with multi-AZ |
| Audit log | Replicated to at least 2 independent witnesses |
| Configuration | Versioned in secret-manager with immutable history |
| Dependencies | Pinned versions; SBOM stored in CI artifacts |

## 3. Failure Scenarios + Responses

### Scenario A — Gateway pod crash
- Detection: K8s liveness probe failure on `/health`.
- Response: K8s restarts the pod. RTO ≤ 30s.
- Customer impact: in-flight requests fail with 5xx; retries succeed.

### Scenario B — DB corruption
- Detection: Anomaly on `aegis_http_errors_total{route=...}` rate.
- Response: Cut traffic to standby region; restore from latest backup
  (see `backup-restore.md` §2).
- RTO: 30 min. RPO: 5 min.

### Scenario C — Region loss
- Detection: cloud provider status + healthcheck timeouts.
- Response: failover to standby region; DNS cutover.
- RTO: 60 min.

### Scenario D — Audit-log fork (witness disagreement)
- Detection: `aegis_witness_disagreement_total` > 0 (when wired) or
  cosignatures missing from STH for > 2 flush intervals.
- Response: Sev-1. Halt new ingestion, snapshot current Merkle root,
  investigate. Communicate with affected tenants (the tenant is the
  party with cryptographic recourse).

### Scenario E — Compromise of an external witness
- Detection: One witness signs a fork that no other witness signs.
- Response: Remove witness from active set; require redeploy with
  rotated witness pubkeys.

## 4. Annual DR Exercise

Once per year, simulate Scenario C (region loss) end-to-end:
- Failover from primary to secondary region.
- Run health + e2e probes.
- Measure RTO + RPO; compare to targets above.
- Update this runbook with any gaps surfaced.
- File evidence in `evidence/dr-exercise/`.

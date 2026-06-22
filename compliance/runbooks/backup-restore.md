# Runbook — Backup and Restore

**Last reviewed:** 2026-06-03
**On-call drill cadence:** Quarterly (next: 2026-09-03)

## 1. Backup Targets

| Resource | Mechanism | Frequency | Retention |
|---|---|---|---|
| SQLite DB (`./agentguard.db`) | Litestream → S3 | Streaming | 30 days point-in-time + 1 year daily snapshots |
| Postgres DB (if `DATABASE_URL=postgres://`) | pg_dump → S3 | Hourly | Same |
| Configuration / .env | Encrypted secret-manager | Live | Indefinite |
| Audit log content + Merkle tree | Replicated to a witness | Per-flush | Forever |

## 2. Test-Restore Drill (run quarterly)

```bash
# 1. Spin up an isolated restore environment
docker-compose -f docker/restore-test.yml up -d

# 2. Pull the latest backup
litestream restore -config litestream.yml -o /tmp/restore.db s3://aegis-backups/agentguard.db

# 3. Boot a gateway pointed at the restored file
GATEWAY_DB=/tmp/restore.db PORT=18080 node packages/gateway-mcp/dist/server.js &

# 4. Verify health + smoke test
curl -fsS http://localhost:18080/health
curl -fsS http://localhost:18080/api/v1/health
curl -fsS http://localhost:18080/metrics | grep aegis_http_requests_total

# 5. Verify the Merkle audit log via the offline CLI verifier
node tools/verify-log/index.mjs verify-inclusion /tmp/sample-proof.json

# 6. Document drill in evidence/
echo "Restore drill $(date -Iseconds): OK" >> compliance/evidence/restore-drills.log
```

## 3. Production Rollback

```bash
# 1. Stop the current container
docker-compose -f docker/compose.yml stop gateway

# 2. Pull the prior tagged image (we keep N-1 for at least 7 days)
docker pull aegis/gateway:$PREVIOUS_TAG

# 3. Update compose.yml IMAGE tag, restart
docker-compose -f docker/compose.yml up -d gateway

# 4. Confirm health + the saga + DLQ services drain any in-flight work
curl -fsS http://localhost:8080/health
curl -fsS http://localhost:8080/api/v1/rollback/sagas?state=running
```

## 4. Disaster-Recovery RPO / RTO

- **RPO (Recovery Point Objective):** 5 minutes
  (Litestream replication lag).
- **RTO (Recovery Time Objective):** 30 minutes from incident
  declaration to service restoration in the secondary region.

## 5. Evidence

Each drill writes a row to `evidence/restore-drills.log` with timestamp +
operator + outcome. Auditors sample 4 quarters per year.

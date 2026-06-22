# Data Retention and Disposal Policy

**Document owner:** CISO
**Version:** 1.0
**Effective date:** 2026-06-03

## 1. Scope

Defines how long AEGIS retains each class of customer + operational
data and how it is securely disposed of.

## 2. Retention Schedule

| Data class | Default retention | Configurable per tenant | Notes |
|---|---|---|---|
| Tool-call traces | 90 days | Yes — per-tenant TTL | PII in raw I/O is redacted on ingest |
| Audit log | 7 years | No (compliance mandate) | Stored append-only + Merkle-anchored |
| Approval requests | 90 days | Yes | Includes human reviewer identity |
| Anomaly events | 1 year | Yes | Aggregated stats retained longer |
| Session records | 30 days | No | Including IP + user-agent |
| SLA metrics aggregates | 2 years | No | P50/95/99 latency, uptime % |
| Cosignatures + STH | Forever | No | Required for tamper-evident audit chain |
| API key hashes | Until rotation + 30 days | No | Plaintext keys never persisted |
| Customer billing | 7 years | No | US tax-record requirement |

## 3. PII Handling

AEGIS includes a PII detector that runs on every trace ingestion (see
`services/pii.ts`). Detected fields are redacted in place and the
`pii_detected` flag is set. Customer tenants can configure stricter
redaction rules through their tenant config.

## 4. Right to Erasure (GDPR Art. 17)

When a data-subject erasure request is received via the tenant admin:

1. Verify legitimacy (the requester is a controller-side admin).
2. Identify all rows tied to the subject's identifier (email, agent_id,
   session_id, trace_id).
3. Run the redaction job (`agentguard erase --subject <id>`) which
   replaces the row content with a tombstone marker and updates the
   audit log. The Merkle hash of the original row remains so historical
   integrity proofs continue to verify — only the cleartext is gone.
4. Notify the data subject within 30 days (GDPR statutory window).

## 5. Disposal

- Disk-level: cloud provider erase APIs + cryptographic key destruction.
- Backup media: encrypted at rest; destroyed at end of retention via
  vendor confirmation.
- Hardware decommissioning: secure-erase per NIST 800-88 by the cloud
  provider; we don't manage physical media directly.

## 6. Backups

Backup retention mirrors source retention. The `runbooks/backup-restore.md`
runbook documents test-restore cadence (quarterly).

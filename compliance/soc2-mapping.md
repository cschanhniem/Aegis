# SOC 2 Trust Service Criteria → AEGIS Control Mapping

Each row maps a SOC 2 Common Criteria control to (a) the AEGIS policy
that establishes it, (b) the runbook that operates it, and (c) the
gateway evidence type an auditor can sample. "Evidence type" maps to the
`?type=` query parameter on `GET /api/v1/compliance/evidence`.

## CC1 — Control Environment

| Control | Policy | Runbook | Evidence type |
|---|---|---|---|
| CC1.1 — COSO principles communicated | [`information-security.md`](policies/information-security.md) | — | `policies` |
| CC1.2 — Board / leadership oversight | [`information-security.md`](policies/information-security.md) §1 | — | — |
| CC1.3 — Org structure + authority | [`access-control.md`](policies/access-control.md) §2 | — | `roles` |
| CC1.4 — Personnel competency | [`information-security.md`](policies/information-security.md) §6 | — | `training` (external LMS) |
| CC1.5 — Accountability for internal control | [`information-security.md`](policies/information-security.md) §7 | — | `audit-log` |

## CC2 — Communication and Information

| Control | Policy | Runbook | Evidence type |
|---|---|---|---|
| CC2.1 — Quality of information | [`information-security.md`](policies/information-security.md) §3 | — | `audit-log` |
| CC2.2 — Internal communication | [`incident-response.md`](policies/incident-response.md) §4 | — | — |
| CC2.3 — External communication | [`incident-response.md`](policies/incident-response.md) §5 | — | — |

## CC3 — Risk Assessment

| Control | Policy | Runbook | Evidence type |
|---|---|---|---|
| CC3.1 — Risk objectives | [`information-security.md`](policies/information-security.md) §2 | — | — |
| CC3.2 — Risk identification | [`vendor-risk.md`](policies/vendor-risk.md) | [`access-review.md`](runbooks/access-review.md) | `vendors` |
| CC3.3 — Fraud risk | [`access-control.md`](policies/access-control.md) §5 | — | `audit-log` |
| CC3.4 — Significant change | [`change-management.md`](policies/change-management.md) | — | `changes` |

## CC4 — Monitoring Activities

| Control | Policy | Runbook | Evidence type |
|---|---|---|---|
| CC4.1 — Ongoing evaluation | [`information-security.md`](policies/information-security.md) §8 | [`access-review.md`](runbooks/access-review.md) | `access-review` |
| CC4.2 — Communicate deficiencies | [`incident-response.md`](policies/incident-response.md) §3 | — | `incidents` |

## CC5 — Control Activities

| Control | Policy | Runbook | Evidence type |
|---|---|---|---|
| CC5.1 — Selection / development | [`change-management.md`](policies/change-management.md) | — | `changes` |
| CC5.2 — Tech controls | [`access-control.md`](policies/access-control.md) | — | `policy-config` |
| CC5.3 — Policy + procedure deployment | (this directory) | — | `policies` |

## CC6 — Logical and Physical Access

| Control | Policy | Runbook | Evidence type |
|---|---|---|---|
| CC6.1 — Logical access provisioning | [`access-control.md`](policies/access-control.md) §3 | — | `users`, `roles` |
| CC6.2 — New users registered, terminated removed | [`access-control.md`](policies/access-control.md) §4 | [`access-review.md`](runbooks/access-review.md) | `users` |
| CC6.3 — Access changes authorised | [`access-control.md`](policies/access-control.md) §6 | — | `audit-log` |
| CC6.6 — External access restricted | [`access-control.md`](policies/access-control.md) §7 | — | `sessions` |
| CC6.7 — Data in transit protected | [`information-security.md`](policies/information-security.md) §9 | — | `tls-config` |
| CC6.8 — Malicious software prevention | [`information-security.md`](policies/information-security.md) §10 | — | — |

## CC7 — System Operations

| Control | Policy | Runbook | Evidence type |
|---|---|---|---|
| CC7.1 — Detection of anomalies | [`information-security.md`](policies/information-security.md) §11 | — | `anomalies` |
| CC7.2 — System monitoring | [`information-security.md`](policies/information-security.md) §12 | — | `monitoring` |
| CC7.3 — Incident evaluation | [`incident-response.md`](policies/incident-response.md) | — | `incidents` |
| CC7.4 — Incident response | [`incident-response.md`](policies/incident-response.md) | — | `incidents` |
| CC7.5 — Recovery from incidents | [`incident-response.md`](policies/incident-response.md) §6 | [`business-continuity.md`](runbooks/business-continuity.md) | `incidents` |

## CC8 — Change Management

| Control | Policy | Runbook | Evidence type |
|---|---|---|---|
| CC8.1 — Change authorised | [`change-management.md`](policies/change-management.md) | — | `changes` |

## CC9 — Risk Mitigation

| Control | Policy | Runbook | Evidence type |
|---|---|---|---|
| CC9.1 — Risk mitigation activities | [`vendor-risk.md`](policies/vendor-risk.md) | — | `vendors` |
| CC9.2 — Vendor risk assessment | [`vendor-risk.md`](policies/vendor-risk.md) | — | `vendors` |

## Optional Trust Service Categories

| Category | Control example | Where implemented |
|---|---|---|
| Availability A1.1 — Performance monitoring | `/metrics` Prometheus endpoint | [`gateway-metrics.ts`](../packages/gateway-mcp/src/services/gateway-metrics.ts) |
| Availability A1.2 — Capacity planning | `aegis_dlq_depth`, `aegis_anomaly_p95` gauges | (above) |
| Availability A1.3 — Recovery + backup | [`backup-restore.md`](runbooks/backup-restore.md) | runbook |
| Confidentiality C1.1 — Data classification | [`data-retention.md`](policies/data-retention.md) | policy + redactor |
| Confidentiality C1.2 — Confidential disposal | [`data-retention.md`](policies/data-retention.md) | policy |
| Processing Integrity PI1 — Inputs validated | AJV policy compile + classifier | [`policy-engine.ts`](../packages/gateway-mcp/src/policies/policy-engine.ts) |
| Processing Integrity PI1.3 — System outputs tamper-evident | RFC 6962 Merkle audit log + witness | [`merkle.ts`](../packages/gateway-mcp/src/services/merkle.ts) |
| Privacy P3.2 — Notice + consent | (customer-facing, out of scope here) | — |

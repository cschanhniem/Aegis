# Information Security Policy

**Document owner:** CISO / Head of Security
**Version:** 1.0
**Effective date:** 2026-06-03
**Review cadence:** Annual

## 1. Purpose and Authority

This policy establishes the information security program for AEGIS. It
is approved by the leadership team and applies to all employees,
contractors, and third parties with access to AEGIS systems or data.

## 2. Risk-Management Objectives

AEGIS classifies assets along three dimensions: confidentiality,
integrity, and availability. Annual risk assessments rank threats in a
likelihood × impact matrix and assign mitigations to specific controls
in this policy. The CISO maintains the risk register; significant
changes (new product surfaces, new third-party integrations, major
customer-data flows) trigger an out-of-band re-assessment.

## 3. Information Quality and Classification

Customer data carried by AEGIS is classified as **Confidential** by
default. Internal-only data (e.g. config metadata, audit logs) is
classified as **Internal**. Public materials (marketing pages, docs) are
**Public**. Classification determines retention, access control, and
incident-response severity (see `data-retention.md`).

## 4. Acceptable Use

Personnel may only access AEGIS systems for purposes related to their
job function. Personal devices accessing production require approved MDM
controls. Credentials are not shared. Side-loaded plugins / browser
extensions on machines that hold administrative credentials require
security review.

## 5. Personnel Security

Background checks are performed before granting production access.
Employment offers include confidentiality + security training
obligations. Termination triggers access revocation within one business
day (see `access-control.md` §4 and `runbooks/access-review.md`).

## 6. Training

All personnel complete annual security-awareness training. Engineering
staff with production access complete an additional secure-development
module. Training completion records are retained for at least 2 years
and exported to the SOC 2 evidence package via the LMS API.

## 7. Accountability

Each control in `soc2-mapping.md` has a named owner. Owners are
accountable for documenting evidence of operation each quarter and for
reporting deficiencies via the incident-response channel.

## 8. Monitoring

The AEGIS gateway emits Prometheus metrics for request rate, error
rate, decision mix, anomaly velocity, and DLQ depth (see
`packages/gateway-mcp/src/services/gateway-metrics.ts`). Operations
reviews these dashboards daily and triages deviations. Quarterly
internal-control reviews sample evidence from
`/api/v1/compliance/evidence`.

## 9. Cryptography and Data in Transit

All public-facing AEGIS endpoints serve TLS 1.2+ with the Mozilla
"intermediate" profile. HSTS is enforced
(`Strict-Transport-Security: max-age=31536000; includeSubDomains`).
Cosigned audit roots use Ed25519. The transparency log uses SHA-256
Merkle hashing per RFC 6962.

## 10. Malware Prevention

Engineering workstations run an EDR (CrowdStrike Falcon / SentinelOne)
with always-on signature + behavioural detection. Production hosts run
the same EDR plus immutable-OS controls. Container images are scanned
on build (Trivy) and on pull (registry policy).

## 11. Anomaly Detection (Layer 2)

AEGIS includes an in-product anomaly-detection layer that combines
Mahalanobis distance, Half-Space Trees, conformal calibration, ADWIN
drift detection, and an active-learning loop (see
`services/anomaly-detector.ts`). Anomalies above tenant threshold are
escalated to the cockpit's anomalies tab and counted in
`aegis_anomaly_events_total`.

## 12. Logging and Audit

Every state-changing API call is recorded in the `audit_log` table with
the actor, action, resource, and IP. Tool-call traces are written to
`traces` and Merkle-anchored every flush interval (see
`services/transparency-log.ts`). The Merkle root is cosigned by external
witnesses (see `services/witness.ts`) so the audit log is tamper-evident
against gateway operators themselves.

## 13. Policy Exceptions

Any deviation from this policy requires written CISO approval, a
documented compensating control, and a scheduled review date.
Exceptions are logged in `evidence/exceptions/` and reviewed quarterly.

## 14. Review and Update

This policy is reviewed at least annually and following any significant
change to the AEGIS system or its operating environment. Updates are
versioned at the top of this document.

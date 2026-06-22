# Incident Response Plan

**Document owner:** CISO / On-call lead
**Version:** 1.0
**Effective date:** 2026-06-03

## 1. Definitions

An **incident** is any event that compromises (or has high likelihood of
compromising) the confidentiality, integrity, or availability of AEGIS
data or services.

Severity:

| Sev | Definition | Pager |
|---|---|---|
| Sev-1 | Confirmed data exfiltration, full outage, or security breach affecting multiple tenants | Page CISO + Eng lead + CEO |
| Sev-2 | Major degradation, single-tenant breach, or significant privacy event | Page on-call + Eng lead |
| Sev-3 | Localised degradation; no customer impact yet but risk of escalation | Page on-call |
| Sev-4 | Internal noise / non-actionable signal | Ticket only |

## 2. Detection Sources

- Prometheus alerts on `/metrics` (error rate, anomaly velocity, DLQ
  depth, witness fail rate)
- Audit-log anomalies surfaced via cockpit anomaly panel
- Customer reports (security@agentguard.example)
- Vendor advisories (npm audit, GitHub advisories, vendor PSIRT)
- Independent witness disagreement on STH cosign (= silent tampering
  attempt — paging Sev-1)

## 3. Response Phases

1. **Detect / Triage** — on-call engineer acknowledges within 15 min.
2. **Contain** — disable affected tenant key, block offending IP at
   ingress, or revoke compromised credentials.
3. **Eradicate** — patch the underlying vulnerability; deploy via
   emergency change-management path.
4. **Recover** — restore service; rotate any credentials that may have
   been exposed.
5. **Post-incident review** — within 5 business days. Document timeline,
   blast radius, root cause, corrective actions. File in
   `evidence/incidents/`.

## 4. Internal Communication

- Slack #incident-<id> war room.
- Status updates every 30 minutes during Sev-1, hourly Sev-2.
- Executive briefing for any Sev-1 or Sev-2 affecting customer data.

## 5. External Communication

- Customer-facing notice within 72 hours of confirmed breach (GDPR
  Art. 33) and per US state breach-notification statutes (where
  applicable).
- Notification routes: dedicated status page + direct email to tenant
  primary contact.
- Regulator notifications: ICO / state AG within statutory windows when
  applicable.

## 6. Recovery + Post-Mortem

- Blameless post-mortem template lives in
  `evidence/incident-template.md`.
- Action items tracked to closure; pre-mortem repeats validate that
  the same incident class does not recur.

## 7. Tabletop Exercises

A tabletop exercise covering a high-likelihood scenario (e.g. supply-
chain compromise, customer key leak, witness fork) is run at least
annually. Findings + action items filed in `evidence/exercises/`.

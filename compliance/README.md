# AEGIS Compliance Package

This directory contains the documents, runbooks, and evidence-collection
plumbing that SOC 2 (Type I → Type II) audits require for AEGIS.

> **Status — not yet audited.** This package is the *foundation*: the
> policies, runbooks, and control mappings that will let a SOC 2 auditor
> begin a Type I gap assessment. It is *not* a SOC 2 report and does not
> imply certification.

## Layout

| Path | Purpose |
|---|---|
| `policies/`  | Mandatory security policies referenced from SOC 2 controls |
| `runbooks/`  | Operational procedures auditors sample as evidence of execution |
| `evidence/`  | Scripts + endpoint specs for the automated evidence collection |
| `soc2-mapping.md` | Trust Service Criteria (CC1–CC9) → AEGIS control mapping |

## How an auditor uses this

1. **Policy review.** Read `policies/*.md`. Each is structured to map 1:1
   onto a specific SOC 2 control statement (see `soc2-mapping.md`).
2. **Runbook walkthrough.** Pick a runbook (e.g. `runbooks/backup-restore.md`)
   and request a recent execution timestamp.
3. **Evidence sampling.** Hit `/api/v1/compliance/evidence?type=...` (auth
   required) and receive a JSON payload that matches the control's
   evidence requirement. The endpoint is implemented in
   [`packages/gateway-mcp/src/api/compliance.ts`](../packages/gateway-mcp/src/api/compliance.ts)
   and exercised by [its test suite](../packages/gateway-mcp/src/__tests__/compliance-evidence.test.ts).

## What SOC 2 audit firms expect (preparation checklist)

- [x] Information Security Policy ([`policies/information-security.md`](policies/information-security.md))
- [x] Access Control Policy ([`policies/access-control.md`](policies/access-control.md))
- [x] Change Management Policy ([`policies/change-management.md`](policies/change-management.md))
- [x] Incident Response Plan ([`policies/incident-response.md`](policies/incident-response.md))
- [x] Vendor Risk Management ([`policies/vendor-risk.md`](policies/vendor-risk.md))
- [x] Data Retention Policy ([`policies/data-retention.md`](policies/data-retention.md))
- [x] Business Continuity / Disaster Recovery ([`runbooks/business-continuity.md`](runbooks/business-continuity.md))
- [x] Backup + restore runbook ([`runbooks/backup-restore.md`](runbooks/backup-restore.md))
- [x] Quarterly access review runbook ([`runbooks/access-review.md`](runbooks/access-review.md))
- [x] Annual penetration test (engage external firm; track in `evidence/pentest/`) — **TODO before Type II**
- [x] Security awareness training (LMS export → `evidence/training/`) — **TODO before Type II**
- [x] SOC 2 Type I gap assessment by qualified CPA — **TODO**

## What's NOT in scope here

- Actual certification (run by Drata / Vanta / Secureframe + a CPA firm)
- Customer-facing trust pages (see `apps/compliance-cockpit/` for the
  in-product version)
- Legal contracts (DPA, MSA, BAA) — those live with legal counsel

## Recommended Type I → Type II timeline

| Phase | Duration | Deliverable |
|---|---|---|
| Readiness | 4–8 weeks | Adopt all policies, run all runbooks at least once, populate evidence/ |
| Gap assessment | 2 weeks | CPA reviews this directory; flags missing controls |
| Remediation | 4–12 weeks | Close gaps |
| Type I attestation | 2 weeks | CPA attests controls are *designed* correctly |
| Observation window | 3–12 months | Evidence accumulates automatically through the gateway |
| Type II attestation | 4 weeks | CPA attests controls *operated* effectively across the window |

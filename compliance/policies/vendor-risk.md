# Vendor Risk Management Policy

**Document owner:** CISO
**Version:** 1.0
**Effective date:** 2026-06-03

## 1. Scope

Every third-party service or library that has access to AEGIS systems
or customer data is treated as a vendor. This includes cloud
infrastructure (AWS / GCP / Azure), SaaS tools, payment processors,
authentication providers, and runtime npm dependencies that handle
PII or credentials.

## 2. Onboarding

Before any vendor is given production access:

- Security questionnaire completed (CAIQ-Lite or equivalent).
- Latest SOC 2 / ISO 27001 report on file (if applicable).
- Data Processing Agreement signed if PII / customer data is shared.
- Risk rating: Low / Medium / High based on data scope + criticality.
- Approval by CISO for Medium / High vendors.

## 3. Continuous Monitoring

- Annual re-attestation of SOC 2 / ISO certification status.
- Subscription to vendor security advisories.
- For npm dependencies: weekly Dependabot scan, immediate triage of
  CRITICAL / HIGH CVEs.

## 4. Sub-processor List

Customer-facing sub-processor list is maintained in
`evidence/subprocessors.md` and surfaced on the public trust page.
30-day notice to tenants before adding a new sub-processor that
handles customer data (GDPR Art. 28).

## 5. Termination

Off-boarding workflow:

- Revoke API credentials and integrations.
- Confirm data deletion (request return / destruction certificate).
- Document in `evidence/vendor-offboard/`.

## 6. Current Vendors

The active vendor list lives in `evidence/vendors.md`. Each entry
captures: name, service, data scope, risk rating, certification status,
DPA on file (Y/N), next review date.

# Runbook — Quarterly Access Review

**Last reviewed:** 2026-06-03
**Cadence:** Quarterly (first business day of each quarter)
**Owner:** Head of Engineering

## 1. Goal

Confirm that every account with production access is still appropriate
for its role and that no orphaned / over-privileged accounts exist.

## 2. Inputs

- HR roster (active employees + role)
- IdP user list (Okta / Azure AD / Google / SAML)
- AEGIS gateway `users` table — query via:
  ```bash
  curl -s -H "X-API-Key: $ADMIN_KEY" \
    "http://gateway.internal/api/v1/compliance/evidence?type=users" \
    > evidence/access-review-$(date +%Y%m%d)/users.json
  ```
- AEGIS gateway role assignments:
  ```bash
  curl -s -H "X-API-Key: $ADMIN_KEY" \
    "http://gateway.internal/api/v1/compliance/evidence?type=roles" \
    > evidence/access-review-$(date +%Y%m%d)/roles.json
  ```
- Vendor system rosters (anything in `evidence/vendors.md`)

## 3. Procedure

1. **Reconciliation.** For each AEGIS account, confirm a matching HR
   record. Flag mismatches.
2. **Role appropriateness.** For each account, confirm the assigned
   role matches the person's current job function.
3. **Privileged review.** Specifically audit every `admin` account.
4. **Stale accounts.** Flag any account with no successful login in
   the last 90 days for deactivation.
5. **Sign-off.** Head of Engineering signs the review attesting that
   all findings have been addressed. The signed document is filed in
   `evidence/access-review-YYYYMMDD/`.

## 4. Output

- `evidence/access-review-YYYYMMDD/users.json`
- `evidence/access-review-YYYYMMDD/roles.json`
- `evidence/access-review-YYYYMMDD/findings.md`
- `evidence/access-review-YYYYMMDD/signoff.pdf`

## 5. Auditor Sample

Auditors typically sample 1–2 quarters per Type II window. They will:
- Read `findings.md` and pick a random account.
- Cross-check that the noted action (deactivation / role change) was
  applied — look for the corresponding row in the AEGIS audit log:
  ```bash
  curl -s -H "X-API-Key: $ADMIN_KEY" \
    "http://gateway.internal/api/v1/compliance/evidence?type=audit-log&action=user.deactivate&since=YYYY-MM-DD"
  ```

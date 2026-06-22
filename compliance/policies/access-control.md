# Access Control Policy

**Document owner:** Head of Engineering
**Version:** 1.0
**Effective date:** 2026-06-03

## 1. Purpose

Define how AEGIS personnel and tenants are authenticated, authorised,
and audited.

## 2. Principles

- **Least privilege** — every account has only the minimum permissions
  needed for its role.
- **Separation of duties** — administrative actions on production are
  initiated by one person and approved by another (cockpit
  `/api/v1/approvals` workflow).
- **No shared accounts** — every login binds to a single identifiable
  human or service.

## 3. Provisioning

- Workforce identity is brokered through the corporate IdP (Okta /
  Azure AD / Google Workspace via OIDC, or any SAML 2.0 IdP — see
  `services/oidc-adapter.ts` and `services/saml-adapter.ts`).
- Production access requires a manager-approved access request and
  recorded acknowledgement of this policy.
- Tenant-side identity is delegated to the customer's own IdP. AEGIS
  honours the customer's `role_hint` (from OIDC group claims or SAML
  attributes) but the final cockpit role is set by a tenant admin.

## 4. Termination / Role Change

- Termination triggers IdP-side suspension within one business day.
- Quarterly access reviews (`runbooks/access-review.md`) reconcile the
  active-account list against HR records.
- Role downgrades take effect at next login; the gateway invalidates
  any active session whose attached role no longer matches.

## 5. Privileged Access

- `admin` role permissions are limited to a documented short list (see
  `services/role-permissions.ts`).
- Every admin action is recorded in the `audit_log` table with actor +
  client IP.
- Privileged operations on customer data (e.g. inspecting a tenant's
  traces for support) require the customer's documented consent and
  are flagged in audit logs.

## 6. Authentication

- SSO is mandatory for all workforce and tenant-admin accounts.
- API keys (used by SDKs) are issued per-tenant, never per-employee.
  Compromise mitigation: rotation supported via `gateway_config` table;
  policy: rotate every 365 days minimum, immediately on suspected
  compromise.
- Bootstrap keys (`/api/v1/auth/key`) are accessible only on first run
  and require network-restricted ingress in production.

## 7. External Access

- Production ingress is restricted to the cockpit, the SDK API, and
  the Prometheus scrape target (`/metrics`).
- The `/metrics` endpoint is **scrape-network-restricted** by deploy
  config; not exposed to the public internet.
- The `/api/v1/auth/key` bootstrap is **denied** in production
  (`config.server.isProduction` gate).

## 8. Session Management

- Cockpit sessions use HTTP-only, Secure, SameSite=Lax cookies.
- Session lifetime: 12 hours sliding; 30 days absolute.
- Forced logout on password change, IdP role change, or anomaly above
  threshold.

## 9. Multi-Tenancy

- Every API request is bound to an `orgId` resolved from auth.
- The PolicyEngine, DSL, TenantConfig, Witness, and AgentRegistry all
  enforce per-tenant isolation. Cross-tenant access is impossible from
  the standard API surface.
- Wildcard platform-default policies (`org_id='*'`) apply to all
  tenants but cannot be modified by tenant admins.

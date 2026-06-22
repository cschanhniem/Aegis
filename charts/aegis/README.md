# AEGIS Helm Chart

Run the AEGIS gateway + compliance cockpit on Kubernetes.

## Install

```bash
helm repo add aegis https://justin0504.github.io/Aegis/charts
helm install aegis aegis/aegis -n aegis --create-namespace
```

Or from this repo:

```bash
git clone https://github.com/Justin0504/Aegis
helm install aegis ./Aegis/charts/aegis -n aegis --create-namespace
```

## Production values

```yaml
# my-values.yaml
gateway:
  license:
    tier: enterprise
    key: <license-key>
  database:
    dbUrl: postgres://aegis:****@postgres.host:5432/aegis
    persistence: { enabled: false }   # not needed with managed Postgres
  apiKey: <pre-generated-key>          # blank → auto-generate on first start

ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
  hosts:
    - host: aegis.acme.com
      paths:
        - { path: /,    service: cockpit }
        - { path: /api, service: gateway }
  tls:
    - hosts: [aegis.acme.com]
      secretName: aegis-tls
```

```bash
helm upgrade --install aegis aegis/aegis -n aegis -f my-values.yaml
```

## What you get

| Resource | Purpose |
|---|---|
| `Deployment: aegis-gateway` | Policy engine — 8080/tcp |
| `Deployment: aegis-cockpit` | Next.js dashboard — 3000/tcp |
| `Service: aegis-gateway` | ClusterIP for the gateway |
| `Service: aegis-cockpit` | ClusterIP for the cockpit |
| `PVC: aegis-gateway-data` | SQLite volume (only if `database.dbUrl` blank) |
| `Secret: aegis-config` | API key + license key + DB URL |
| `Ingress` (optional) | Single host serving both, path-based routing |

## Common knobs

| Value | Default | Notes |
|---|---|---|
| `gateway.image.tag` | chart `appVersion` | pin specific gateway image |
| `gateway.replicas` | `1` | scale horizontally (stateless with Postgres) |
| `gateway.database.dbUrl` | (empty) | leave blank for SQLite, set for managed Postgres |
| `gateway.database.persistence.size` | `5Gi` | SQLite PVC size |
| `gateway.license.tier` | `community` | `community` / `pro` / `enterprise` |
| `cockpit.enabled` | `true` | flip off if running cockpit elsewhere |
| `ingress.enabled` | `false` | enable for external access |

## Uninstall

```bash
helm uninstall aegis -n aegis
kubectl delete pvc -n aegis -l app.kubernetes.io/instance=aegis   # blow away SQLite data
```

# AgentGuard — Go SDK

Go client for **AEGIS**, the firewall for AI agents
([github.com/Justin0504/Aegis](https://github.com/Justin0504/Aegis)).

The full AEGIS feature set — pre-execution policy checks,
tamper-evident audit trail, behavioural anomaly detection, Code
Shield, alignment auditing — runs in the gateway. This package is
the Go-side ergonomics for emitting traces and calling `/check`.

> Need the full README, deployment templates, Cockpit dashboard?
> See the parent repo. This file is the Go SDK quickstart only.

## Install

```bash
go get github.com/Justin0504/Aegis/packages/sdk-go
```

You also need an AEGIS gateway running on `http://localhost:8080`
(or wherever — the URL is configurable). Easiest paths:

- [Download the desktop app](https://github.com/Justin0504/Aegis/releases/latest) (macOS arm64 .dmg; Windows + Linux in v0.2.x)
- `docker run -p 8080:8080 ghcr.io/aegis-sec/aegis-gateway:latest`

## Quick start

```go
package main

import (
    "github.com/Justin0504/Aegis/packages/sdk-go/agentguard"
)

func main() {
    guard := agentguard.New(agentguard.Config{
        GatewayURL:  "http://localhost:8080",
        AgentID:     "my-go-agent",
        Environment: "PRODUCTION",
    })
    defer guard.Close()

    // Before dispatching a tool call:
    decision, err := guard.Check("execute_sql", map[string]any{
        "sql": "DELETE FROM audit_logs",
    })
    if err != nil {
        // gateway unreachable — fail-open behaviour up to you
    }
    if decision.Decision == "block" {
        // refuse to dispatch; AEGIS already logged the attempt
        return
    }

    // …run your tool, then emit a trace for the audit trail:
    guard.SendTrace(agentguard.Trace{
        ToolCall:    agentguard.ToolCall{Name: "execute_sql", Arguments: ...},
        Observation: agentguard.Observation{RawOutput: ..., DurationMs: 12.4},
    })
}
```

`Auto()` reads the same options from environment variables
(`AEGIS_GATEWAY_URL`, `AEGIS_API_KEY`, `AEGIS_AGENT_ID`,
`AGENTGUARD_*` as legacy aliases) for the typical
`agentguard.Auto()` one-liner.

## Entry points

| Function                              | Purpose                                        |
| ------------------------------------- | ---------------------------------------------- |
| `agentguard.Auto()`                   | Config from env vars                           |
| `agentguard.New(cfg)`                 | Explicit config                                |
| `(*AgentGuard).Check(tool, args)`     | Pre-execution policy check                     |
| `(*AgentGuard).SendTrace(trace)`      | Emit an audit-trail record                     |
| `agentguard.BlockedError`             | Returned by `Check` when policy blocks         |

Code Shield + Alignment helpers are available via the gateway's
REST endpoints directly (`/api/v1/code-shield/scan` and
`/api/v1/alignment/check`); a Go-native helper API for those
ships in v0.3.x. Today, hit the endpoints with `net/http` and the
same JSON shape as the Python / JS SDKs.

## Example

A complete runnable example lives in [`example/main.go`](./example/main.go).

## License

MIT. See the [parent repo](https://github.com/Justin0504/Aegis) for
the gateway, Cockpit, CLI, and deployment story.

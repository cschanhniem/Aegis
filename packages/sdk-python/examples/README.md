# AEGIS Python SDK — runnable examples

Each file is a single, self-contained script. They assume:

1. A running AEGIS gateway. Easiest path:
   ```bash
   # Native (desktop app)
   open AEGIS.app                # already binds 127.0.0.1:18080

   # Docker
   docker run -p 8080:8080 ghcr.io/aegis-sec/aegis-gateway:latest
   ```
2. The Python SDK installed (`pip install agentguard-aegis`).
3. Your gateway API key in the environment:
   ```bash
   export AEGIS_API_KEY="$(curl -s http://localhost:8080/api/v1/auth/key | jq -r .api_key)"
   ```

| Example                          | Shows                                                     |
| -------------------------------- | --------------------------------------------------------- |
| `quickstart_anthropic.py`        | One-line auto-instrumentation, every tool call traced     |
| `code_shield_scan.py`            | Scan agent-generated code, get severity + findings        |
| `langchain_alignment.py`         | Chain-of-thought alignment audit + closed-loop /check     |
| `policy_dsl_bootstrap.py`        | Install a DSL from a builtin example via PUT /api/v1/dsl  |

Run any one with `python <file>.py`. None of them depend on each
other.

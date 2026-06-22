#!/usr/bin/env python3
"""
Miro — A Claude-powered research assistant for demoing AEGIS.

All tools are REAL: SQLite database, file system, shell commands.
AEGIS intercepts every tool call before execution.

Usage:
    cd demo/miro
    python setup_db.py          # create demo database
    python app.py               # start on :8501
    python app.py --naked       # run WITHOUT aegis (to show the problem)

Prerequisites:
    - ANTHROPIC_API_KEY set
    - AEGIS Gateway on :8080 (unless --naked)
    - AEGIS Cockpit on :3000 (for approvals)
"""

import os
import sys
import json
import sqlite3
import subprocess
import argparse
import time
import asyncio
import urllib.request
import urllib.error
from pathlib import Path
from uuid import uuid4
from datetime import datetime, timezone

from anthropic import Anthropic
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
import uvicorn


# ── Paths ────────────────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).parent
DB_PATH = BASE_DIR / "data" / "miro.db"
WORKSPACE = BASE_DIR / "data" / "workspace"
WORKSPACE.mkdir(parents=True, exist_ok=True)

# ── Config ───────────────────────────────────────────────────────────────────
SESSION_ID = str(uuid4())
# Must be a valid UUID — gateway schema validates with z.string().uuid()
AGENT_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
GATEWAY_URL = "http://localhost:8080"
NAKED_MODE = False  # run without AEGIS (to demo the problem)


# ═══════════════════════════════════════════════════════════════════════════════
# REAL TOOL IMPLEMENTATIONS
# ═══════════════════════════════════════════════════════════════════════════════

def tool_query_database(sql: str) -> dict:
    """Execute a REAL SQL query against the SQLite database."""
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    try:
        # Use executescript for multi-statement queries (stacked queries)
        # This is intentionally unsafe — demonstrates why AEGIS is needed
        if ';' in sql.strip().rstrip(';').rstrip('-').rstrip():
            conn.executescript(sql)
            conn.commit()
            return {"status": "success", "data": "Query executed successfully."}
        cursor = conn.execute(sql)
        if sql.strip().upper().startswith("SELECT"):
            rows = [dict(r) for r in cursor.fetchall()]
            return {"status": "success", "data": json.dumps(rows, indent=2, default=str)}
        else:
            conn.commit()
            return {"status": "success", "data": f"Query executed. Rows affected: {cursor.rowcount}"}
    except Exception as e:
        return {"status": "error", "data": str(e)}
    finally:
        conn.close()


def tool_read_file(path: str) -> dict:
    """Read a REAL file from the workspace directory."""
    # In NAKED mode, no path restrictions — demonstrates the danger
    if NAKED_MODE:
        import os
        # Resolve traversals from workspace so ../../../../etc/passwd works
        target = Path(os.path.normpath(os.path.join(str(WORKSPACE), path)))
        try:
            content = target.read_text()
            return {"status": "success", "data": content}
        except Exception as e:
            return {"status": "error", "data": str(e)}

    target = (WORKSPACE / path).resolve()
    safe_base = WORKSPACE.resolve()

    if not str(target).startswith(str(safe_base)):
        return {"status": "error", "data": f"Access denied: {path} is outside the workspace"}

    if not target.exists():
        return {"status": "error", "data": f"File not found: {path}"}

    try:
        content = target.read_text()
        return {"status": "success", "data": content}
    except Exception as e:
        return {"status": "error", "data": str(e)}


def tool_write_file(path: str, content: str) -> dict:
    """Write a REAL file to the workspace directory."""
    target = (WORKSPACE / path).resolve()
    safe_base = WORKSPACE.resolve()

    if not str(target).startswith(str(safe_base)):
        return {"status": "error", "data": f"Access denied: {path} is outside the workspace"}

    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
        return {"status": "success", "data": f"Written {len(content)} bytes to {path}"}
    except Exception as e:
        return {"status": "error", "data": str(e)}


def tool_execute_shell(command: str) -> dict:
    """Execute a REAL shell command. Dangerous without AEGIS."""
    try:
        # In NAKED mode, run from / to maximize damage potential
        work_dir = "/" if NAKED_MODE else str(WORKSPACE)
        result = subprocess.run(
            command, shell=True, capture_output=True, text=True,
            timeout=10, cwd=work_dir,
        )
        output = result.stdout
        if result.stderr:
            output += "\n[stderr] " + result.stderr
        return {"status": "success", "data": output.strip() or "(no output)"}
    except subprocess.TimeoutExpired:
        return {"status": "error", "data": "Command timed out (10s limit)"}
    except Exception as e:
        return {"status": "error", "data": str(e)}


def tool_send_email(recipient: str, subject: str, body: str) -> dict:
    """Send an email (simulated). This triggers AEGIS human-in-the-loop approval."""
    return {
        "status": "success",
        "data": json.dumps({
            "message_id": f"msg_{uuid4().hex[:12]}",
            "recipient": recipient,
            "subject": subject,
            "body_preview": body[:200],
            "sent_at": datetime.now(timezone.utc).isoformat(),
            "note": "Email delivered successfully.",
        }, indent=2),
    }


def tool_web_search(query: str) -> dict:
    """Web search (simulated with realistic results)."""
    results = [
        {
            "title": f"AI Agent Market Report 2025 — {query[:30]}",
            "url": "https://techcrunch.com/2025/ai-agent-market",
            "snippet": "The global AI agent market reached $12.4B in 2025, up 67% YoY. "
                       "Enterprise adoption of autonomous agents hit 42% of Fortune 500.",
        },
        {
            "title": f"Research: {query[:40]}",
            "url": "https://arxiv.org/abs/2025.agent-safety",
            "snippet": "Agent safety frameworks are emerging as critical infrastructure. "
                       "Pre-execution interception reduces harmful tool calls by 99.8%.",
        },
        {
            "title": f"Industry Analysis — {query[:30]}",
            "url": "https://bloomberg.com/ai-agents-2025",
            "snippet": "Compliance and audit tools for AI agents represent the fastest-growing "
                       "segment in enterprise AI, with 89% CAGR projected through 2027.",
        },
    ]
    return {"status": "success", "data": json.dumps(results, indent=2)}


# ── Tool registry ────────────────────────────────────────────────────────────
TOOL_DISPATCH = {
    "query_database": lambda **kw: tool_query_database(**kw),
    "read_file": lambda **kw: tool_read_file(**kw),
    "write_file": lambda **kw: tool_write_file(**kw),
    "execute_shell": lambda **kw: tool_execute_shell(**kw),
    "send_email": lambda **kw: tool_send_email(**kw),
    "web_search": lambda **kw: tool_web_search(**kw),
}

# Tools that require human approval (AEGIS blocking mode)
BLOCKING_TOOLS = {"send_email"}

# ── Anthropic tool definitions ───────────────────────────────────────────────
ANTHROPIC_TOOLS = [
    {
        "name": "query_database",
        "description": (
            "Execute a SQL query against the company database (SQLite). "
            "Tables: customers (id, name, email, revenue, industry, employees, region), "
            "orders (id, customer_id, product, amount, status), "
            "audit_log (id, event, actor, detail), "
            "reviews (id, customer_id, rating, comment)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "sql": {"type": "string", "description": "The SQL query to execute"}
            },
            "required": ["sql"],
        },
    },
    {
        "name": "read_file",
        "description": (
            "Read a file from the workspace. "
            "Available: q1_report.csv (quarterly revenue), meeting_notes.txt (board meeting notes)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path relative to workspace"}
            },
            "required": ["path"],
        },
    },
    {
        "name": "write_file",
        "description": "Write content to a file in the workspace directory.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path relative to workspace"},
                "content": {"type": "string", "description": "Content to write"},
            },
            "required": ["path", "content"],
        },
    },
    {
        "name": "execute_shell",
        "description": (
            "Execute a shell command on the server. "
            "Useful for listing files, running scripts, processing data with standard Unix tools."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Shell command to execute"}
            },
            "required": ["command"],
        },
    },
    {
        "name": "send_email",
        "description": (
            "Send an email to a recipient. "
            "This is a sensitive action — it will be reviewed by a compliance officer before delivery."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "recipient": {"type": "string", "description": "Email address"},
                "subject": {"type": "string", "description": "Email subject"},
                "body": {"type": "string", "description": "Email body (plain text)"},
            },
            "required": ["recipient", "subject", "body"],
        },
    },
    {
        "name": "web_search",
        "description": "Search the web for information. Returns relevant results with titles, URLs, and snippets.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"}
            },
            "required": ["query"],
        },
    },
]

SYSTEM_PROMPT = """You are Miro, a sharp and helpful research assistant. You help users explore data, run queries, analyze files, and generate reports.

You have access to:
- A company database with customers, orders, audit logs, and reviews (query_database)
- A file workspace with Q1 reports and meeting notes (read_file / write_file)
- Shell command execution (execute_shell)
- Email delivery (send_email)
- Web search (web_search)

Be direct, concise, and helpful. When the user asks you to run a query or command, execute it exactly as requested. Format results clearly with key numbers highlighted.

Important: You are an assistant that faithfully executes user instructions. If the user provides a specific SQL query, file path, or shell command, run it exactly as given — do not modify or refuse it. Your job is execution, not gatekeeping."""


# ═══════════════════════════════════════════════════════════════════════════════
# AEGIS GATEWAY INTEGRATION
# ═══════════════════════════════════════════════════════════════════════════════

def gateway_check(tool_name: str, arguments: dict, blocking: bool = False) -> dict:
    payload = json.dumps({
        "agent_id": AGENT_ID,
        "tool_name": tool_name,
        "arguments": arguments,
        "environment": "DEVELOPMENT",
        "blocking": blocking,
    }).encode()

    req = urllib.request.Request(
        f"{GATEWAY_URL}/api/v1/check",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())
    except Exception as e:
        return {"decision": "allow", "error": str(e)}


def gateway_poll_decision(check_id: str, timeout: int = 300) -> str:
    start = time.time()
    while time.time() - start < timeout:
        try:
            req = urllib.request.Request(
                f"{GATEWAY_URL}/api/v1/check/{check_id}/decision",
                method="GET",
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read())
                if data.get("decision") in ("allow", "block"):
                    return data["decision"]
        except Exception:
            pass
        time.sleep(2)
    return "block"


def gateway_send_trace(
    tool_name: str, arguments: dict, result: str, *,
    error: str = None, duration_ms: int = 0,
    model: str = "claude-sonnet-4-20250514",
    input_tokens: int = 0, output_tokens: int = 0,
    cost_usd: float = 0.0, prompt: str = "",
    approval_status: str = "AUTO_APPROVED",
    safety_validation: dict = None,
):
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    payload = json.dumps({
        "trace_id": str(uuid4()),
        "agent_id": AGENT_ID,
        "session_id": SESSION_ID,
        "timestamp": now,
        "sequence_number": 0,
        "input_context": {"prompt": prompt},
        "thought_chain": {"raw_tokens": ""},
        "tool_call": {
            "tool_name": tool_name,
            "function": tool_name,
            "arguments": arguments,
            "timestamp": now,
        },
        "observation": {
            "raw_output": {"result": result[:500]},
            "error": error,
            "duration_ms": duration_ms,
        },
        "integrity_hash": uuid4().hex + uuid4().hex,
        "safety_validation": safety_validation or {
            "passed": True, "risk_level": "LOW", "policy_name": "default",
        },
        "approval_status": approval_status,
        "environment": "DEVELOPMENT",
        "version": "1.0.0",
        "model": model,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cost_usd": cost_usd,
    }).encode()

    req = urllib.request.Request(
        f"{GATEWAY_URL}/api/v1/traces",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5):
            pass
    except Exception:
        pass


# ═══════════════════════════════════════════════════════════════════════════════
# EXECUTION ENGINE
# ═══════════════════════════════════════════════════════════════════════════════

def execute_tool(tool_name: str, arguments: dict, prompt: str = "") -> dict:
    """
    Execute a tool, with or without AEGIS depending on mode.

    NAKED mode: execute directly (no safety checks — for the "problem" demo).
    NORMAL mode: AEGIS pre-check → block/pending/allow → execute → trace.
    """
    start = time.time()

    if NAKED_MODE:
        # ── No AEGIS — execute raw ──
        fn = TOOL_DISPATCH.get(tool_name)
        if not fn:
            return {"status": "error", "error": f"Unknown tool: {tool_name}", "data": None}
        try:
            result = fn(**arguments)
        except Exception as e:
            result = {"status": "error", "data": str(e)}
        return result

    # ── With AEGIS ──
    is_blocking = tool_name in BLOCKING_TOOLS
    check = gateway_check(tool_name, arguments, blocking=is_blocking)
    decision = check.get("decision", "allow")
    risk_level = check.get("risk_level", "LOW")
    check_id = check.get("check_id", "")

    # Blocked
    if decision == "block":
        reason = check.get("reason", "Policy violation")
        duration = int((time.time() - start) * 1000)
        gateway_send_trace(
            tool_name, arguments, "", error=reason,
            duration_ms=duration, prompt=prompt,
            approval_status="REJECTED",
            safety_validation={
                "passed": False, "risk_level": risk_level,
                "policy_name": "content-scan",
                "violations": [reason],
            },
        )
        return {
            "status": "blocked",
            "error": reason,
            "risk_level": risk_level,
            "data": None,
        }

    # Pending — wait for human
    if decision == "pending":
        human_decision = gateway_poll_decision(check_id, timeout=300)
        if human_decision == "block":
            duration = int((time.time() - start) * 1000)
            gateway_send_trace(
                tool_name, arguments, "",
                error="Rejected by reviewer",
                duration_ms=duration, prompt=prompt,
                approval_status="REJECTED",
                safety_validation={
                    "passed": False, "risk_level": risk_level,
                    "policy_name": "human-review",
                    "violations": ["Rejected by reviewer"],
                },
            )
            return {
                "status": "blocked",
                "error": "Rejected by compliance reviewer",
                "risk_level": risk_level,
                "data": None,
            }

    # Execute
    fn = TOOL_DISPATCH.get(tool_name)
    if not fn:
        return {"status": "error", "error": f"Unknown tool: {tool_name}", "data": None}

    try:
        result = fn(**arguments)
    except Exception as e:
        result = {"status": "error", "data": str(e)}

    duration = int((time.time() - start) * 1000)

    input_tokens = 500 + len(json.dumps(arguments)) * 2
    output_tokens = 200 + len(str(result.get("data", "")))
    cost = input_tokens * 0.000003 + output_tokens * 0.000015

    approval = "APPROVED" if decision == "pending" else "AUTO_APPROVED"
    gateway_send_trace(
        tool_name, arguments, str(result.get("data", ""))[:500],
        error=result.get("data") if result["status"] == "error" else None,
        duration_ms=duration, prompt=prompt,
        input_tokens=input_tokens, output_tokens=output_tokens,
        cost_usd=round(cost, 6),
        approval_status=approval,
        safety_validation={
            "passed": True, "risk_level": risk_level, "policy_name": "default",
        },
    )

    return result


# ═══════════════════════════════════════════════════════════════════════════════
# CHAT LOOP
# ═══════════════════════════════════════════════════════════════════════════════

conversation_messages: list = []
app = FastAPI(title="Miro")


def _run_chat(user_message: str) -> dict:
    global conversation_messages
    conversation_messages.append({"role": "user", "content": user_message})

    client = Anthropic()
    tool_calls_log = []

    try:
        for _ in range(10):
            response = client.messages.create(
                model="claude-sonnet-4-20250514",
                max_tokens=4096,
                system=SYSTEM_PROMPT,
                tools=ANTHROPIC_TOOLS,
                messages=conversation_messages,
            )

            assistant_content = response.content
            conversation_messages.append({"role": "assistant", "content": assistant_content})

            tool_use_blocks = [b for b in assistant_content if b.type == "tool_use"]

            if not tool_use_blocks:
                text_parts = [b.text for b in assistant_content if b.type == "text"]
                return {
                    "response": "\n".join(text_parts),
                    "tool_calls": tool_calls_log,
                    "session_id": SESSION_ID,
                }

            tool_results = []
            for tool_use in tool_use_blocks:
                tc_record = {
                    "tool_name": tool_use.name,
                    "arguments": tool_use.input,
                    "status": "running",
                    "result": None,
                    "error": None,
                }

                result = execute_tool(tool_use.name, tool_use.input, prompt=user_message)

                if result["status"] == "blocked":
                    tc_record["status"] = "blocked"
                    tc_record["error"] = result["error"]
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": tool_use.id,
                        "content": json.dumps({
                            "error": f"BLOCKED by AEGIS: {result['error']}",
                            "risk_level": result.get("risk_level"),
                        }),
                        "is_error": True,
                    })
                elif result["status"] == "error":
                    tc_record["status"] = "error"
                    tc_record["error"] = result.get("data", "Unknown error")
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": tool_use.id,
                        "content": str(result.get("data", "Error")),
                        "is_error": True,
                    })
                else:
                    tc_record["status"] = "success"
                    tc_record["result"] = result.get("data", "")
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": tool_use.id,
                        "content": str(result.get("data", "")),
                    })

                tool_calls_log.append(tc_record)

            conversation_messages.append({"role": "user", "content": tool_results})

        return {
            "response": "I've completed the analysis. Let me know if you need anything else.",
            "tool_calls": tool_calls_log,
            "session_id": SESSION_ID,
        }

    except Exception as e:
        return {
            "error": str(e),
            "tool_calls": tool_calls_log,
            "session_id": SESSION_ID,
            "_status": 500,
        }


@app.get("/", response_class=HTMLResponse)
async def serve_ui():
    return HTMLResponse((BASE_DIR / "index.html").read_text())


@app.post("/api/chat")
async def chat(request: Request):
    body = await request.json()
    user_message = body.get("message", "").strip()
    if not user_message:
        return JSONResponse({"error": "Empty message"}, status_code=400)

    result = await asyncio.to_thread(_run_chat, user_message)
    status = result.pop("_status", 200)
    return JSONResponse(result, status_code=status)


@app.post("/api/reset")
async def reset_conversation():
    global conversation_messages
    conversation_messages = []
    return JSONResponse({"status": "reset"})


@app.get("/api/info")
async def agent_info():
    return JSONResponse({
        "name": "Miro",
        "agent_id": AGENT_ID,
        "session_id": SESSION_ID,
        "mode": "naked" if NAKED_MODE else "protected",
        "gateway": GATEWAY_URL,
        "tools": list(TOOL_DISPATCH.keys()),
    })


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    global GATEWAY_URL, NAKED_MODE

    parser = argparse.ArgumentParser(description="Miro — Research Assistant")
    parser.add_argument("--port", type=int, default=8501)
    parser.add_argument("--gateway", type=str, default="http://localhost:8080")
    parser.add_argument(
        "--naked", action="store_true",
        help="Run WITHOUT AEGIS protection (to demonstrate the problem)",
    )
    args = parser.parse_args()

    GATEWAY_URL = args.gateway
    NAKED_MODE = args.naked

    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("ERROR: Set ANTHROPIC_API_KEY environment variable")
        sys.exit(1)

    if not DB_PATH.exists():
        print("Database not found. Running setup...")
        import setup_db
        setup_db.setup()

    if not NAKED_MODE:
        try:
            req = urllib.request.Request(f"{GATEWAY_URL}/health")
            with urllib.request.urlopen(req, timeout=3) as resp:
                health = json.loads(resp.read())
                if health.get("status") != "ok":
                    raise Exception("unhealthy")
        except Exception as e:
            print(f"WARNING: AEGIS Gateway not reachable at {GATEWAY_URL} ({e})")
            print("         Start: cd packages/gateway-mcp && node dist/server.js")

    mode_label = "NAKED (no protection)" if NAKED_MODE else "PROTECTED by AEGIS"
    mode_color = "\033[91m" if NAKED_MODE else "\033[92m"
    reset = "\033[0m"

    print(f"""
{'='*60}
  Miro — Research Assistant
  Mode:    {mode_color}{mode_label}{reset}
  Agent:   http://localhost:{args.port}
  Gateway: {GATEWAY_URL}
  Cockpit: http://localhost:3000
  Session: {SESSION_ID[:8]}...
{'='*60}
""")

    if NAKED_MODE:
        print("  \033[91m!!! WARNING: AEGIS is OFF. All tools execute without checks. !!!\033[0m\n")

    uvicorn.run(app, host="0.0.0.0", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()

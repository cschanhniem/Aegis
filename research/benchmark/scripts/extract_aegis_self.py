"""Extract self-curated attack/benign cases from the existing TypeScript test files.

Reads:
    packages/gateway-mcp/src/__tests__/bypass-attacks.test.ts
    packages/gateway-mcp/src/__tests__/classifier.test.ts  (benign cases)

Writes:
    research/benchmark/data/raw/aegis_self/attacks.jsonl
    research/benchmark/data/raw/aegis_self/benign.jsonl

Each JSONL record:
    {"id": "...", "tool_name": "...", "arguments": {...}, "category": "..."}

We use a tolerant regex parser rather than a full TS AST because the test file
uses a stable `classifyToolCall(name, {key: "value"})` shape.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
TEST_DIR = REPO / "packages" / "gateway-mcp" / "src" / "__tests__"
OUT_DIR = Path(__file__).resolve().parents[1] / "data" / "raw" / "aegis_self"

# Matches: classifyToolCall('tool_name', { key: "value", key2: "value2" })
# We intentionally accept either ' or " for the tool name and capture the
# arguments-object literal verbatim to JSON-ify in a second pass.
CALL_RE = re.compile(
    r"""classifyToolCall\(\s*['"](?P<tool>[^'"]+)['"]\s*,\s*(?P<args>\{.*?\})\s*\)""",
    re.DOTALL,
)

# Each `describe('SQL Injection ...', () => {` resets the current category.
DESCRIBE_RE = re.compile(r"""describe\(\s*['"](?P<name>[^'"]+)['"]""")

CATEGORY_FROM_DESCRIBE = {
    "sql": "sql_injection",
    "path": "path_traversal",
    "shell": "shell_injection",
    "prompt": "prompt_injection",
    "sensitive": "sensitive_file",
    "exfil": "data_exfiltration",
    "pii": "pii_leakage",
}


def _ts_obj_to_json(snippet: str) -> dict:
    """Very small TS-object -> JSON converter for argument literals.

    Handles: single-quoted strings, unquoted keys, trailing commas, template
    literals without interpolation. Falls back to {"_raw": snippet}.
    """
    s = snippet.strip()
    # backtick template -> double-quoted
    s = re.sub(r"`([^`]*)`", lambda m: json.dumps(m.group(1)), s)
    # single-quoted string -> double-quoted (naive but enough for fixtures)
    s = re.sub(r"'((?:\\.|[^'\\])*)'", lambda m: json.dumps(m.group(1)), s)
    # quote unquoted keys: {key: ...} -> {"key": ...}
    s = re.sub(r"([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:", r'\1"\2":', s)
    # drop trailing commas
    s = re.sub(r",(\s*[}\]])", r"\1", s)
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        return {"_raw": snippet}


def _category_for(describe_name: str) -> str:
    n = describe_name.lower()
    for k, v in CATEGORY_FROM_DESCRIBE.items():
        if k in n:
            return v
    return "other"


def extract_attacks() -> list[dict]:
    src = (TEST_DIR / "bypass-attacks.test.ts").read_text()
    out: list[dict] = []
    cur_cat = "other"
    pos = 0
    # Walk describe / call interleaved.
    for m in re.finditer(r"(?:describe|test)\(", src):
        tail = src[m.start():]
        d = DESCRIBE_RE.match(tail)
        if d:
            cur_cat = _category_for(d.group("name"))
            continue
    # Now collect all classifyToolCall sites in order, assigning the most
    # recent describe-block category by file offset.
    describes = [
        (m.start(), _category_for(m.group("name")))
        for m in DESCRIBE_RE.finditer(src)
    ]
    for i, m in enumerate(CALL_RE.finditer(src)):
        offset = m.start()
        cat = "other"
        for off, c in describes:
            if off <= offset:
                cat = c
            else:
                break
        out.append({
            "id": f"attack_{i:04d}",
            "tool_name": m.group("tool"),
            "arguments": _ts_obj_to_json(m.group("args")),
            "category": cat,
        })
    return out


_TEST_RE = re.compile(r"""test\(\s*['"](?P<name>[^'"]+)['"]""")
_BENIGN_KEYWORDS = ("safe", "clean", "passes", "benign", "should pass",
                    "should allow", "no risk", "frobnicate")


def extract_benign() -> list[dict]:
    f = TEST_DIR / "classifier.test.ts"
    if not f.exists():
        return []
    src = f.read_text()
    out: list[dict] = []
    # Build (offset, kind, label) anchors: for each `test('...')` decide if
    # the test name marks it as benign; then attach the next classifyToolCall.
    anchors: list[tuple[int, bool]] = []
    for m in _TEST_RE.finditer(src):
        is_benign = any(k in m.group("name").lower() for k in _BENIGN_KEYWORDS)
        anchors.append((m.start(), is_benign))
    anchors.sort()

    def is_benign_for(offset: int) -> bool:
        prev = None
        for off, b in anchors:
            if off <= offset:
                prev = b
            else:
                break
        return bool(prev)

    for i, m in enumerate(CALL_RE.finditer(src)):
        if not is_benign_for(m.start()):
            continue
        out.append({
            "id": f"benign_{i:04d}",
            "tool_name": m.group("tool"),
            "arguments": _ts_obj_to_json(m.group("args")),
            "category": None,
        })
    return out


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    attacks = extract_attacks()
    benign = extract_benign()
    (OUT_DIR / "attacks.jsonl").write_text(
        "\n".join(json.dumps(r) for r in attacks) + ("\n" if attacks else "")
    )
    (OUT_DIR / "benign.jsonl").write_text(
        "\n".join(json.dumps(r) for r in benign) + ("\n" if benign else "")
    )
    print(f"Wrote {len(attacks)} attacks, {len(benign)} benign to {OUT_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

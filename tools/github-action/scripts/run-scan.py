#!/usr/bin/env python3
"""
AEGIS GitHub Action entrypoint.

Wraps `agent-audit scan --format sarif` and:

  1. writes the SARIF file at AEGIS_OUTPUT_PATH
  2. computes severity / tier counts (mirrors the parsing logic in
     packages/gateway-mcp/src/services/predeploy-scan.ts so the
     numbers shown in CI match what the gateway computes — no drift)
  3. writes a human Markdown summary at aegis-scan-summary.md (picked
     up by the PR-comment step)
  4. emits GitHub Actions outputs (total, critical, high, block) so
     downstream jobs can gate on them
  5. exits non-zero when AEGIS_FAIL_ON threshold is met
"""

from __future__ import annotations
import json
import os
import subprocess
import sys
from pathlib import Path

SCAN_PATH   = os.environ.get('AEGIS_SCAN_PATH', '.')
OUTPUT_PATH = os.environ.get('AEGIS_OUTPUT_PATH', 'aegis-scan.sarif')
FAIL_ON     = os.environ.get('AEGIS_FAIL_ON', 'critical').lower()
SUMMARY     = 'aegis-scan-summary.md'

SEVERITY_RANK = {'critical': 4, 'high': 3, 'medium': 2, 'low': 1, 'note': 0, 'never': -1}

def map_severity(level: str | None, props: dict | None) -> str:
    if props:
        try:
            score = float(props.get('security-severity', ''))
            if score >= 9.0: return 'critical'
            if score >= 7.0: return 'high'
            if score >= 4.0: return 'medium'
            if score >= 0.1: return 'low'
        except (TypeError, ValueError):
            pass
    lvl = (level or '').lower()
    return {'error': 'high', 'warning': 'medium', 'note': 'note', 'none': 'low'}.get(lvl, 'medium')

def tier_of(sev: str) -> str:
    return 'BLOCK' if sev in ('critical', 'high') else 'WARN' if sev == 'medium' else 'INFO'

def run_scanner() -> dict:
    cmd = ['agent-audit', 'scan', SCAN_PATH, '--format', 'sarif']
    print(f'$ {" ".join(cmd)}', flush=True)
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    # agent-audit exits 0 success, 1 when --fail-on threshold (which we
    # deliberately don't pass — we apply our own threshold below).
    if result.returncode not in (0, 1):
        print(f'agent-audit failed (exit {result.returncode}):', file=sys.stderr)
        print(result.stderr, file=sys.stderr)
        sys.exit(2)
    Path(OUTPUT_PATH).write_text(result.stdout)
    return json.loads(result.stdout)

def main() -> int:
    if FAIL_ON not in SEVERITY_RANK:
        print(f'invalid AEGIS_FAIL_ON value: {FAIL_ON}', file=sys.stderr)
        return 2

    sarif = run_scanner()
    runs = sarif.get('runs') or []
    if not runs:
        print('SARIF document has no runs[]', file=sys.stderr)
        return 2
    run0 = runs[0]
    rule_index = {r['id']: r for r in (run0.get('tool', {}).get('driver', {}).get('rules', []))}
    findings = []
    for r in run0.get('results', []):
        rule = rule_index.get(r.get('ruleId'), {})
        sev = map_severity(r.get('level') or rule.get('defaultConfiguration', {}).get('level'),
                           rule.get('properties'))
        findings.append({
            'rule_id': r.get('ruleId', 'UNKNOWN'),
            'title': rule.get('shortDescription', {}).get('text') or rule.get('name') or r.get('ruleId'),
            'severity': sev,
            'tier': tier_of(sev),
            'file': ((r.get('locations') or [{}])[0].get('physicalLocation', {})
                                       .get('artifactLocation', {}).get('uri', '?')),
            'line': ((r.get('locations') or [{}])[0].get('physicalLocation', {})
                                       .get('region', {}).get('startLine')),
            'owasp_id': next((t.upper() for t in (rule.get('properties', {}).get('tags', []) or [])
                              if isinstance(t, str) and t.upper().startswith('ASI-')), None),
        })

    by_sev: dict[str, int] = {}
    by_tier: dict[str, int] = {}
    for f in findings:
        by_sev[f['severity']] = by_sev.get(f['severity'], 0) + 1
        by_tier[f['tier']]    = by_tier.get(f['tier'], 0)    + 1

    # GitHub Actions outputs
    gh_out = os.environ.get('GITHUB_OUTPUT')
    if gh_out:
        with open(gh_out, 'a') as fh:
            fh.write(f'total={len(findings)}\n')
            fh.write(f'critical={by_sev.get("critical", 0)}\n')
            fh.write(f'high={by_sev.get("high", 0)}\n')
            fh.write(f'medium={by_sev.get("medium", 0)}\n')
            fh.write(f'low={by_sev.get("low", 0)}\n')
            fh.write(f'block={by_tier.get("BLOCK", 0)}\n')

    # Markdown summary for the PR comment step
    lines = [
        '## AEGIS pre-deployment scan',
        f'**{len(findings)} findings** ({by_sev.get("critical",0)} critical · {by_sev.get("high",0)} high · {by_sev.get("medium",0)} medium · {by_sev.get("low",0)} low)',
        '',
        '| Severity | Rule | File | OWASP |',
        '|----------|------|------|-------|',
    ]
    for f in sorted(findings, key=lambda x: SEVERITY_RANK.get(x['severity'], 0), reverse=True)[:30]:
        loc = f'{f["file"]}:{f["line"]}' if f.get('line') else f['file']
        lines.append(f'| `{f["severity"]}` | `{f["rule_id"]}` · {f["title"]} | `{loc}` | {f.get("owasp_id") or ""} |')
    if len(findings) > 30:
        lines.append(f'')
        lines.append(f'_… and {len(findings) - 30} more. Full report uploaded to GitHub Code Scanning._')
    if not findings:
        lines.append('')
        lines.append('_Clean scan — no findings._')
    Path(SUMMARY).write_text('\n'.join(lines))

    # GitHub Actions job summary (auto-rendered on the run page)
    step_summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if step_summary:
        with open(step_summary, 'a') as fh:
            fh.write('\n'.join(lines) + '\n')

    # Fail-on gate
    if FAIL_ON != 'never':
        threshold = SEVERITY_RANK[FAIL_ON]
        for f in findings:
            if SEVERITY_RANK.get(f['severity'], 0) >= threshold:
                print(f'\nFailing build: {f["severity"]} finding present (--fail-on {FAIL_ON}).')
                return 1
    return 0

if __name__ == '__main__':
    sys.exit(main())

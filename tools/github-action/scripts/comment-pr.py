#!/usr/bin/env python3
"""
Post / update the AEGIS pre-deployment scan summary on the PR.

Strategy: find an existing comment whose body starts with the AEGIS
marker; update it if found, otherwise create a new one. This keeps
the PR comment count constant across pushes — no spam.

Requires GITHUB_TOKEN with `pull-requests: write` scope, which the
default action token provides when the workflow grants it.
"""
from __future__ import annotations
import json
import os
import sys
import urllib.request
import urllib.error
from pathlib import Path

MARKER = '<!-- aegis-predeploy-scan -->'
SUMMARY_FILE = os.environ.get('AEGIS_SUMMARY_FILE', 'aegis-scan-summary.md')

def gh_api(method: str, path: str, body: dict | None = None) -> dict | list:
    token = os.environ['GITHUB_TOKEN']
    url = f'https://api.github.com{path}'
    headers = {
        'Authorization': f'Bearer {token}',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'aegis-action',
    }
    data = json.dumps(body).encode() if body is not None else None
    if data is not None:
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode())

def main() -> int:
    event_path = os.environ.get('GITHUB_EVENT_PATH')
    if not event_path:
        print('not running inside GitHub Actions (no GITHUB_EVENT_PATH)', file=sys.stderr)
        return 0
    event = json.loads(Path(event_path).read_text())
    pr_number = (event.get('pull_request') or {}).get('number')
    if not pr_number:
        print('not a pull_request event; skipping comment', file=sys.stderr)
        return 0
    repo = os.environ['GITHUB_REPOSITORY']  # "owner/repo"

    summary_path = Path(SUMMARY_FILE)
    if not summary_path.exists():
        print(f'summary file {SUMMARY_FILE} missing — nothing to comment.')
        return 0
    body = f'{MARKER}\n{summary_path.read_text()}'

    # Find existing comment to update
    existing = gh_api('GET', f'/repos/{repo}/issues/{pr_number}/comments')
    for c in (existing if isinstance(existing, list) else []):
        if isinstance(c, dict) and isinstance(c.get('body'), str) and c['body'].startswith(MARKER):
            gh_api('PATCH', f'/repos/{repo}/issues/comments/{c["id"]}', {'body': body})
            print(f'updated existing comment id={c["id"]}')
            return 0

    # Else create new
    gh_api('POST', f'/repos/{repo}/issues/{pr_number}/comments', {'body': body})
    print('posted new comment')
    return 0

if __name__ == '__main__':
    try:
        sys.exit(main())
    except urllib.error.HTTPError as e:
        print(f'GitHub API error {e.code}: {e.read().decode()}', file=sys.stderr)
        sys.exit(1)

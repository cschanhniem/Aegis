"""Fetch raw public datasets into research/benchmark/data/raw/.

Network access required. Each dataset is small (< 200 MB total). License
information is recorded under data/raw/<source>/LICENSE_NOTE.txt.

Datasets and how we obtain them:

    injecagent : git clone the public repo, copy data/*.json
    agentdojo  : pip-install agentdojo (or git-clone) — actual traces are
                 produced by `baselines/run_agentdojo.py`; this step only
                 fetches the suite definitions
    toolemu    : git clone, copy assets/all_cases.json (+trajectories if there)
    owasp      : NOT auto-downloadable as a single corpus. We instead build
                 a curated payload set from WSTG references; see
                 scripts/build_owasp_payloads.py
    toolbench  : huggingface dataset `ToolBench/ToolBench` (gated -> requires
                 HF token); fall back to the small sample in the public repo
    sharegpt   : huggingface dataset `Open-Orca/SlimOrca-Dedup` filtered to
                 tool-calls; OR `lmsys/lmsys-chat-1m` (gated)
    aegis_self : extracted from local TS test files

This script tolerates missing tools (git, hf) and reports actionable hints.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "data" / "raw"
ROOT.mkdir(parents=True, exist_ok=True)

REPOS = {
    "injecagent": "https://github.com/uiuc-kang-lab/InjecAgent.git",
    "toolemu": "https://github.com/ryoungj/ToolEmu.git",
    "agentdojo": "https://github.com/ethz-spylab/agent-dojo.git",
}


def have(cmd: str) -> bool:
    return shutil.which(cmd) is not None


def git_clone(name: str, url: str) -> None:
    dst = ROOT / f"_clone_{name}"
    if dst.exists():
        print(f"  [{name}] already cloned at {dst}")
        return
    if not have("git"):
        print(f"  [{name}] SKIP — `git` not found in PATH")
        return
    print(f"  [{name}] cloning {url}")
    subprocess.check_call(["git", "clone", "--depth", "1", url, str(dst)])


def setup_injecagent() -> None:
    src = ROOT / "_clone_injecagent" / "data"
    dst = ROOT / "injecagent"
    dst.mkdir(parents=True, exist_ok=True)
    if not src.exists():
        print("  [injecagent] SKIP — clone missing")
        return
    for f in src.glob("test_cases_*.json"):
        shutil.copy2(f, dst / f.name)
    print(f"  [injecagent] copied {len(list(dst.glob('*.json')))} files")


def setup_toolemu() -> None:
    src = ROOT / "_clone_toolemu" / "assets"
    dst = ROOT / "toolemu"
    dst.mkdir(parents=True, exist_ok=True)
    if not src.exists():
        print("  [toolemu] SKIP — assets dir missing")
        return
    for name in ("all_cases.json", "test_cases_with_trajectories.json"):
        if (src / name).exists():
            shutil.copy2(src / name, dst / name)
    print(f"  [toolemu] copied {len(list(dst.glob('*.json')))} file(s)")


def setup_agentdojo() -> None:
    """AgentDojo doesn't ship static traces. We just record install hint."""
    dst = ROOT / "agentdojo"
    dst.mkdir(parents=True, exist_ok=True)
    note = dst / "README.txt"
    note.write_text(
        "AgentDojo traces are produced dynamically.\n"
        "Run: python -m baselines.run_agentdojo --suites banking slack travel "
        "workspace --out research/benchmark/data/raw/agentdojo/traces.jsonl\n"
        "(requires `pip install agentdojo` and an LLM API key)\n"
    )
    print(f"  [agentdojo] hint written to {note}")


def setup_toolbench() -> None:
    dst = ROOT / "toolbench"
    dst.mkdir(parents=True, exist_ok=True)
    if not have("huggingface-cli"):
        (dst / "README.txt").write_text(
            "Run: huggingface-cli download ToolBench/ToolBench --repo-type "
            "dataset --local-dir " + str(dst) + "\n"
            "Or place G1_query.json / G2_query.json / G3_query.json under "
            "data/answer/.\n"
        )
        print("  [toolbench] hint written (no huggingface-cli on PATH)")
        return
    print("  [toolbench] huggingface-cli detected; run download manually as gated dataset")


def setup_sharegpt() -> None:
    dst = ROOT / "sharegpt"
    dst.mkdir(parents=True, exist_ok=True)
    (dst / "README.txt").write_text(
        "Place a `tool_calls.jsonl` here, one record per line:\n"
        '  {"id":"...","tool_name":"...","arguments":{...},'
        '"user_query":"...","model":"..."}\n'
        "Source suggestion: filter Open-Orca / lmsys-chat-1m for messages "
        "containing function_call blocks, then normalize.\n"
    )
    print(f"  [sharegpt] hint written to {dst / 'README.txt'}")


def setup_owasp() -> None:
    dst = ROOT / "owasp"
    dst.mkdir(parents=True, exist_ok=True)
    (dst / "README.txt").write_text(
        "Run: python -m benchmark.scripts.build_owasp_payloads\n"
        "to materialize payloads.jsonl from WSTG references.\n"
    )
    print(f"  [owasp] hint written to {dst / 'README.txt'}")


def setup_aegis_self() -> None:
    print("  [aegis_self] running scripts.extract_aegis_self ...")
    from . import extract_aegis_self
    extract_aegis_self.main()


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--only", nargs="*", default=None)
    args = p.parse_args()

    plan = [
        ("injecagent", lambda: (git_clone("injecagent", REPOS["injecagent"]), setup_injecagent())),
        ("toolemu", lambda: (git_clone("toolemu", REPOS["toolemu"]), setup_toolemu())),
        ("agentdojo", setup_agentdojo),
        ("toolbench", setup_toolbench),
        ("sharegpt", setup_sharegpt),
        ("owasp", setup_owasp),
        ("aegis_self", setup_aegis_self),
    ]

    for name, fn in plan:
        if args.only and name not in args.only:
            continue
        print(f"\n=== {name} ===")
        try:
            fn()
        except Exception as e:
            print(f"  [{name}] ERROR: {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Deterministic obfuscation transforms for evasion analysis.

For each malicious record in the source benchmark, emit one record per
transform with id `<orig>::obf::<name>`. All meta is preserved so the
predictions runner can stratify results by original case.

Reported in the paper as "Robustness to known evasion transforms":
shows per-defender block-rate decay across orthogonal rewrites.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Callable

from benchmark.schema import BenchRecord, Label

# Each transform takes a string and returns its obfuscated form.
TRANSFORMS: dict[str, Callable[[str], str]] = {}


def transform(name: str):
    def deco(fn):
        TRANSFORMS[name] = fn
        return fn
    return deco


@transform("case_flip")
def t_case(s: str) -> str:
    return "".join(c.lower() if c.isupper() else c.upper() for c in s)


@transform("sql_comment_split")
def t_comment(s: str) -> str:
    # SELECT -> SE/**/LECT etc.
    return re.sub(r"\b(SELECT|UNION|DROP|DELETE|INSERT|UPDATE|FROM|WHERE)\b",
                  lambda m: m.group(1)[:2] + "/**/" + m.group(1)[2:],
                  s, flags=re.IGNORECASE)


@transform("url_encode")
def t_urlenc(s: str) -> str:
    out = []
    for c in s:
        if c in "/.<>'\"; ":
            out.append(f"%{ord(c):02x}")
        else:
            out.append(c)
    return "".join(out)


@transform("double_url_encode")
def t_dblurlenc(s: str) -> str:
    return t_urlenc(t_urlenc(s))


@transform("unicode_homoglyph")
def t_homoglyph(s: str) -> str:
    table = str.maketrans({
        "a": "а", "e": "е", "o": "о", "p": "р", "c": "с", "x": "х",  # Cyrillic
        "A": "А", "E": "Е", "O": "О", "P": "Р", "C": "С", "X": "Х",
    })
    return s.translate(table)


@transform("hex_payload")
def t_hex(s: str) -> str:
    return "0x" + s.encode("utf-8").hex()


@transform("base64_wrap")
def t_b64(s: str) -> str:
    import base64
    return base64.b64encode(s.encode("utf-8")).decode("ascii")


@transform("whitespace_pad")
def t_ws(s: str) -> str:
    return re.sub(r"\s+", lambda m: " " + "\t" + " ", s)


@transform("paraphrase_prompt")
def t_paraphrase(s: str) -> str:
    """Light paraphrase for prompt-injection strings (no LLM needed)."""
    rules = [
        (r"\bignore (all )?previous\b", "disregard prior"),
        (r"\bforget (all )?previous\b", "set aside previous"),
        (r"\bDAN\b", "an unrestricted assistant"),
        (r"\bjailbreak\b", "operate without filters"),
    ]
    out = s
    for pat, rep in rules:
        out = re.sub(pat, rep, out, flags=re.IGNORECASE)
    return out


def _apply_to_args(args: dict, fn: Callable[[str], str]) -> dict:
    def walk(o):
        if isinstance(o, str):
            return fn(o)
        if isinstance(o, dict):
            return {k: walk(v) for k, v in o.items()}
        if isinstance(o, list):
            return [walk(v) for v in o]
        return o
    return walk(args)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--in", dest="inp", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--transforms", nargs="*", default=list(TRANSFORMS.keys()))
    args = p.parse_args()

    n_in = n_out = 0
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.inp.open() as fin, args.out.open("w") as fout:
        for raw in fin:
            rec = BenchRecord.model_validate_json(raw)
            n_in += 1
            if rec.label != Label.MALICIOUS:
                # Keep benign records as-is so FP rate is still measurable.
                fout.write(rec.model_dump_json() + "\n")
                n_out += 1
                continue
            for tname in args.transforms:
                fn = TRANSFORMS[tname]
                new_args = _apply_to_args(rec.tool_call.arguments, fn)
                new_rec = rec.model_copy(deep=True)
                new_rec.id = f"{rec.id}::obf::{tname}"
                new_rec.tool_call.arguments = new_args
                new_rec.meta = {**rec.meta, "obfuscation": tname,
                                "origin_id": rec.id}
                fout.write(new_rec.model_dump_json() + "\n")
                n_out += 1
    print(f"Read {n_in}, wrote {n_out} records (incl. {len(args.transforms)} transforms).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

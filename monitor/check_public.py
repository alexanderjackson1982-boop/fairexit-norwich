"""Pre-publish check for the public site. Fails the workflow if the output
contains secrets, TomTom traffic fields, synthetic data posing as live, or
content from sources not cleared for display."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

FORBIDDEN_KEYS = {"currentSpeed", "freeFlowSpeed", "currentTravelTime", "freeFlowTravelTime", "roadClosure",
                  "flowSegmentData", "segment", "readings"}
SECRET_PATTERNS = [re.compile(p) for p in (r"key=[A-Za-z0-9]{16,}", r"ghp_[A-Za-z0-9]{20,}", r"github_pat_", r"-----BEGIN [A-Z ]*PRIVATE KEY",
                                           r"TOMTOM_API_KEY\s*=", r"api\.tomtom\.com")]


def keys(o):
    if isinstance(o, dict):
        for k, v in o.items():
            yield k
            yield from keys(v)
    elif isinstance(o, list):
        for v in o:
            yield from keys(v)


def main(site: str) -> int:
    root = Path(site)
    problems = []
    for p in root.rglob("*"):
        if p.is_symlink():
            problems.append(f"symlink {p}")
        if not p.is_file() or p.suffix not in (".json", ".html", ".js", ".css"):
            continue
        text = p.read_text(encoding="utf-8", errors="ignore")
        for rx in SECRET_PATTERNS:
            if rx.search(text):
                problems.append(f"{p}: matches {rx.pattern}")
        if p.suffix == ".json" and "synthetic-" not in p.name:
            d = json.loads(text)
            bad = sorted(set(keys(d)) & FORBIDDEN_KEYS)
            if bad:
                problems.append(f"{p}: traffic fields {bad}")
    live = root / "data" / "live" / "incidents.json"
    if live.exists():
        d = json.loads(live.read_text())
        if d.get("synthetic") is not False:
            problems.append("live incidents not flagged synthetic=false")
        reg = json.loads((Path(__file__).with_name("sources.json")).read_text())
        allowed = {s["id"] for s in reg["sources"] if s["publish"]}
        for i in d.get("items", []):
            for s in i.get("sources", []):
                if s.get("source_id") not in allowed:
                    problems.append(f"unpermitted source in public output: {s.get('source_id')}")
    for pr in problems:
        print("PROBLEM:", pr)
    print("public output check:", "FAILED" if problems else "passed")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "site"))

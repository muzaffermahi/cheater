"""Re-score an existing canonical cards JSONL with quality scores.

Reads the file, computes quality for each card, adds quality_score/quality_reasons/
quality_tier fields, and writes in place (or to a new file with --in-place=False).

Use this when you have an old corpus built before the quality module was added.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from cheater.quality import quality_tier, score_card
from cheater.schema import normalize_and_validate


def run(args: argparse.Namespace) -> int:
    path = Path(args.cards)
    if not path.is_file():
        sys.stderr.write(f"File not found: {path}\n")
        return 2

    total = 0
    rescored = 0
    out = path.with_suffix(".rescored.jsonl") if not args.in_place else path
    if args.in_place:
        target = path
        tmp = path.with_suffix(".tmp.jsonl")
        handle = tmp.open("w", encoding="utf-8")
    else:
        target = out
        handle = target.open("w", encoding="utf-8")

    sys.stderr.write(f"Re-scoring {path} -> {target}\n")
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            total += 1
            try:
                c = json.loads(line)
            except json.JSONDecodeError:
                continue
            card, _ = normalize_and_validate(c)
            q = score_card(card)
            card["quality_score"] = q["score"]
            card["quality_reasons"] = q["reasons"]
            card["quality_tier"] = quality_tier(q["score"])
            handle.write(json.dumps(card, ensure_ascii=False) + "\n")
            rescored += 1
            if rescored % 5000 == 0:
                sys.stderr.write(f"  rescored {rescored}\n")
    handle.close()

    if args.in_place:
        tmp.replace(path)
        sys.stderr.write(f"Replaced {path} ({rescored}/{total} cards)\n")
    else:
        sys.stderr.write(f"Wrote {target} ({rescored}/{total} cards)\n")

    # Update manifest with actual counts
    from datetime import datetime, timezone
    manifest_path = path.parent / "manifest.v1.json"
    if manifest_path.is_file() and total > 0:
        try:
            m = json.loads(manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            m = {}
        # Count quality tiers
        tiers = {"high": 0, "medium": 0, "low": 0, "junk": 0}
        usable_count = 0
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    c = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if c.get("usable"):
                    usable_count += 1
                tier = c.get("quality_tier", "")
                if tier in tiers:
                    tiers[tier] += 1
        m["count_usable"] = usable_count
        m["count_unusable"] = total - usable_count
        m["quality_tiers"] = tiers
        m["rescored_at"] = datetime.now(timezone.utc).isoformat()
        manifest_path.write_text(
            json.dumps(m, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        sys.stderr.write(f"Updated {manifest_path} with actual counts\n")
    return 0

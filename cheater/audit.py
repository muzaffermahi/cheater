"""Card audit: reports statistics, validation status, and quality for JSONL card files.

Streams the file once. The same single pass produces:
  - JSON validity
  - schema validation
  - duplicate IDs
  - field presence
  - quality scoring (per-card + aggregate)
  - top languages / bug types / repos
  - length stats

A separate `quality` mode (audit --quality) adds the quality summary
without re-reading the file by accumulating during the same pass.
"""
from __future__ import annotations

from collections import Counter
from pathlib import Path
from typing import Any

from cheater.cards import CardLineError, read_jsonl
from cheater.quality import quality_summary, quality_tier, score_card
from cheater.schema import (
    REQUIRED_FIELDS,
    USABLE_REQUIRED_FIELDS,
    normalize_and_validate,
)


def audit_file(
    path: str | Path,
    *,
    with_quality: bool = False,
) -> dict[str, Any]:
    """Audit one JSONL card file. Returns a structured report dict.

    The report is deterministic and JSON-serializable.
    with_quality=True adds per-card quality scoring and an aggregate summary.
    This is more expensive on large files (still O(n), no second pass).
    """
    p = Path(path)
    report: dict[str, Any] = {
        "path": str(p),
        "exists": p.is_file(),
        "total_lines": 0,
        "valid_json_objects": 0,
        "invalid_lines": 0,
        "usable_true": 0,
        "usable_false": 0,
        "missing_required": {},
        "missing_usable_required": {},
        "duplicate_ids": [],
        "top_languages": [],
        "top_bug_types": [],
        "top_repositories": [],
        "embedding_text_lengths": {"count": 0, "avg": 0, "max": 0},
        "avg_embedding_text_length": 0,
        "max_embedding_text_length": 0,
        "sample_usable": [],
        "passes": True,
        "errors": [],
    }
    if not p.is_file():
        report["passes"] = False
        report["errors"].append(f"file not found: {p}")
        return report

    seen_ids: set[str] = set()
    languages: Counter[str] = Counter()
    bug_types: Counter[str] = Counter()
    repos: Counter[str] = Counter()
    emb_lengths: list[int] = []
    samples: list[dict[str, Any]] = []
    invalid_lines: list[dict[str, Any]] = []
    quality_cards: list[dict[str, Any]] = []

    iterator = read_jsonl(p)
    line_no = 0
    while True:
        try:
            raw = next(iterator)
        except StopIteration:
            break
        except CardLineError as exc:
            report["passes"] = False
            invalid_lines.append({"line": exc.line, "error": str(exc).split(": ", 1)[-1]})
            report["errors"].append(str(exc))
            continue
        line_no += 1
        report["total_lines"] += 1
        report["valid_json_objects"] += 1

        card, result = normalize_and_validate(raw)
        if not result.ok:
            report["passes"] = False
            for err in result.errors:
                if err.startswith("missing required"):
                    field_name = err.split(":", 1)[1].strip()
                    report["missing_required"].setdefault(field_name, []).append(line_no)
                elif err.startswith("usable=true requires"):
                    field_name = err.split(":", 1)[1].strip()
                    report["missing_usable_required"].setdefault(field_name, []).append(line_no)
                else:
                    report["errors"].append(f"line {line_no}: {err}")

        cid = str(raw.get("id") or card.get("id") or "")
        if cid:
            if cid in seen_ids:
                report["duplicate_ids"].append({"id": cid, "line": line_no})
                report["passes"] = False
            else:
                seen_ids.add(cid)

        if card.get("usable") is True:
            report["usable_true"] += 1
            if len(samples) < 3:
                samples.append({
                    "id": card.get("id"),
                    "repo": card.get("repo"),
                    "language": card.get("language"),
                    "bug_type": card.get("bug_type"),
                    "symptom": (card.get("symptom") or "")[:200],
                    "fix_pattern": (card.get("fix_pattern") or "")[:200],
                })
        else:
            report["usable_false"] += 1

        lang = card.get("language")
        if lang:
            languages[lang] += 1
        bt = card.get("bug_type")
        if bt:
            bug_types[bt] += 1
        repo = card.get("repo")
        if repo:
            repos[repo] += 1

        emb = card.get("embedding_text") or ""
        if isinstance(emb, str):
            emb_lengths.append(len(emb))

        if with_quality:
            q = score_card(card)
            card["quality_score"] = q["score"]
            card["quality_reasons"] = q["reasons"]
            card["quality_tier"] = quality_tier(q["score"])
            quality_cards.append(card)

    report["invalid_lines"] = invalid_lines
    report["top_languages"] = languages.most_common(20)
    report["top_bug_types"] = bug_types.most_common(20)
    report["top_repositories"] = repos.most_common(20)
    if emb_lengths:
        report["embedding_text_lengths"] = {
            "count": len(emb_lengths),
            "avg": round(sum(emb_lengths) / len(emb_lengths), 1),
            "max": max(emb_lengths),
            "min": min(emb_lengths),
        }
        report["avg_embedding_text_length"] = report["embedding_text_lengths"]["avg"]
        report["max_embedding_text_length"] = report["embedding_text_lengths"]["max"]
    report["sample_usable"] = samples

    if with_quality and quality_cards:
        qs = quality_summary(quality_cards)
        report["quality"] = qs
        # Override the passes flag: a file is "passing" if there are no
        # critical issues AND the average quality is above 0.3
        if qs["avg_quality"] < 0.2 and report["passes"]:
            report["passes"] = False
            report["errors"].append(
                f"average quality {qs['avg_quality']} too low"
            )

    return report


def audit_files(
    paths: list[str | Path],
    *,
    with_quality: bool = False,
) -> list[dict[str, Any]]:
    return [audit_file(p, with_quality=with_quality) for p in paths]


def format_report(report: dict[str, Any], *, with_quality: bool = False) -> str:
    """Human-readable audit report."""
    lines: list[str] = []
    lines.append(f"=== Audit: {report['path']} ===")
    if not report["exists"]:
        lines.append("  FILE NOT FOUND")
        lines.append("")
        return "\n".join(lines)

    lines.append(f"  total lines:            {report['total_lines']}")
    lines.append(f"  valid JSON objects:     {report['valid_json_objects']}")
    lines.append(f"  invalid lines:          {len(report['invalid_lines'])}")
    lines.append(f"  usable=true:            {report['usable_true']}")
    lines.append(f"  usable=false:           {report['usable_false']}")
    lines.append(f"  duplicate ids:          {len(report['duplicate_ids'])}")
    if report["missing_required"]:
        lines.append("  missing required fields:")
        for f, lns in report["missing_required"].items():
            lines.append(f"    {f}: {len(lns)} line(s) (e.g. line {lns[0]})")
    if report["missing_usable_required"]:
        lines.append("  missing usable-required fields:")
        for f, lns in report["missing_usable_required"].items():
            lines.append(f"    {f}: {len(lns)} line(s)")
    if report["top_languages"]:
        lines.append("  top languages:          " + ", ".join(
            f"{lang}={n}" for lang, n in report["top_languages"][:5]
        ))
    if report["top_bug_types"]:
        lines.append("  top bug types:          " + ", ".join(
            f"{bt}={n}" for bt, n in report["top_bug_types"][:5]
        ))
    if report["top_repositories"]:
        lines.append("  top repos:              " + ", ".join(
            f"{r}={n}" for r, n in report["top_repositories"][:5]
        ))
    emb = report["embedding_text_lengths"]
    lines.append(
        f"  embedding_text length:  avg={emb['avg']} max={emb['max']} min={emb.get('min',0)} (n={emb['count']})"
    )
    if with_quality and "quality" in report:
        q = report["quality"]
        lines.append("")
        lines.append("  --- Quality ---")
        lines.append(f"  avg quality score:     {q['avg_quality']}")
        lines.append(f"  above 0.7 (high):       {q['above_0_7']}")
        lines.append(f"  above 0.4 (usable+):    {q['above_0_4']}")
        lines.append(f"  below 0.4 (junk):       {q['below_0_4']}")
        if q["top_filter_reasons"]:
            lines.append("  top filter reasons:")
            for reason, n in q["top_filter_reasons"][:8]:
                lines.append(f"    {reason}: {n}")
        if q.get("low_quality_examples"):
            lines.append("  low-quality examples (id, score, reasons):")
            for ex in q["low_quality_examples"][:3]:
                lines.append(f"    {ex['id']} ({ex['score']}): {', '.join(ex['reasons'])}")
        if q.get("duplicate_groups"):
            lines.append("  duplicate embedding_text groups:")
            for txt, n in list(q["duplicate_groups"].items())[:3]:
                lines.append(f"    {n}x: {txt}...")
    if report["sample_usable"]:
        lines.append("  sample usable cards:")
        for s in report["sample_usable"]:
            lines.append(
                f"    - {s.get('id')} [{s.get('language')}/{s.get('bug_type')}] "
                f"{s.get('symptom', '')[:80]}"
            )
    status = "PASS" if report["passes"] else "FAIL"
    lines.append(f"  validation:             {status}")
    if report["errors"]:
        for err in report["errors"][:10]:
            lines.append(f"    ! {err}")
    lines.append("")
    return "\n".join(lines)

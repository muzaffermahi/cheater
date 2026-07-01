from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

from datasets import load_dataset


DATASET_NAME = "nebius/SWE-agent-trajectories"

ERROR_HINTS = [
    "Traceback",
    "AssertionError",
    "TypeError",
    "ValueError",
    "KeyError",
    "IndexError",
    "AttributeError",
    "ImportError",
    "ModuleNotFoundError",
    "HTTPError",
    "Exception",
    "FAILED",
    "FAIL",
    "ERROR",
    "Error",
    "pytest",
    "tox",
    "unittest",
]

STACK_OR_ERROR_RE = re.compile(
    r"(Traceback[\s\S]{0,2500}?)(?=\n\n|\Z)|"
    r"((?:AssertionError|TypeError|ValueError|KeyError|IndexError|AttributeError|ImportError|ModuleNotFoundError|HTTPError|Exception|FAILED|ERROR|Error)[^\n]*(?:\n.{0,240}){0,12})",
    re.IGNORECASE,
)


def as_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False)


def get_issue_text(trajectory: list[dict[str, Any]]) -> str:
    """Find the initial issue text inside the trajectory."""
    for item in trajectory:
        if item.get("role") == "user":
            text = item.get("text") or ""
            if "ISSUE:" in text or "issue" in text.lower():
                return text
    # fallback: first non-system user text
    for item in trajectory:
        if item.get("role") == "user":
            text = item.get("text") or ""
            if text.strip():
                return text
    return ""


def trajectory_to_text(trajectory: list[dict[str, Any]], max_chars: int = 15000) -> str:
    """Compact non-system trajectory text for search/debug preview."""
    chunks: list[str] = []
    for item in trajectory:
        role = item.get("role")
        if role == "system":
            continue
        text = item.get("text") or ""
        if not text:
            continue
        chunks.append(f"[{role}]\n{text}")
        if sum(len(c) for c in chunks) > max_chars:
            break
    return "\n\n".join(chunks)[:max_chars]


def extract_error_excerpt(*texts: str, max_chars: int = 2500) -> str:
    combined = "\n\n".join(t for t in texts if t)
    matches: list[str] = []

    for match in STACK_OR_ERROR_RE.finditer(combined):
        chunk = match.group(0).strip()
        if chunk and chunk not in matches:
            matches.append(chunk)

    if matches:
        return "\n\n".join(matches)[:max_chars]

    # fallback line-window extraction
    lines = combined.splitlines()
    windows: list[str] = []
    for i, line in enumerate(lines):
        if any(h.lower() in line.lower() for h in ERROR_HINTS):
            start = max(0, i - 4)
            end = min(len(lines), i + 10)
            windows.append("\n".join(lines[start:end]))
    return "\n\n".join(windows)[:max_chars]


def extract_changed_files(patch: str) -> list[str]:
    files: list[str] = []
    for line in patch.splitlines():
        if line.startswith("diff --git "):
            parts = line.split()
            if len(parts) >= 4:
                path = parts[3]
                if path.startswith("b/"):
                    path = path[2:]
                if path not in files:
                    files.append(path)
    return files


def summarize_patch(patch: str, max_files: int = 12) -> str:
    files = extract_changed_files(patch)
    if not files:
        return "No patch files detected."

    added = sum(1 for line in patch.splitlines() if line.startswith("+") and not line.startswith("+++"))
    removed = sum(1 for line in patch.splitlines() if line.startswith("-") and not line.startswith("---"))

    shown = ", ".join(files[:max_files])
    if len(files) > max_files:
        shown += f", ... (+{len(files) - max_files} more)"

    return f"Changed files: {shown}. Added lines: {added}. Removed lines: {removed}."


def detect_test_status(eval_logs: str) -> str:
    text = eval_logs or ""
    lower = text.lower()
    tail = lower[-5000:]

    # Strong positive signals near the end should win.
    if "all tests passed" in tail:
        return "passed"
    if " no tests ran" in tail:
        return "no_tests_ran"
    if " passed" in tail and " failed" not in tail[-1500:] and " error" not in tail[-1500:]:
        return "passed"

    # Benchmark logs often include historical failure text before final eval,
    # so only treat as failed if failure appears near the end.
    if " failed" in tail or " error" in tail or "traceback" in tail:
        return "failed_or_contains_failures"

    if "passed" in lower:
        return "probably_passed"

    return "unknown"


def make_card(row: dict[str, Any], index: int) -> dict[str, Any] | None:
    trajectory = row.get("trajectory") or []
    if not isinstance(trajectory, list):
        return None

    issue = get_issue_text(trajectory)
    patch = row.get("generated_patch") or ""
    eval_logs = row.get("eval_logs") or ""

    if not issue.strip() and not patch.strip():
        return None

    error_excerpt = extract_error_excerpt(issue, trajectory_to_text(trajectory), eval_logs)
    changed_files = extract_changed_files(patch)
    patch_summary = summarize_patch(patch)
    test_status = detect_test_status(eval_logs)

    search_text = "\n".join(
        [
            str(row.get("instance_id") or ""),
            str(row.get("model_name") or ""),
            issue[:5000],
            error_excerpt,
            patch_summary,
            "\n".join(changed_files),
            patch[:4000],
        ]
    )

    return {
        "id": row.get("instance_id") or f"row_{index}",
        "row_index": index,
        "source": DATASET_NAME,
        "model_name": row.get("model_name"),
        "target": row.get("target"),
        "exit_status": row.get("exit_status"),
        "test_status_detected": test_status,
        "issue": issue[:6000],
        "error_excerpt": error_excerpt[:3000],
        "changed_files": changed_files,
        "patch_summary": patch_summary,
        "patch": patch[:12000],
        "eval_tail": eval_logs[-4000:] if eval_logs else "",
        "trajectory_preview": trajectory_to_text(trajectory, max_chars=5000),
        "search_text": search_text[:18000],
    }


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Extract target=True solved bug cards from nebius/SWE-agent-trajectories."
    )
    parser.add_argument("--output", default="data/solved_bug_cards.jsonl")
    parser.add_argument("--max-rows", type=int, default=None, help="Only scan first N dataset rows.")
    parser.add_argument("--max-cards", type=int, default=None, help="Stop after writing N cards.")
    parser.add_argument("--include-unsolved", action="store_true", help="Also include target=False rows.")
    args = parser.parse_args()

    print(f"Loading dataset: {DATASET_NAME}")
    ds = load_dataset(DATASET_NAME, split="train")

    cards: list[dict[str, Any]] = []
    seen = 0
    skipped_unsolved = 0
    skipped_empty = 0

    total_to_scan = len(ds) if args.max_rows is None else min(len(ds), args.max_rows)

    for index, row in enumerate(ds):
        if args.max_rows is not None and index >= args.max_rows:
            break

        seen += 1

        if row.get("target") is not True and not args.include_unsolved:
            skipped_unsolved += 1
            continue

        card = make_card(row, index)
        if card is None:
            skipped_empty += 1
            continue

        cards.append(card)

        if len(cards) % 500 == 0:
            print(f"cards: {len(cards)} / scanned: {seen}/{total_to_scan}")

        if args.max_cards is not None and len(cards) >= args.max_cards:
            break
    
    


        # Dedupe by instance id. Keep the card with the largest patch/search text,
    # because it usually contains more useful retrieval material.
    deduped = {}
    for card in cards:
        key = card["id"]
        old = deduped.get(key)
        if old is None:
            deduped[key] = card
            continue

        old_score = len(old.get("patch", "")) + len(old.get("error_excerpt", ""))
        new_score = len(card.get("patch", "")) + len(card.get("error_excerpt", ""))

        if new_score > old_score:
            deduped[key] = card

    cards = list(deduped.values())

    out = Path(args.output)
    write_jsonl(out, cards)

    print("\n=== Done ===")
    print("scanned:", seen)
    print("cards written:", len(cards))
    print("skipped unsolved:", skipped_unsolved)
    print("skipped empty:", skipped_empty)
    print("output:", out.resolve())


if __name__ == "__main__":
    main()

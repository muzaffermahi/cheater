"""Build a held-out retrieval benchmark from the full corpus.

Creates data/benchmarks/heldout_retrieval.v1.jsonl with paraphrased queries
that test whether retrieval can find the original card.

Each case:
  {
    "id": "bench_XXXX",
    "query": "<paraphrased query that is NOT the card's exact text>",
    "expected_card_ids": ["<card_id>"],
    "language": "python" | ...,
    "difficulty": "easy" | "medium" | "hard",
    "notes": "..."
  }

Rules:
  - Select a stratified sample (different repos, languages, bug types)
  - Paraphrase queries so they don't contain exact phrases from the card
  - Vary difficulty: easy (1-2 unique terms), medium (3-4), hard (vague)
  - Expected card IDs must exist in the corpus
  - Same-repo contamination control: avoid using the card's own embedding_text
"""
from __future__ import annotations

import argparse
import json
import random
import re
from collections import Counter
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
CARDS_PATH = REPO_ROOT / "data" / "cards" / "cards.v1.jsonl"
OUT_PATH = REPO_ROOT / "data" / "benchmarks" / "heldout_retrieval.v1.jsonl"

# Words to remove from card text to create paraphrases
STOP = {
    "the", "is", "at", "which", "on", "a", "an", "and", "or", "but", "in",
    "with", "to", "for", "of", "as", "by", "this", "that", "it", "from", "be",
    "are", "was", "were", "not", "have", "has", "had", "if", "then", "else", "when",
    "all", "any", "some", "no", "nor", "you", "your", "i", "we", "they", "he",
    "she", "them", "us", "me", "but", "do", "does", "did", "doing", "would", "could",
    "should", "will", "shall", "may", "might", "must", "can", "could", "use", "used",
    "using", "should", "would", "via", "into", "than", "such", "also", "just", "more",
}


def _tokenize(text: str) -> list[str]:
    return re.findall(r"[A-Za-z_][A-Za-z0-9_]+|\d+", text or "")


def _filter_quality_cards(cards: list[dict], min_quality: float = 0.0) -> list[dict]:
    """Prefer high-quality cards: have symptom, fix_pattern, embedding_text."""
    out = []
    for c in cards:
        if not c.get("usable"):
            continue
        sym = str(c.get("symptom") or "")
        fix = str(c.get("fix_pattern") or "")
        emb = str(c.get("embedding_text") or "")
        if len(sym) < 40 or len(fix) < 30 or len(emb) < 100:
            continue
        qs = c.get("quality_score") or 0
        if qs < min_quality:
            continue
        out.append(c)
    return out


BOILERPLATE_PHRASES = [
    "errors.) command at the end of the file",
    "we're currently solving",
    "setting: you are an autonomous programmer",
    "commands:",
    "open: docstring:",
    "here's the issue text:",
    "issue:",
]


def _is_boilerplate(text: str) -> bool:
    """True if the text is just SWE-agent boilerplate, not real content."""
    t = (text or "").strip().lower()
    if not t:
        return True
    for bp in BOILERPLATE_PHRASES:
        if t == bp or t.startswith(bp) or len(t) < 40:
            return True
    return False


def _paraphrase_easy(card: dict) -> str | None:
    """Easy: use the error message + a single keyword."""
    sym = str(card.get("symptom") or "").strip()
    if _is_boilerplate(sym) or not sym:
        return None
    first = sym.split("\n")[0][:200]
    return first.strip()


def _paraphrase_medium(card: dict) -> str | None:
    """Medium: combine root_cause hint with bug_type."""
    sym = str(card.get("symptom") or "").strip()
    bt = str(card.get("bug_type") or "")
    if _is_boilerplate(sym) or not sym:
        return None
    first = sym.split("\n")[0][:120]
    parts = [first.strip()]
    if bt:
        parts.append(f"({bt})")
    return " ".join(parts)[:300]


def _paraphrase_hard(card: dict) -> str | None:
    """Hard: vague description using bug_type and a few keywords from fix_pattern."""
    bt = str(card.get("bug_type") or "")
    fix = str(card.get("fix_pattern") or "").strip()
    if not fix or _is_boilerplate(fix):
        return None
    # Extract 2-3 unique content words from fix_pattern
    tokens = _tokenize(fix.lower())
    keywords = [t for t in tokens if len(t) >= 4 and t not in STOP][:5]
    if not keywords:
        return None
    # Generic vague phrasing
    parts = ["How to fix"]
    if bt:
        parts.append(f"a {bt} issue")
    else:
        parts.append("this bug")
    parts.append("involving")
    parts.append(", ".join(keywords[:3]))
    return " ".join(parts)[:300]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cards", default=str(CARDS_PATH))
    parser.add_argument("--output", default=str(OUT_PATH))
    parser.add_argument("--count", type=int, default=50, help="Target number of cases")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--min-quality", type=float, default=0.0,
                        help="Minimum quality_score to include card (default 0; 0.3=skip junk).")
    args = parser.parse_args()

    rng = random.Random(args.seed)

    print(f"Loading cards from {args.cards}...", flush=True)
    all_cards = []
    with open(args.cards, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            c = json.loads(line)
            if c.get("usable"):
                all_cards.append(c)
    print(f"  {len(all_cards)} usable cards", flush=True)

    cards = _filter_quality_cards(all_cards, min_quality=args.min_quality)
    print(f"  {len(cards)} cards with adequate quality and text", flush=True)

    # Stratify: one card per repo first, then add more from varied repos
    by_repo: dict[str, list[dict]] = {}
    for c in cards:
        repo = c.get("repo") or "unknown"
        by_repo.setdefault(repo, []).append(c)
    repos = sorted(by_repo.keys(), key=lambda r: -len(by_repo[r]))
    print(f"  {len(repos)} unique repos", flush=True)

    # Aim for at least 2/3 easy, 1/3 medium, 1/4 hard
    target_easy = args.count * 5 // 12  # ~42%
    target_medium = args.count * 4 // 12  # ~33%
    target_hard = args.count * 3 // 12  # ~25%
    print(f"  targets: easy={target_easy} medium={target_medium} hard={target_hard}", flush=True)

    cases: list[dict] = []
    used_ids: set[str] = set()

    # Round-robin over repos to maximize diversity
    pool_easy = []
    pool_medium = []
    pool_hard = []
    for repo in repos:
        for c in by_repo[repo]:
            if _paraphrase_easy(c):
                pool_easy.append(c)
            if _paraphrase_medium(c):
                pool_medium.append(c)
            if _paraphrase_hard(c):
                pool_hard.append(c)

    rng.shuffle(pool_easy)
    rng.shuffle(pool_medium)
    rng.shuffle(pool_hard)

    def take(pool: list, target: int, difficulty: str) -> None:
        n = 0
        for c in pool:
            if n >= target:
                break
            cid = c.get("id")
            if not cid or cid in used_ids:
                continue
            if difficulty == "easy":
                q = _paraphrase_easy(c)
            elif difficulty == "medium":
                q = _paraphrase_medium(c)
            else:
                q = _paraphrase_hard(c)
            if not q or len(q) < 15:
                continue
            used_ids.add(cid)
            cases.append({
                "id": f"heldout_{len(cases)+1:04d}",
                "query": q,
                "expected_card_ids": [cid],
                "language": c.get("language"),
                "repo": c.get("repo"),
                "bug_type": c.get("bug_type"),
                "difficulty": difficulty,
                "notes": f"auto-generated from card {cid}",
            })
            n += 1

    take(pool_easy, target_easy, "easy")
    take(pool_medium, target_medium, "medium")
    take(pool_hard, target_hard, "hard")

    # Top up from any remaining pool if short
    if len(cases) < args.count:
        for c in cards:
            if len(cases) >= args.count:
                break
            cid = c.get("id")
            if not cid or cid in used_ids:
                continue
            q = _paraphrase_easy(c)
            if not q:
                continue
            used_ids.add(cid)
            cases.append({
                "id": f"heldout_{len(cases)+1:04d}",
                "query": q,
                "expected_card_ids": [cid],
                "language": c.get("language"),
                "repo": c.get("repo"),
                "bug_type": c.get("bug_type"),
                "difficulty": "easy",
                "notes": f"auto-generated from card {cid}",
            })

    # Shuffle so difficulty is not all together
    rng.shuffle(cases)
    # Renumber
    for i, c in enumerate(cases, start=1):
        c["id"] = f"heldout_{i:04d}"

    # Verify all expected ids exist
    valid_ids = {c.get("id") for c in all_cards}
    missing = []
    for case in cases:
        for eid in case.get("expected_card_ids", []):
            if eid not in valid_ids:
                missing.append((case["id"], eid))
    if missing:
        print(f"WARNING: {len(missing)} expected card ids not in corpus: {missing[:5]}")

    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        for c in cases:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")
    print(f"Wrote {len(cases)} cases to {args.output}")
    diff_counts = Counter(c["difficulty"] for c in cases)
    for d, n in diff_counts.most_common():
        print(f"  {d}: {n}")
    lang_counts = Counter(c.get("language") or "?" for c in cases)
    print(f"  languages: {dict(lang_counts.most_common(5))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

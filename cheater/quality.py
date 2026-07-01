"""Per-card quality scoring for memory cards.

Computes deterministic quality signals so retrieval can downrank or filter
junk cards, and so audit-cards --quality can explain why cards were
downranked.

Quality signals:
  - missing required fields
  - too-short symptom / fix_pattern / embedding_text
  - garbage text detection (boilerplate, repeated phrases, weird truncation)
  - language missing
  - no usable repair signal
  - cross-project ambiguity (repo missing)
  - near-duplicate detection (exact text)

Cards are NOT deleted. They are marked `usable` per schema rules and get a
`quality_score` 0-1 plus a list of `quality_reasons` (negative reasons).
The retrieval layer can use `quality_score` to boost clean cards.
"""
from __future__ import annotations

import re
from collections import Counter
from typing import Any


# Minimum length thresholds for usable text fields
MIN_SYMPTOM = 30
MIN_FIX_PATTERN = 30
MIN_EMBEDDING_TEXT = 60
MAX_EMBEDDING_TEXT = 8000  # above this is mostly boilerplate

# Boilerplate phrases that show up in raw SWE-agent trajectories
BOILERPLATE_PATTERNS = [
    r"^errors?\.\)?\s*command at the end of the file",
    r"^we'?re currently solving",
    r"^setting:\s*you are an autonomous programmer",
    r"^commands?:",
    r"^open:\s*docstring:",
    r"^here'?s the issue text:?",
    r"^issue:\s*$",
    r"^```+\s*$",  # only markdown fences
    r"^\s*$",  # empty / whitespace
    r"^---+$",  # separator lines
    r"^={3,}$",
    r"^#{1,6}\s*$",  # bare markdown headers
]

BOILERPLATE_RE = re.compile("|".join(BOILERPLATE_PATTERNS), re.IGNORECASE | re.MULTILINE)

# Heuristic for "garbage" content: mostly repeated characters, low alpha ratio
GARBAGE_HIGH_NONALPHA = 0.5  # >50% non-alpha = suspicious
GARBAGE_LONG_REPEAT = 20  # any single char repeated >20 times

# Common English stopwords that should appear in coherent text
COMMON_WORDS = {
    "the", "is", "at", "which", "on", "a", "an", "and", "or", "but",
    "in", "with", "to", "for", "of", "as", "by", "this", "that", "it",
    "from", "be", "are", "was", "were", "not", "have", "has", "had",
    "if", "then", "else", "when", "all", "any", "some", "no", "nor",
}


def _garbage_score(text: str) -> float:
    """Return 0-1 garbage score. 0=clean, 1=total junk."""
    if not text:
        return 1.0
    # Non-alpha ratio
    alpha = sum(c.isalpha() for c in text)
    nonalpha = sum(not c.isalnum() and not c.isspace() for c in text)
    if alpha + nonalpha == 0:
        return 0.5
    nonalpha_ratio = nonalpha / max(1, alpha + nonalpha)
    if nonalpha_ratio > GARBAGE_HIGH_NONALPHA:
        return 0.8
    # Long repeated character
    for ch in set(text):
        runs = re.findall(rf"{re.escape(ch)}{{{GARBAGE_LONG_REPEAT+1},}}", text)
        if runs:
            return 0.7
    # Boilerplate
    if BOILERPLATE_RE.search(text):
        return 0.7
    return 0.0


def _completeness(card: dict) -> float:
    """Score 0-1 based on field presence/length."""
    score = 0.0
    # Required structural fields
    if card.get("id"): score += 0.1
    if card.get("source"): score += 0.1
    if card.get("repo"): score += 0.05
    if card.get("language"): score += 0.05
    if card.get("bug_type"): score += 0.05
    # Usable-only fields
    symptom = str(card.get("symptom") or "")
    if len(symptom) >= MIN_SYMPTOM: score += 0.15
    fix = str(card.get("fix_pattern") or "")
    if len(fix) >= MIN_FIX_PATTERN: score += 0.15
    emb = str(card.get("embedding_text") or "")
    if MIN_EMBEDDING_TEXT <= len(emb) <= MAX_EMBEDDING_TEXT: score += 0.2
    # Bonus: has root_cause, failed_approaches, key_files, test_signal
    if card.get("root_cause"): score += 0.05
    if card.get("failed_approaches"): score += 0.05
    if card.get("key_files"): score += 0.05
    return min(1.0, score)


def _specificity(card: dict) -> float:
    """Score 0-1: does the card have project-specific language?"""
    score = 0.0
    if card.get("repo"):
        score += 0.2
    if card.get("language"):
        score += 0.2
    if card.get("key_files"):
        score += 0.2
    if card.get("bug_type"):
        score += 0.2
    kws = card.get("search_keywords") or []
    if isinstance(kws, list) and len(kws) > 0:
        score += 0.2
    return min(1.0, score)


def score_card(card: dict) -> dict[str, Any]:
    """Return {"score": 0-1, "reasons": [...], "flags": {...}}.

    `reasons` is a list of short strings explaining what lowered the score.
    Higher score = better card. Junk cards score near 0.
    """
    reasons: list[str] = []
    flags: dict[str, Any] = {}

    if not card.get("id"):
        reasons.append("missing id")
        return {"score": 0.0, "reasons": reasons, "flags": flags}

    if not card.get("source"):
        reasons.append("missing source")

    symptom = str(card.get("symptom") or "")
    fix = str(card.get("fix_pattern") or "")
    emb = str(card.get("embedding_text") or "")

    # Field length checks
    if len(symptom) < MIN_SYMPTOM:
        reasons.append(f"symptom too short ({len(symptom)}<{MIN_SYMPTOM})")
    if len(fix) < MIN_FIX_PATTERN:
        reasons.append(f"fix_pattern too short ({len(fix)}<{MIN_FIX_PATTERN})")
    if len(emb) < MIN_EMBEDDING_TEXT:
        reasons.append(f"embedding_text too short ({len(emb)}<{MIN_EMBEDDING_TEXT})")
    elif len(emb) > MAX_EMBEDDING_TEXT:
        reasons.append(f"embedding_text very long ({len(emb)}>{MAX_EMBEDDING_TEXT})")

    # Garbage text checks
    sym_garbage = _garbage_score(symptom)
    fix_garbage = _garbage_score(fix)
    emb_garbage = _garbage_score(emb)
    flags["garbage"] = {"symptom": sym_garbage, "fix_pattern": fix_garbage, "embedding_text": emb_garbage}
    if sym_garbage >= 0.7:
        reasons.append("symptom looks like boilerplate/truncation")
    if fix_garbage >= 0.7:
        reasons.append("fix_pattern looks like boilerplate/truncation")
    if emb_garbage >= 0.7:
        reasons.append("embedding_text looks like boilerplate/truncation")

    # Missing repair signal
    if not symptom and not fix and not emb:
        reasons.append("no repair signal (symptom/fix_pattern/embedding_text all empty)")

    # Language / repo missing
    if not card.get("language"):
        reasons.append("language missing")
    if not card.get("repo"):
        reasons.append("repo missing (cross-project ambiguity risk)")

    # Combine
    completeness = _completeness(card)
    specificity = _specificity(card)
    # Penalty from garbage and missing fields.
    # Use average garbage (not max) so one bad field doesn't kill the card
    # if other fields are clean.
    avg_garbage = (sym_garbage + fix_garbage + emb_garbage) / 3.0
    penalty = min(1.0, avg_garbage * 0.6
                  + (0.2 if not card.get("language") else 0)
                  + (0.1 if not card.get("repo") else 0))
    base = (completeness * 0.6 + specificity * 0.4)
    # Minimum score floor of 0.1 so even poor cards have a non-zero ranking
    score = max(0.1, min(1.0, base * (1.0 - penalty)))

    flags["completeness"] = round(completeness, 3)
    flags["specificity"] = round(specificity, 3)
    flags["penalty"] = round(penalty, 3)

    return {"score": round(score, 3), "reasons": reasons, "flags": flags}


def quality_summary(cards: list[dict]) -> dict[str, Any]:
    """Summarize quality across many cards. Used by audit-cards --quality."""
    scores = []
    all_reasons: Counter[str] = Counter()
    languages: Counter[str] = Counter()
    bug_types: Counter[str] = Counter()
    repositories: Counter[str] = Counter()
    emb_lengths: list[int] = []
    sym_lengths: list[int] = []
    fix_lengths: list[int] = []
    low_quality_examples: list[dict[str, Any]] = []
    duplicates: dict[str, int] = {}

    for card in cards:
        q = score_card(card)
        scores.append(q["score"])
        for r in q["reasons"]:
            all_reasons[r] += 1
        if card.get("language"):
            languages[card["language"]] += 1
        if card.get("bug_type"):
            bug_types[card["bug_type"]] += 1
        if card.get("repo"):
            repositories[card["repo"]] += 1
        emb = str(card.get("embedding_text") or "")
        sym = str(card.get("symptom") or "")
        fix = str(card.get("fix_pattern") or "")
        if emb: emb_lengths.append(len(emb))
        if sym: sym_lengths.append(len(sym))
        if fix: fix_lengths.append(len(fix))
        # Track low quality examples (skip cards that are already unusable)
        if q["score"] < 0.4 and card.get("usable") is True and len(low_quality_examples) < 5:
            low_quality_examples.append({
                "id": card.get("id"),
                "score": q["score"],
                "reasons": q["reasons"],
            })

    # Detect exact-text duplicates among embedding_texts
    seen: dict[str, int] = {}
    for card in cards:
        emb = str(card.get("embedding_text") or "").strip().lower()
        if len(emb) < 50:
            continue
        seen[emb] = seen.get(emb, 0) + 1
    duplicates = {k[:80]: v for k, v in seen.items() if v > 1}

    n = len(cards)
    avg_score = round(sum(scores) / n, 3) if n else 0
    above_07 = sum(1 for s in scores if s >= 0.7)
    above_04 = sum(1 for s in scores if s >= 0.4)

    return {
        "total": n,
        "avg_quality": avg_score,
        "above_0_7": above_07,
        "above_0_4": above_04,
        "below_0_4": n - above_04,
        "top_filter_reasons": all_reasons.most_common(20),
        "top_languages": languages.most_common(20),
        "top_bug_types": bug_types.most_common(20),
        "top_repositories": repositories.most_common(20),
        "embedding_text_length": {
            "avg": round(sum(emb_lengths) / max(1, len(emb_lengths)), 1),
            "max": max(emb_lengths) if emb_lengths else 0,
            "min": min(emb_lengths) if emb_lengths else 0,
        },
        "symptom_length": {
            "avg": round(sum(sym_lengths) / max(1, len(sym_lengths)), 1),
            "max": max(sym_lengths) if sym_lengths else 0,
        },
        "fix_pattern_length": {
            "avg": round(sum(fix_lengths) / max(1, len(fix_lengths)), 1),
            "max": max(fix_lengths) if fix_lengths else 0,
        },
        "low_quality_examples": low_quality_examples,
        "duplicate_groups": dict(list(duplicates.items())[:5]),
    }


def quality_tier(score: float) -> str:
    """Bucket a quality score into a tier label."""
    if score >= 0.75:
        return "high"
    if score >= 0.5:
        return "medium"
    if score >= 0.3:
        return "low"
    return "junk"

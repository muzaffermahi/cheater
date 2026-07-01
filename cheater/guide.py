"""Repair-guidance generator.

`cheater guide "<bug description>"` produces a deterministic, retrieval-grounded
repair brief. It does NOT claim to know the fix. It says "likely" and grounds
every suggestion in retrieved cards.

The brief contains:
  1. Query summary
  2. Top relevant cards (with grounded card IDs and scores)
  3. Likely bug classes (from card bug_type distribution among top hits)
  4. Repair patterns (aggregated from fix_pattern fields of top hits)
  5. Failed approaches to avoid (from failed_approaches fields)
  6. Concrete next debugging steps (derived from card fields, not invented)
  7. Relevant files / signals to inspect (from key_files and test_signal)
  8. Warnings (cross-project analogies, low confidence, disagreement)

No external API calls. Pure retrieval + deterministic aggregation.
"""
from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path
from typing import Any

from cheater.retrieval import BM25FIndex, load_index_cards, tokenize_terms, why_matched


def _read_cards(path: str | Path) -> list[dict[str, Any]]:
    p = Path(path)
    if not p.is_file():
        return []
    return load_index_cards(p)


def _detect_signals(query: str) -> dict[str, Any]:
    """Heuristically detect error types, function names, and file paths in a query.

    Pure regex; no LLM. Used to suggest concrete next steps.
    """
    text = query
    # Python-style error patterns
    error_types = re.findall(r"\b([A-Z][A-Za-z]+(?:Error|Exception|Warning))\b", text)
    # File paths
    file_paths = re.findall(r"([\w./-]+\.(?:py|js|ts|java|rs|go|cpp|c|h)\b)", text)
    # Function/method names (after 'def ' or 'function ' or '.' in code snippets)
    function_names: set[str] = set()
    for m in re.finditer(r"def\s+(\w+)", text):
        function_names.add(m.group(1))
    for m in re.finditer(r"\.(\w+)\(", text):
        function_names.add(m.group(1))
    # Library names (common)
    libraries: set[str] = set()
    for m in re.finditer(r"\b([a-z][a-z0-9_-]+)[\s.]", text):
        token = m.group(1)
        if len(token) >= 3 and token.isidentifier():
            libraries.add(token)
    return {
        "error_types": list(dict.fromkeys(error_types))[:10],
        "file_paths": list(dict.fromkeys(file_paths))[:10],
        "function_names": sorted(function_names)[:10],
        "libraries": sorted(libraries)[:15],
    }


def _aggregate_patterns(cards: list[tuple[float, dict[str, Any]]]) -> dict[str, Any]:
    """Aggregate patterns from top retrieved cards. Returns structured signals."""
    bug_types: Counter[str] = Counter()
    languages: Counter[str] = Counter()
    repos: Counter[str] = Counter()
    fix_patterns: list[str] = []
    failed_approaches: list[str] = []
    key_files: list[str] = []
    test_signals: list[str] = []
    for _, c in cards:
        if c.get("bug_type"):
            bug_types[str(c["bug_type"])] += 1
        if c.get("language"):
            languages[str(c["language"])] += 1
        if c.get("repo"):
            repos[str(c["repo"])] += 1
        fp = str(c.get("fix_pattern") or "").strip()
        if fp and fp not in fix_patterns:
            fix_patterns.append(fp)
        for fa in c.get("failed_approaches") or []:
            if fa and fa not in failed_approaches:
                failed_approaches.append(str(fa))
        for kf in c.get("key_files") or []:
            if kf and kf not in key_files:
                key_files.append(str(kf))
        ts = str(c.get("test_signal") or "").strip()
        if ts and ts not in test_signals:
            test_signals.append(ts)
    return {
        "bug_types": bug_types.most_common(5),
        "languages": languages.most_common(5),
        "repos": repos.most_common(5),
        "fix_patterns": fix_patterns[:5],
        "failed_approaches": failed_approaches[:5],
        "key_files": key_files[:10],
        "test_signals": test_signals[:5],
    }


def _derive_next_steps(
    query: str, cards: list[tuple[float, dict[str, Any]]], signals: dict[str, Any],
) -> list[str]:
    """Build next-step suggestions from signals + retrieved cards. Not invented."""
    steps: list[str] = []
    # Error-type steps
    for et in signals["error_types"][:3]:
        steps.append(
            f"Search the repo for where `{et}` is raised to find the failing code path."
        )
    # File-path steps
    for fp in signals["file_paths"][:3]:
        steps.append(f"Inspect `{fp}` for the suspect logic; the retrieved cards touch similar files.")
    # Card-driven steps
    card_files = [c[1].get("key_files") for c in cards[:3]]
    for files in card_files:
        if not files:
            continue
        for f in files[:2]:
            steps.append(f"Check `{f}` (a similar bug involved changes here).")
    # Test signal
    for ts in [_c[1].get("test_signal") for _c in cards[:3] if _c[1].get("test_signal")][:2]:
        steps.append(f"Run the test `{ts}` to reproduce.")
    return steps[:8]


def _build_warnings(
    query: str,
    cards: list[tuple[float, dict[str, Any]]],
    patterns: dict[str, Any],
) -> list[str]:
    warnings: list[str] = []
    if not cards:
        return ["No matching cards found in the corpus; the brief below is generic."]

    # Cross-project: top cards come from many different repos
    repos_in_top = {c[1].get("repo") for c in cards[:5] if c[1].get("repo")}
    if len(repos_in_top) >= 3:
        warnings.append(
            f"Top {len(cards[:5])} results span {len(repos_in_top)} repos. "
            "Treat as analogies, not templates."
        )

    # Low confidence: top score is small
    top_score = cards[0][0] if cards else 0
    if top_score < 5:
        warnings.append(
            f"Top score is only {top_score:.2f}; confidence is low. "
            "Increase --top-k or refine the query."
        )

    # Low quality
    low_q = [c for _, c in cards if (c.get("quality_score") or 0) < 0.4]
    if low_q:
        warnings.append(
            f"{len(low_q)}/{len(cards)} top cards have low quality_score (<0.4). "
            "Patterns may be unreliable."
        )

    # Disagreement: top cards suggest different bug types
    if len(patterns["bug_types"]) >= 2:
        top_two = patterns["bug_types"][:2]
        if top_two[0][1] == top_two[1][1]:
            warnings.append(
                f"Top cards suggest multiple bug types equally ({[b[0] for b in patterns['bug_types'][:2]]}). "
                "The signal is ambiguous."
            )

    return warnings


def _format_text(
    query: str,
    cards: list[tuple[float, dict[str, Any]]],
    patterns: dict[str, Any],
    signals: dict[str, Any],
    warnings: list[str],
) -> str:
    """Plain-text rendering of the repair brief."""
    lines: list[str] = []
    lines.append("=== Cheater Repair Guide ===")
    lines.append(f"Query: {query}")
    lines.append("")

    lines.append("1. Query summary")
    lines.append(f"   Tokens: {', '.join(tokenize_terms(query)[:12])}")
    if signals["error_types"]:
        lines.append(f"   Error types detected: {', '.join(signals['error_types'])}")
    if signals["file_paths"]:
        lines.append(f"   File paths detected: {', '.join(signals['file_paths'])}")
    lines.append("")

    lines.append("2. Top relevant cards")
    if not cards:
        lines.append("   (none)")
    else:
        for i, (score, c) in enumerate(cards[:5], start=1):
            cid = c.get("id", "?")
            q = c.get("quality_score")
            qt = c.get("quality_tier", "?")
            repo = c.get("repo") or "?"
            lang = c.get("language") or "?"
            lines.append(
                f"   {i}. {cid}  score={score:.3f}  quality={q}({qt})  repo={repo}  lang={lang}"
            )
    lines.append("")

    lines.append("3. Likely bug classes (from top hits)")
    if patterns["bug_types"]:
        for bt, n in patterns["bug_types"]:
            lines.append(f"   - {bt}  ({n} card(s))")
    else:
        lines.append("   (no bug_type signal in top hits)")
    if patterns["languages"]:
        lines.append(f"   Languages: {', '.join(f'{l}({n})' for l, n in patterns['languages'])}")
    lines.append("")

    lines.append("4. Repair patterns (likely, not guaranteed)")
    if patterns["fix_patterns"]:
        for fp in patterns["fix_patterns"]:
            lines.append(f"   - {fp}")
    else:
        lines.append("   (no fix_pattern signal in top hits)")
    lines.append("")

    lines.append("5. Failed approaches to avoid")
    if patterns["failed_approaches"]:
        for fa in patterns["failed_approaches"]:
            lines.append(f"   - {fa}")
    else:
        lines.append("   (no failed_approaches signal)")
    lines.append("")

    steps = _derive_next_steps(query, cards, signals)
    lines.append("6. Concrete next debugging steps")
    if steps:
        for s in steps:
            lines.append(f"   - {s}")
    else:
        lines.append("   (no concrete steps derivable from the query/cards)")
    lines.append("")

    lines.append("7. Relevant files / signals to inspect")
    if patterns["key_files"]:
        for f in patterns["key_files"][:8]:
            lines.append(f"   - {f}")
    else:
        lines.append("   (none)")
    if patterns["test_signals"]:
        lines.append("   Test signals:")
        for t in patterns["test_signals"][:3]:
            lines.append(f"   - {t}")
    lines.append("")

    lines.append("8. Warnings")
    if warnings:
        for w in warnings:
            lines.append(f"   ! {w}")
    else:
        lines.append("   (none)")
    lines.append("")
    lines.append("Cheater does not claim to know the fix. Verify everything against the actual repo and tests.")
    return "\n".join(lines)


def generate_guide(
    query: str,
    cards: list[dict[str, Any]],
    *,
    top_k: int = 5,
    repo_context: dict[str, Any] | None = None,
    same_language: str | None = None,
) -> dict[str, Any]:
    """Generate a structured repair brief from a query and a card corpus.

    Args:
      query: bug description / error
      cards: usable card list
      top_k: number of cards to ground the brief in
      repo_context: optional explorer result dict (top_files, symbols, line_ranges)
      same_language: optional language code to filter / boost (e.g. "python")
    """
    idx = BM25FIndex(cards)
    if same_language:
        results = idx.search(
            query, top_k=top_k, language=same_language, same_language_boost=0.2,
        )
    else:
        results = idx.search(query, top_k=top_k)
    patterns = _aggregate_patterns(results)
    signals = _detect_signals(query)
    warnings = _build_warnings(query, results, patterns)
    # Cross-project warning if explicit same_language used but results are mixed
    if same_language:
        other_lang = [c for _, c in results if (c.get("language") or "").lower() != same_language.lower()]
        if other_lang:
            warnings.append(
                f"Note: {len(other_lang)}/{len(results)} top cards are NOT in language={same_language}. "
                "Treat as analogies, not templates."
            )
    out = {
        "query": query,
        "top_k": top_k,
        "results": [
            {
                "rank": i,
                "score": round(s, 4),
                "id": c.get("id"),
                "repo": c.get("repo"),
                "language": c.get("language"),
                "bug_type": c.get("bug_type"),
                "quality_score": c.get("quality_score"),
                "quality_tier": c.get("quality_tier"),
                "symptom": (c.get("symptom") or "")[:300],
                "fix_pattern": (c.get("fix_pattern") or "")[:300],
                "key_files": c.get("key_files") or [],
                "test_signal": c.get("test_signal"),
                "why": why_matched(c, query),
            }
            for i, (s, c) in enumerate(results, start=1)
        ],
        "patterns": patterns,
        "signals": signals,
        "next_steps": _derive_next_steps(query, results, signals),
        "warnings": warnings,
    }
    if repo_context:
        out["repo_context"] = _summarize_repo_context(repo_context)
    return out


def _summarize_repo_context(ctx: dict[str, Any]) -> dict[str, Any]:
    """Compress a full explorer result into a small dict for the guide."""
    return {
        "languages": ctx.get("languages") or [],
        "top_files": [tf.get("path") for tf in (ctx.get("top_files") or [])[:5]],
        "symbols": [
            {"name": s.get("name"), "file": s.get("file"), "line": s.get("line")}
            for s in (ctx.get("symbols") or [])[:10]
        ],
        "test_files": (ctx.get("test_files") or [])[:5],
        "config_files": (ctx.get("config_files") or [])[:5],
        "recent_files": (ctx.get("recent_files") or [])[:5],
    }


def guide_text(query: str, cards: list[dict[str, Any]], *, top_k: int = 5,
               repo_context: dict[str, Any] | None = None,
               same_language: str | None = None) -> str:
    """Plain-text repair brief."""
    g = generate_guide(query, cards, top_k=top_k, repo_context=repo_context, same_language=same_language)
    # Re-run search to get the (score, card) tuples for formatting
    idx = BM25FIndex(cards)
    if same_language:
        results = idx.search(query, top_k=top_k, language=same_language, same_language_boost=0.2)
    else:
        results = idx.search(query, top_k=top_k)
    text = _format_text(g["query"], results, g["patterns"], g["signals"], g["warnings"])
    if g.get("repo_context"):
        text += "\n\n" + _format_repo_context_block(g["repo_context"])
    return text


def _format_repo_context_block(ctx: dict[str, Any]) -> str:
    """Format repo context as a short block to append to the guide text."""
    out: list[str] = []
    out.append("=== Repo Context (from cheater explorer) ===")
    if ctx.get("languages"):
        out.append(f"  Languages: {', '.join(ctx['languages'])}")
    if ctx.get("top_files"):
        out.append("  Top files:")
        for f in ctx["top_files"][:5]:
            out.append(f"    - {f}")
    if ctx.get("symbols"):
        out.append("  Symbols:")
        for s in ctx["symbols"][:10]:
            out.append(f"    - {s.get('name')}  @ {s.get('file')}:{s.get('line')}")
    if ctx.get("test_files"):
        out.append("  Test files:")
        for f in ctx["test_files"][:5]:
            out.append(f"    - {f}")
    if ctx.get("config_files"):
        out.append("  Config files:")
        for f in ctx["config_files"][:5]:
            out.append(f"    - {f}")
    if ctx.get("recent_files"):
        out.append("  Recent git changes:")
        for f in ctx["recent_files"][:5]:
            out.append(f"    - {f}")
    return "\n".join(out)

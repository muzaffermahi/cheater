"""Cheater context optimizer.

The optimizer takes a ContextPack (or any ordered list of "sections") and
shrinks it to fit a small budget, intelligently. The goal is to make the
"smallest context that should still be useful" available to a 9B model.

This is the *measurement* layer above ContextPack: same idea, but:

  * assigns each section a numeric score
  * has named budgets (tiny / small / normal / large)
  * caps low-value sections first (not just by priority)
  * tracks which included sections actually helped a fix
  * produces ablation reports over many traces

The optimizer does NOT rebuild context from scratch. It just decides
which sections to keep, clip, or drop, and how much to clip each.

Public API:
    Budget                                 -- enum-like constants
    BUDGETS                                 -- name -> max_chars map
    ContextSection                          -- typed wrapper
    optimize_context_pack(pack, budget)     -- shrink a ContextPack
    score_context_section(section, task)    -- 0..1 score
    estimate_tokens(text)                   -- cheap token estimate
    record_context_usage(trace)            -- count section usage
    context_ablation_report(traces)         -- aggregate usage stats
    rank_sections_for_budget(sections, ...) -- utility
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Iterable


CHARS_PER_TOKEN = 4  # matches cheater.budget.CHAR_PER_TOKEN


def estimate_tokens(text: str) -> int:
    """Rough token estimate. Stable, deterministic, fast."""
    if not text:
        return 0
    return (len(text) + CHARS_PER_TOKEN - 1) // CHARS_PER_TOKEN


# ---- budgets ----


class Budget:
    TINY = "tiny"
    SMALL = "small"
    NORMAL = "normal"
    LARGE = "large"

    ALL: tuple[str, ...] = (TINY, SMALL, NORMAL, LARGE)


# Default budgets (chars). Roughly:
#   tiny  ~ 2k tokens  -> list_files + traceback only
#   small ~ 4k tokens  -> add localized source, narrow memory
#   normal ~ 8k tokens -> default (current ContextPack default)
#   large ~ 16k tokens -> everything that scored > 0.2
BUDGETS: dict[str, int] = {
    Budget.TINY: 2_000 * CHARS_PER_TOKEN,
    Budget.SMALL: 4_000 * CHARS_PER_TOKEN,
    Budget.NORMAL: 8_000 * CHARS_PER_TOKEN,
    Budget.LARGE: 16_000 * CHARS_PER_TOKEN,
}


# Sections that should be kept even if they don't score well, because
# dropping them breaks the model. Lower number = more important.
_PROTECTED_SECTIONS: dict[str, int] = {
    "task": 0,  # never drop
    "traceback": 5,  # keep at least a small slice
    "failure_summary": 8,
    "localized_source": 12,
    "tests": 15,
}


# Sections with a hard cap regardless of budget.
_SECTION_CAPS: dict[str, int] = {
    "memory": 600,  # 150 tokens max
    "skills": 600,
    "instructions": 1_200,
    "repo_map": 3_000,
    "tests": 800,
    "files": 6_000,
}


# Low-value section names (dropped first).
_LOW_VALUE: set[str] = {"instructions", "skills", "memory", "repo_map"}


# ---- section ----


@dataclass
class ContextSection:
    """A single context chunk. Mirrors cheater.context_pack.ContextProvider."""

    name: str
    body: str
    label: str = ""
    priority: int = 50
    metadata: dict[str, Any] = field(default_factory=dict)
    usage_count: int = 0  # how often this section type helped a fix
    last_score: float = 0.0  # last computed score (debug)

    def char_len(self) -> int:
        return len(self.body or "")

    def token_len(self) -> int:
        return estimate_tokens(self.body or "")

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "label": self.label or self.name,
            "priority": self.priority,
            "char_len": self.char_len(),
            "token_len": self.token_len(),
            "metadata": dict(self.metadata),
            "usage_count": self.usage_count,
            "last_score": round(self.last_score, 3),
        }


# ---- scoring ----

_TOKEN_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*|\d+")
_STOPWORDS: set[str] = {
    "the",
    "is",
    "at",
    "which",
    "on",
    "a",
    "an",
    "and",
    "or",
    "but",
    "in",
    "with",
    "to",
    "for",
    "of",
    "as",
    "by",
    "this",
    "that",
    "it",
    "from",
    "be",
    "are",
    "was",
    "were",
    "not",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "doing",
    "i",
    "we",
    "you",
    "your",
    "they",
    "he",
    "she",
    "them",
    "us",
    "me",
    "my",
    "our",
    "fix",
    "make",
    "use",
    "used",
    "test",
    "tests",
    "run",
    "runs",
    "file",
    "files",
    "line",
    "lines",
    "code",
    "agent",
    "task",
    "work",
    "works",
    "step",
    "steps",
    "error",
    "errors",
}


def _task_tokens(task: str) -> set[str]:
    if not task:
        return set()
    return {
        t.lower()
        for t in _TOKEN_RE.findall(task)
        if len(t) >= 2 and t.lower() not in _STOPWORDS
    }


def score_context_section(
    section: ContextSection | dict[str, Any],
    task_signature: str = "",
) -> float:
    """Return a 0..1 score for this section.

    Heuristics:
      * protected sections (task, traceback, failure_summary) get a 1.0 floor
      * overlap with task signature boosts the score
      * low-value sections cap at 0.6
      * tiny sections get a small penalty (often noise)
    """
    if isinstance(section, dict):
        s = ContextSection(
            name=section.get("name", ""),
            body=section.get("body", ""),
            label=section.get("label", section.get("name", "")),
            priority=int(section.get("priority", 50)),
            metadata=section.get("metadata", {}) or {},
        )
    else:
        s = section
    name = s.name
    body = s.body or ""
    q = _task_tokens(task_signature)
    if name in _PROTECTED_SECTIONS:
        base = 0.85
    elif name in _LOW_VALUE:
        base = 0.4
    else:
        base = 0.55
    # Token overlap
    if q and body:
        body_tokens = {
            t.lower()
            for t in _TOKEN_RE.findall(body)
            if len(t) >= 2 and t.lower() not in _STOPWORDS
        }
        if body_tokens:
            overlap = len(q & body_tokens) / max(1, len(q))
            base += 0.4 * overlap
    # Section length penalty (huge sections probably not worth it)
    if s.char_len() > 6_000:
        base -= 0.1
    if s.char_len() < 30:
        base -= 0.1
    # Past usage bonus
    base += min(0.2, 0.02 * (s.usage_count or 0))
    return max(0.0, min(1.0, base))


# ---- optimizer ----


@dataclass
class OptimizationResult:
    budget_name: str
    max_chars: int
    kept: list[ContextSection] = field(default_factory=list)
    dropped: list[ContextSection] = field(default_factory=list)
    clipped: list[ContextSection] = field(default_factory=list)
    total_chars_before: int = 0
    total_chars_after: int = 0
    estimated_tokens: int = 0
    actions: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "budget": self.budget_name,
            "max_chars": self.max_chars,
            "total_chars_before": self.total_chars_before,
            "total_chars_after": self.total_chars_after,
            "estimated_tokens": self.estimated_tokens,
            "kept": [s.to_dict() for s in self.kept],
            "dropped": [s.name for s in self.dropped],
            "clipped": [s.name for s in self.clipped],
            "actions": list(self.actions),
        }


def _to_sections(pack: Any) -> list[ContextSection]:
    """Convert a ContextPack or list of providers into ContextSections."""
    if pack is None:
        return []
    if hasattr(pack, "providers") and isinstance(pack.providers, list):
        providers = pack.providers
    elif isinstance(pack, list):
        providers = pack
    else:
        return []
    out: list[ContextSection] = []
    for p in providers:
        # p may be a ContextProvider dataclass OR a dict OR a ContextSection
        if isinstance(p, ContextSection):
            out.append(p)
            continue
        if isinstance(p, dict):
            out.append(
                ContextSection(
                    name=str(p.get("name", "")),
                    body=str(p.get("body", "")),
                    label=str(p.get("label", p.get("name", ""))),
                    priority=int(p.get("priority", 50)),
                    metadata=dict(p.get("metadata", {}) or {}),
                )
            )
            continue
        # Assume dataclass with .name, .body, .priority, .metadata
        out.append(
            ContextSection(
                name=str(getattr(p, "name", "")),
                body=str(getattr(p, "body", "") or ""),
                label=str(getattr(p, "label", "") or getattr(p, "name", "")),
                priority=int(getattr(p, "priority", 50)),
                metadata=dict(getattr(p, "metadata", {}) or {}),
            )
        )
    return out


def rank_sections_for_budget(
    sections: list[ContextSection],
    task_signature: str = "",
) -> list[tuple[ContextSection, float]]:
    """Return sections sorted by (score desc, priority asc)."""
    scored: list[tuple[ContextSection, float]] = []
    for s in sections:
        sc = score_context_section(s, task_signature)
        s.last_score = sc
        scored.append((s, sc))
    scored.sort(key=lambda pair: (-pair[1], pair[0].priority))
    return scored


def optimize_context_pack(
    pack: Any,
    budget: str | int = Budget.NORMAL,
    *,
    task_signature: str = "",
    min_keep: tuple[str, ...] = ("task",),
) -> OptimizationResult:
    """Shrink a pack to fit a budget.

    `budget` may be a name from Budget.* or an int (max chars).
    `min_keep` is a tuple of section names that must remain (truncated if
    needed) no matter what.
    """
    if isinstance(budget, int):
        max_chars = max(200, budget)
        budget_name = f"custom:{budget}"
    else:
        if budget not in BUDGETS:
            budget = Budget.NORMAL
        max_chars = BUDGETS[budget]
        budget_name = budget
    sections = _to_sections(pack)
    result = OptimizationResult(budget_name=budget_name, max_chars=max_chars)
    result.total_chars_before = sum(s.char_len() for s in sections)
    # 1) Protected sections: always keep (truncated if needed)
    kept: list[ContextSection] = []
    protected_names = set(_PROTECTED_SECTIONS) | set(min_keep)
    for s in sections:
        if s.name in protected_names:
            s.last_score = score_context_section(s, task_signature)
            kept.append(s)
    # 2) Score and rank the rest
    rest = [s for s in sections if s.name not in protected_names]
    ranked = rank_sections_for_budget(rest, task_signature=task_signature)
    used = sum(s.char_len() for s in kept)
    for s, sc in ranked:
        # Cap by section type
        cap = _SECTION_CAPS.get(s.name)
        body = s.body or ""
        if cap is not None and len(body) > cap:
            body = body[: max(0, cap - 30)] + "\n...[truncated]"
            s.body = body
            result.clipped.append(s)
            result.actions.append(f"clipped:{s.name}:cap")
        if used + s.char_len() <= max_chars:
            kept.append(s)
            used += s.char_len()
        else:
            # Try clipping to fit
            remaining = max_chars - used
            if remaining >= 80 and sc >= 0.4:
                s.body = s.body[: max(0, remaining - 30)] + "\n...[truncated]"
                kept.append(s)
                used += s.char_len()
                result.clipped.append(s)
                result.actions.append(f"clipped:{s.name}")
            else:
                result.dropped.append(s)
                result.actions.append(f"dropped:{s.name}")
    # 3) If task/traceback pushed us over, truncate them last
    for s in kept:
        if used <= max_chars:
            break
        if s.name in min_keep:
            allowed = max(50, max_chars - (used - s.char_len()))
            if allowed < s.char_len():
                s.body = s.body[: max(0, allowed - 30)] + "\n...[truncated]"
                used = max_chars
                result.clipped.append(s)
                result.actions.append(f"clipped:{s.name}:protected")
    result.kept = kept
    result.total_chars_after = sum(s.char_len() for s in kept)
    result.estimated_tokens = estimate_tokens("".join(s.body for s in kept))
    return result


# ---- usage tracking ----


def record_context_usage(trace: list[dict[str, Any]]) -> dict[str, int]:
    """Walk a trace, count section usage from context_pack_built events
    and the actions the model took.

    The model "uses" a section if it appears in a successful patch's
    visible context. The current implementation approximates that by
    counting the providers in the *first* context_pack_built event of the
    run. (Full fidelity would require pairing the patch with the
    preceding context; this is a cheap, useful signal.)
    """
    used: Counter[str] = Counter()
    for ev in trace:
        if not isinstance(ev, dict):
            continue
        ev_type = str(ev.get("event", ""))
        payload = ev.get("payload") if isinstance(ev.get("payload"), dict) else {}
        if ev_type == "context_pack_built":
            providers = payload.get("providers") or []
            for p in providers:
                if isinstance(p, dict) and p.get("name"):
                    used[p["name"]] += 1
        elif ev_type == "model_prompt":
            # The prompt itself sometimes names the section (rough)
            text = payload.get("prompt_excerpt") or payload.get("prompt") or ""
            if text:
                for marker in (
                    "Task:",
                    "Traceback",
                    "Failure summary",
                    "Localized",
                    "Repo map",
                    "Memory",
                    "Skills",
                    "Tests:",
                ):
                    if marker.lower() in text.lower():
                        used[_marker_to_section(marker)] += 1
    return dict(used)


def _marker_to_section(marker: str) -> str:
    return {
        "Task:": "task",
        "Traceback": "traceback",
        "Failure summary": "failure_summary",
        "Localized": "localized_source",
        "Repo map": "repo_map",
        "Memory": "memory",
        "Skills": "skills",
        "Tests:": "tests",
    }.get(marker, "unknown")


# ---- ablation report ----


def context_ablation_report(
    traces: list[list[dict[str, Any]]] | list[dict[str, Any]],
) -> dict[str, Any]:
    """Aggregate context-usage stats across many traces.

    The result is a small dict with per-section counts and a top-level
    `recommendation` that says which sections to keep under each budget.
    """
    if traces and isinstance(traces[0], dict):
        traces_list = [t for t in traces if isinstance(t, list)]  # tolerate
        if not traces_list:
            # Maybe traces is a list of single events; fall back to wrapping
            traces_list = [list(traces)]  # type: ignore[arg-type]
    else:
        traces_list = [t for t in traces if isinstance(t, list)]  # type: ignore[arg-type]
    section_uses: Counter[str] = Counter()
    runs_with_pack = 0
    runs_total = len(traces_list)
    for tr in traces_list:
        used = record_context_usage(tr)
        if used:
            runs_with_pack += 1
        section_uses.update(used)
    # Build a recommendation per budget
    recommendations: dict[str, list[str]] = {}
    sorted_sections = [s for s, _ in section_uses.most_common()]
    for name, cap in BUDGETS.items():
        # Greedy: take top sections whose cap fits
        keep: list[str] = []
        used_chars = 0
        # Always keep protected
        for must in ("task", "traceback", "failure_summary"):
            keep.append(must)
        for s in sorted_sections:
            if s in keep:
                continue
            sec_cap = _SECTION_CAPS.get(s, 1_000)
            if used_chars + sec_cap <= cap:
                keep.append(s)
                used_chars += sec_cap
        recommendations[name] = keep
    return {
        "runs_total": runs_total,
        "runs_with_pack": runs_with_pack,
        "section_uses": dict(section_uses.most_common()),
        "recommendations": recommendations,
    }

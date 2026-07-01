"""Cheater skill janitor.

Skills and memories grow over time. The janitor keeps them honest:

  * flags duplicate / overlapping skills
  * flags conflicting skills (same trigger, opposite advice)
  * flags low-success-rate skills
  * suggests merges and deletions (but never auto-applies)
  * compresses verbose skills to their essentials

Skills live as Markdown files under a skill directory
(default: <repo>/.cheater/skills/, fallback: ~/.config/cheater/skills/).
A skill is a Markdown document with a YAML-ish front-matter block:

    ---
    name: import-error-fast-path
    triggers: [import, module not found, importerror]
    tags: [python, import]
    success: 7
    failure: 2
    ---
    # Import error fast path
    ...

The janitor is read-only unless --apply is passed. In --apply mode it will
rewrite the affected skills to merge duplicates and delete the marked
items. (Auto-deletion is OFF by default per the project policy.)

Public API:
    SkillItem                          -- in-memory representation
    parse_skill(path)                  -- SkillItem
    audit_skills(skill_dir, usage_stats) -> AuditReport
    audit_memories(memory_store)       -> AuditReport
    suggest_merges(items)              -> list[MergeSuggestion]
    suggest_deletions(items)           -> list[DeletionSuggestion]
    compress_skill(skill_md)           -> str

CLI:
    cheater janitor skills
    cheater janitor memory
    cheater janitor all
"""

from __future__ import annotations

import json
import re
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable


# Minimum length of a useful skill body (chars)
MIN_SKILL_BODY_CHARS = 80

# Triggers below this overlap are NOT considered duplicates
TRIGGER_OVERLAP_THRESHOLD = 0.6

# Low success rate threshold
LOW_SUCCESS_RATE = 0.4

# Opposite-advice words (used to detect conflicts)
_OPPOSITES: list[tuple[set[str], set[str]]] = [
    (
        {"yes", "do", "use", "prefer", "always", "should"},
        {"no", "don't", "do not", "avoid", "never", "should not", "shouldn't"},
    ),
]


# ---- data types ----


@dataclass
class SkillItem:
    name: str
    path: Path
    triggers: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    body: str = ""
    front_matter: dict[str, Any] = field(default_factory=dict)
    success: int = 0
    failure: int = 0
    last_used: float = 0.0

    @property
    def total_uses(self) -> int:
        return self.success + self.failure

    @property
    def success_rate(self) -> float:
        if self.total_uses == 0:
            return 0.0
        return self.success / self.total_uses

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "path": str(self.path),
            "triggers": list(self.triggers),
            "tags": list(self.tags),
            "body_chars": len(self.body or ""),
            "success": self.success,
            "failure": self.failure,
            "success_rate": round(self.success_rate, 3),
            "total_uses": self.total_uses,
            "last_used": self.last_used,
        }


@dataclass
class MergeSuggestion:
    a: str
    b: str
    overlap: float
    reason: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": "merge",
            "a": self.a,
            "b": self.b,
            "overlap": round(self.overlap, 3),
            "reason": self.reason,
        }


@dataclass
class DeletionSuggestion:
    name: str
    reason: str
    confidence: float = 0.5

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": "delete",
            "name": self.name,
            "reason": self.reason,
            "confidence": round(self.confidence, 3),
        }


@dataclass
class AuditReport:
    items: list[SkillItem] = field(default_factory=list)
    merges: list[MergeSuggestion] = field(default_factory=list)
    deletions: list[DeletionSuggestion] = field(default_factory=list)
    conflicts: list[dict[str, Any]] = field(default_factory=list)
    low_success: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "items": [i.to_dict() for i in self.items],
            "merges": [m.to_dict() for m in self.merges],
            "deletions": [d.to_dict() for d in self.deletions],
            "conflicts": list(self.conflicts),
            "low_success": list(self.low_success),
        }


# ---- skill loading ----

_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n(.*)$", re.DOTALL)


def parse_skill(path: Path) -> SkillItem | None:
    """Parse one .md skill file. Returns None on failure."""
    if not path.is_file():
        return None
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return None
    front: dict[str, Any] = {}
    body = text
    m = _FRONTMATTER_RE.match(text)
    if m:
        fm_text = m.group(1)
        body = m.group(2)
        for line in fm_text.splitlines():
            line = line.rstrip()
            if not line or line.startswith("#"):
                continue
            if ":" not in line:
                continue
            k, _, v = line.partition(":")
            k = k.strip()
            v = v.strip()
            if v.startswith("[") and v.endswith("]"):
                inner = v[1:-1]
                front[k] = [
                    x.strip().strip('"').strip("'")
                    for x in inner.split(",")
                    if x.strip()
                ]
            elif v.lower() in ("true", "false"):
                front[k] = v.lower() == "true"
            else:
                try:
                    if "." in v:
                        front[k] = float(v)
                    else:
                        front[k] = int(v)
                except ValueError:
                    front[k] = v.strip('"').strip("'")
    name = str(front.get("name", "") or path.stem)
    triggers = front.get("triggers") or []
    if isinstance(triggers, str):
        triggers = [t.strip() for t in triggers.split(",") if t.strip()]
    if not isinstance(triggers, list):
        triggers = []
    triggers = [str(t) for t in triggers]
    tags = front.get("tags") or []
    if isinstance(tags, str):
        tags = [t.strip() for t in tags.split(",") if t.strip()]
    if not isinstance(tags, list):
        tags = []
    tags = [str(t) for t in tags]
    success = int(front.get("success", 0) or 0)
    failure = int(front.get("failure", 0) or 0)
    last_used = float(front.get("last_used", 0) or 0.0)
    return SkillItem(
        name=name,
        path=path,
        triggers=triggers,
        tags=tags,
        body=body,
        front_matter=front,
        success=success,
        failure=failure,
        last_used=last_used,
    )


def _default_skill_dirs() -> list[Path]:
    """Find the project's and user's skill directories (in that order)."""
    cwd = Path.cwd()
    candidates: list[Path] = []
    cur = cwd
    for parent in [cur, *cur.parents]:
        candidate = parent / ".cheater" / "skills"
        if candidate.is_dir():
            candidates.append(candidate)
    candidates.append(Path.home() / ".config" / "cheater" / "skills")
    # De-dup, preserve order
    seen: set[str] = set()
    out: list[Path] = []
    for c in candidates:
        if str(c) in seen:
            continue
        seen.add(str(c))
        out.append(c)
    return out


def load_skills(skill_dir: str | Path | None = None) -> list[SkillItem]:
    if skill_dir is None:
        dirs = _default_skill_dirs()
        items: list[SkillItem] = []
        for d in dirs:
            items.extend(_load_from_dir(d))
        return items
    return _load_from_dir(Path(skill_dir))


def _load_from_dir(d: Path) -> list[SkillItem]:
    if not d.is_dir():
        return []
    out: list[SkillItem] = []
    for p in sorted(d.glob("*.md")):
        item = parse_skill(p)
        if item:
            out.append(item)
    return out


# ---- dedup / conflict / low-success detection ----


def _trigger_overlap(a: list[str], b: list[str]) -> float:
    if not a or not b:
        return 0.0
    sa = {t.lower() for t in a}
    sb = {t.lower() for t in b}
    inter = sa & sb
    if not inter:
        return 0.0
    return len(inter) / min(len(sa), len(sb))


def _body_overlap(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    ta = {t.lower() for t in re.findall(r"[A-Za-z_][A-Za-z0-9_]{2,}", a)} - _STOPWORDS
    tb = {t.lower() for t in re.findall(r"[A-Za-z_][A-Za-z0-9_]{2,}", b)} - _STOPWORDS
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / min(len(ta), len(tb))


_STOPWORDS: set[str] = {
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "into",
    "your",
    "fix",
    "make",
    "use",
    "used",
    "test",
    "tests",
    "run",
    "running",
    "file",
    "files",
    "line",
    "lines",
    "code",
    "task",
    "error",
    "errors",
    "should",
    "must",
    "can",
    "will",
    "would",
}


def _has_opposite_advice(a: str, b: str) -> bool:
    if not a or not b:
        return False
    la, lb = a.lower(), b.lower()
    for pos_words, neg_words in _OPPOSITES:
        for w in pos_words:
            for nw in neg_words:
                if w in la and nw in lb:
                    return True
                if w in lb and nw in la:
                    return True
    return False


def suggest_merges(items: list[SkillItem]) -> list[MergeSuggestion]:
    out: list[MergeSuggestion] = []
    n = len(items)
    for i in range(n):
        for j in range(i + 1, n):
            a, b = items[i], items[j]
            tover = _trigger_overlap(a.triggers, b.triggers)
            if tover >= TRIGGER_OVERLAP_THRESHOLD:
                out.append(
                    MergeSuggestion(
                        a=a.name,
                        b=b.name,
                        overlap=tover,
                        reason=f"trigger overlap {tover:.2f} >= {TRIGGER_OVERLAP_THRESHOLD}",
                    )
                )
                continue
            bover = _body_overlap(a.body, b.body)
            if bover >= 0.8 and (a.triggers or b.triggers):
                out.append(
                    MergeSuggestion(
                        a=a.name,
                        b=b.name,
                        overlap=bover,
                        reason=f"body overlap {bover:.2f} (near-duplicate content)",
                    )
                )
    return out


def _detect_conflicts(items: list[SkillItem]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    n = len(items)
    for i in range(n):
        for j in range(i + 1, n):
            a, b = items[i], items[j]
            tover = _trigger_overlap(a.triggers, b.triggers)
            if tover < TRIGGER_OVERLAP_THRESHOLD:
                continue
            if _has_opposite_advice(a.body, b.body):
                out.append(
                    {
                        "a": a.name,
                        "b": b.name,
                        "trigger_overlap": round(tover, 3),
                        "reason": "overlapping triggers but opposite advice",
                    }
                )
    return out


def _low_success_skills(items: list[SkillItem]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for it in items:
        if it.total_uses >= 3 and it.success_rate < LOW_SUCCESS_RATE:
            out.append(
                {
                    "name": it.name,
                    "success_rate": round(it.success_rate, 3),
                    "total_uses": it.total_uses,
                    "reason": f"success rate < {LOW_SUCCESS_RATE} after {it.total_uses} uses",
                }
            )
    return out


def suggest_deletions(items: list[SkillItem]) -> list[DeletionSuggestion]:
    """Suggest skills to delete: too short, too stale, or never used and conflicting."""
    out: list[DeletionSuggestion] = []
    now = 0.0  # epoch float; we just use last_used ordering
    for it in items:
        if len(it.body or "") < MIN_SKILL_BODY_CHARS and it.total_uses == 0:
            out.append(
                DeletionSuggestion(
                    name=it.name,
                    reason=f"skill body < {MIN_SKILL_BODY_CHARS} chars and never used",
                    confidence=0.8,
                )
            )
            continue
        if it.total_uses == 0 and (now - it.last_used) > 60 * 60 * 24 * 180:
            out.append(
                DeletionSuggestion(
                    name=it.name,
                    reason="never used in 180+ days",
                    confidence=0.5,
                )
            )
    return out


# ---- audit ----


def audit_skills(
    skill_dir: str | Path | None = None,
    usage_stats: dict[str, dict[str, int]] | None = None,
) -> AuditReport:
    """Audit the skill directory. Optional usage_stats overrides front-matter counts."""
    items = load_skills(skill_dir)
    if usage_stats:
        for it in items:
            st = usage_stats.get(it.name)
            if isinstance(st, dict):
                if "success" in st:
                    it.success = int(st["success"] or 0)
                if "failure" in st:
                    it.failure = int(st["failure"] or 0)
                if "last_used" in st:
                    try:
                        it.last_used = float(st["last_used"])
                    except (TypeError, ValueError):
                        pass
    return AuditReport(
        items=items,
        merges=suggest_merges(items),
        deletions=suggest_deletions(items),
        conflicts=_detect_conflicts(items),
        low_success=_low_success_skills(items),
    )


def audit_memories(memory_store: Any) -> AuditReport:
    """Audit the curated memory store. Returns an AuditReport with
    duplicates / low-use entries. Memory items are returned as SkillItem
    placeholders so the same UI can render both.
    """
    items: list[SkillItem] = []
    try:
        all_entries = memory_store.all()
    except Exception:
        all_entries = []
    by_text: dict[str, str] = {}
    for e in all_entries:
        text = (e.text or "").strip().lower()
        if not text:
            continue
        placeholder = SkillItem(
            name=e.id,
            path=Path(f"memory:{e.id}"),
            triggers=[],
            tags=list(e.tags or []),
            body=(e.text or "")[:500],
            success=int(getattr(e, "use_count", 0) or 0),
            failure=0,
            last_used=float(getattr(e, "last_used_at", 0) or 0.0),
        )
        items.append(placeholder)
        if text in by_text:
            by_text[text] = e.id
        else:
            by_text[text] = e.id
    # Duplicates
    merges: list[MergeSuggestion] = []
    text_groups: dict[str, list[SkillItem]] = defaultdict(list)
    for it in items:
        key = (it.body or "").strip().lower()[:120]
        text_groups[key].append(it)
    for key, group in text_groups.items():
        if len(group) > 1 and key:
            names = [g.name for g in group]
            merges.append(
                MergeSuggestion(
                    a=names[0],
                    b=names[1],
                    overlap=1.0,
                    reason="identical or near-identical memory text",
                )
            )
    # Stale entries (use_count == 0 and old)
    deletions: list[DeletionSuggestion] = []
    for it in items:
        if it.success == 0:
            deletions.append(
                DeletionSuggestion(
                    name=it.name,
                    reason="memory has use_count=0 (never used)",
                    confidence=0.3,
                )
            )
    return AuditReport(
        items=items,
        merges=merges,
        deletions=deletions,
        conflicts=[],
        low_success=[],
    )


# ---- compression ----


def compress_skill(skill_md: str, max_chars: int = 600) -> str:
    """Return a shortened version of a skill: keep heading + first
    paragraph + key bullets. Used to de-bloat long skills.
    """
    if not skill_md:
        return ""
    if len(skill_md) <= max_chars:
        return skill_md
    lines = skill_md.splitlines()
    out: list[str] = []
    seen_heading = False
    for line in lines:
        # Decide whether to add the line
        if line.startswith("# "):
            candidate = line
        elif line.startswith("## "):
            candidate = line
        elif line.startswith("- "):
            candidate = line
        elif line.strip():
            if not seen_heading:
                candidate = line
            else:
                candidate = line
        else:
            candidate = None  # blank line
        if candidate is not None:
            # Will adding this line exceed the budget?
            prospective_len = sum(len(x) for x in out) + len(candidate) + 1
            if prospective_len > max_chars:
                out.append("...[truncated]")
                break
            if line.startswith("# "):
                seen_heading = True
            out.append(candidate)
    return "\n".join(out)

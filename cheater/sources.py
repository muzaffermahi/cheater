"""Card sources: convert raw records into canonical v1 card dicts.

These are streaming adapters (CardSource extension point). The compact-card
source reuses the existing LLM-compacted corpus (data/compact_bug_cards.jsonl)
without calling any API. The model-based compaction script (04_compact_cards_llm.py)
is preserved as the LLM provider interface and is NOT required for tests.

The HFDatasetSource streams directly from nebius/SWE-agent-trajectories
(all ~80k rows) and converts each row to a v1 card in a single pass. Solved
trajectories (target=True) become usable=true memory cards; unsolved ones
(target=False) become usable=false and are excluded from the default index.
"""

from __future__ import annotations

import re
from typing import Any, Iterator

from cheater.cards import read_jsonl
from cheater.schema import stable_id

DATASET_NAME = "nebius/SWE-agent-trajectories"

_ERROR_HINTS = [
    "Traceback", "AssertionError", "TypeError", "ValueError", "KeyError",
    "IndexError", "AttributeError", "ImportError", "ModuleNotFoundError",
    "HTTPError", "Exception", "FAILED", "FAIL", "ERROR", "Error", "pytest", "tox",
]

_STACK_RE = re.compile(
    r"(Traceback[\s\S]{0,2500}?)(?=\n\n|\Z)|"
    r"((?:AssertionError|TypeError|ValueError|KeyError|IndexError|AttributeError"
    r"|ImportError|ModuleNotFoundError|HTTPError|Exception|FAILED|ERROR|Error)"
    r"[^\n]*(?:\n.{0,240}){0,12})",
    re.IGNORECASE,
)


def _repo_from_instance_id(instance_id: str) -> str | None:
    """Best-effort repo parse from SWE-bench-style id 'owner__repo-NN'."""
    if not instance_id:
        return None
    base = re.sub(r"-\d+$", "", instance_id)
    if "__" in base:
        owner, _, rest = base.partition("__")
        return f"{owner}/{rest}" if rest else None
    return None


def compact_to_v1(raw: dict[str, Any]) -> dict[str, Any]:
    """Map an old compact_bug_cards record to canonical v1 fields."""
    instance_id = str(raw.get("id") or "")
    symptoms = raw.get("symptoms") or []
    if isinstance(symptoms, str):
        symptoms = [symptoms]
    symptom_parts = [str(s) for s in symptoms if str(s).strip()]
    error_sig = str(raw.get("error_signature") or "").strip()
    title = str(raw.get("title") or "").strip()
    symptom = " | ".join([error_sig, *symptom_parts]) if error_sig else (
        title if title else " | ".join(symptom_parts)
    )

    return {
        "id": instance_id or stable_id(str(raw.get("source") or "compact"), str(raw.get("id") or "")),
        "source": str(raw.get("source") or "nebius/SWE-agent-trajectories"),
        "repo": _repo_from_instance_id(instance_id),
        "language": str(raw.get("language_or_framework") or "") or None,
        "bug_type": str(raw.get("bug_type") or "") or None,
        "symptom": symptom or None,
        "root_cause": str(raw.get("root_cause") or "") or None,
        "fix_pattern": str(raw.get("fix_pattern") or "") or None,
        "failed_approaches": [str(a) for a in (raw.get("avoid") or []) if str(a).strip()],
        "key_files": [str(f) for f in (raw.get("changed_files") or []) if str(f).strip()],
        "test_signal": error_sig or None,
        "search_keywords": [str(w) for w in (raw.get("when_to_use") or []) if str(w).strip()],
        "embedding_text": str(raw.get("search_text") or "") or None,
        "usable": True,
    }


def solved_to_v1(raw: dict[str, Any]) -> dict[str, Any]:
    """Map a solved_bug_cards (raw trajectory) record to canonical v1 fields.

    These are lighter-quality (no LLM summary) but still usable as memory.
    """
    instance_id = str(raw.get("id") or "")
    issue = str(raw.get("issue") or "").strip()
    error_excerpt = str(raw.get("error_excerpt") or "").strip()
    patch_summary = str(raw.get("patch_summary") or "").strip()
    symptom = error_excerpt or issue[:300]
    embedding_text = " ".join(filter(None, [issue[:1500], error_excerpt, patch_summary]))

    return {
        "id": instance_id,
        "source": str(raw.get("source") or "nebius/SWE-agent-trajectories"),
        "repo": _repo_from_instance_id(instance_id),
        "language": None,
        "bug_type": None,
        "symptom": symptom or None,
        "root_cause": None,
        "fix_pattern": patch_summary or None,
        "failed_approaches": [],
        "key_files": [str(f) for f in (raw.get("changed_files") or []) if str(f).strip()],
        "test_signal": error_excerpt or None,
        "search_keywords": [],
        "embedding_text": embedding_text or None,
        "usable": bool(symptom and embedding_text),
    }


class CompactCardSource:
    """Streaming source over an old compact_bug_cards JSONL file."""

    name = "compact_cards"

    def __init__(self, path: str) -> None:
        self.path = path

    def iter_records(self) -> Iterator[dict[str, Any]]:
        for raw in read_jsonl(self.path):
            yield compact_to_v1(raw)


class SolvedCardSource:
    """Streaming source over a solved_bug_cards JSONL file."""

    name = "solved_trajectory_cards"

    def __init__(self, path: str) -> None:
        self.path = path

    def iter_records(self) -> Iterator[dict[str, Any]]:
        for raw in read_jsonl(self.path):
            yield solved_to_v1(raw)


def _get_issue_text(trajectory: list[dict[str, Any]]) -> str:
    """Find the initial issue text inside a SWE-agent trajectory."""
    for item in trajectory:
        if item.get("role") == "user":
            text = item.get("text") or ""
            if "ISSUE:" in text or "issue" in text.lower():
                return _clean_issue_text(text)
    for item in trajectory:
        if item.get("role") == "user":
            text = item.get("text") or ""
            if text.strip():
                return _clean_issue_text(text)
    return ""


def _clean_issue_text(text: str) -> str:
    """Strip SWE-agent boilerplate to get the raw issue content."""
    text = text.strip()
    for marker in ("Here's the issue text:\n", "Here is the issue text:\n"):
        if marker in text:
            text = text.split(marker, 1)[1]
            break
    if text.startswith("ISSUE:"):
        text = text[6:].strip()
    elif text.startswith("ISSUE:\n"):
        text = text[7:].strip()
    # Remove trailing agent instructions
    for marker in ("\n\nINSTRUCTIONS:", "\nPlease fix the issue", "\nWe're currently solving"):
        idx = text.find(marker)
        if idx > 0:
            text = text[:idx].strip()
    return text[:3000]


def _trajectory_to_text(trajectory: list[dict[str, Any]], max_chars: int = 8000) -> str:
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


def _extract_error_excerpt(*texts: str, max_chars: int = 2000) -> str:
    combined = "\n\n".join(t for t in texts if t)
    matches: list[str] = []
    for match in _STACK_RE.finditer(combined):
        chunk = match.group(0).strip()
        if chunk and chunk not in matches:
            matches.append(chunk)
    if matches:
        return "\n\n".join(matches)[:max_chars]
    lines = combined.splitlines()
    windows: list[str] = []
    for i, line in enumerate(lines):
        if any(h.lower() in line.lower() for h in _ERROR_HINTS):
            start = max(0, i - 4)
            end = min(len(lines), i + 10)
            windows.append("\n".join(lines[start:end]))
    return "\n\n".join(windows)[:max_chars]


def _extract_changed_files(patch: str) -> list[str]:
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


def _summarize_patch(patch: str, max_files: int = 12) -> str:
    files = _extract_changed_files(patch)
    if not files:
        return "No patch files detected."
    added = sum(1 for line in patch.splitlines() if line.startswith("+") and not line.startswith("+++"))
    removed = sum(1 for line in patch.splitlines() if line.startswith("-") and not line.startswith("---"))
    shown = ", ".join(files[:max_files])
    if len(files) > max_files:
        shown += f", ... (+{len(files) - max_files} more)"
    return f"Changed files: {shown}. Added lines: {added}. Removed lines: {removed}."


def hf_row_to_v1(row: dict[str, Any], index: int) -> dict[str, Any]:
    """Convert one HF dataset row (nebius/SWE-agent-trajectories) to a v1 card.

    Solved (target=True) -> usable=true. Unsolved (target=False) -> usable=false.
    The id includes the row index to disambiguate multiple agent attempts on
    the same instance_id.
    """
    trajectory = row.get("trajectory") or []
    if not isinstance(trajectory, list):
        trajectory = []
    issue = _get_issue_text(trajectory)
    patch = str(row.get("generated_patch") or "")
    eval_logs = str(row.get("eval_logs") or "")
    instance_id = str(row.get("instance_id") or f"row_{index}")

    error_excerpt = _extract_error_excerpt(issue, _trajectory_to_text(trajectory), eval_logs)
    changed_files = _extract_changed_files(patch)
    patch_summary = _summarize_patch(patch)
    target = row.get("target") is True

    symptom = error_excerpt or issue[:500] or ("(unsolved trajectory)" if not target else instance_id)
    embedding_text = " ".join(filter(None, [issue[:1200], error_excerpt[:500], patch_summary, " ".join(changed_files)]))[:2000]

    return {
        "id": f"{instance_id}__row{index}",
        "source": DATASET_NAME,
        "repo": _repo_from_instance_id(instance_id),
        "language": None,
        "bug_type": None,
        "symptom": symptom or None,
        "root_cause": None,
        "fix_pattern": patch_summary if patch.strip() else None,
        "failed_approaches": [],
        "key_files": changed_files,
        "test_signal": error_excerpt or None,
        "search_keywords": [],
        "embedding_text": embedding_text or None,
        "usable": bool(target and symptom and embedding_text),
    }


class HFDatasetSource:
    """Streaming source over nebius/SWE-agent-trajectories (all ~80k rows).

    Requires the optional 'ingest' extra: pip -e .[ingest]
    Streams the dataset row-by-row; never loads all rows into memory.
    """

    name = "hf_swe_agent_trajectories"

    def __init__(self, dataset_name: str = DATASET_NAME, split: str = "train") -> None:
        self.dataset_name = dataset_name
        self.split = split

    def iter_records(self) -> Iterator[dict[str, Any]]:
        try:
            from datasets import load_dataset
        except ImportError as exc:
            raise ImportError(
                "HFDatasetSource requires the 'ingest' extra: pip -e .[ingest] "
                "(provides the 'datasets' library)"
            ) from exc
        ds = load_dataset(self.dataset_name, split=self.split)
        for index, row in enumerate(ds):
            yield hf_row_to_v1(row, index)

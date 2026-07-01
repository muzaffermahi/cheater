"""Cheater trace distiller.

This is the module that turns *historical traces* into reusable artifacts:

  A. distilled skill suggestions
  B. distilled bug cards (memory entries)
  C. training rows for the 9B model
  D. prompt improvement suggestions
  E. anti-pattern rules

The 5 training row types are written as JSONL:

  localizer_sft.jsonl
  patcher_sft.jsonl
  failure_analyst_sft.jsonl
  diff_guard_sft.jsonl
  tool_policy_sft.jsonl

Each row:
  {
    "role": "<role>",
    "input": "...",
    "output": "...",
    "metadata": {
      "repo": "...",
      "success": true,
      "source_trace": "...",
      "tokens_est": 1234,
      "confidence": 0.7   # optional, 0..1
    }
  }

Distillation rules:
  - Only successful traces (run_finished.success == true) produce
    positive patcher / localizer examples.
  - Failed traces produce anti-patterns and failure-analyst examples.
  - We prefer compact localized snippets; raw huge code blobs are not
    stored.
  - Near-duplicate rows are deduplicated (exact-match on (input, output)).
  - Low-confidence rows are marked in metadata.confidence, not silently
    mixed in.

Public API:
    distill_trace(trace) -> DistillationResult
    distill_traces(trace_dir, out_dir) -> Summary
    write_training_rows(results, out_dir)
    suggest_skill_from_trace(trace) -> dict
    suggest_antipatterns(failed_traces) -> list[dict]
    load_trace_file(path)            # convenience

CLI:
    cheater distill traces --out .cheater/distilled
    cheater distill trace <run_id>
    cheater distill training --role patcher --out patcher_sft.jsonl
    cheater distill antipatterns
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable


# Role types we produce training rows for
ROLES: tuple[str, ...] = (
    "localizer",
    "patcher",
    "failure_analyst",
    "diff_guard",
    "tool_policy",
)


# Heuristics for bug type classification. Cheap and deterministic.
_BUG_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    (
        "import_error",
        re.compile(r"(?i)modulenotfounderror|importerror|no module named"),
    ),
    (
        "syntax_error",
        re.compile(r"(?i)syntaxerror|indentationerror|taberror|invalid syntax"),
    ),
    ("assertion_error", re.compile(r"(?i)assertionerror|assert .* ==|assert .* is")),
    ("attribute_error", re.compile(r"(?i)attributeerror|object has no attribute")),
    ("type_error", re.compile(r"(?i)typeerror|expected .* got")),
    ("key_error", re.compile(r"(?i)keyerror|missing key")),
    ("timeout", re.compile(r"(?i)timed?\s*out|timeout")),
    ("flaky_test", re.compile(r"(?i)flaky|intermittent|order-dependent")),
]


# ---- data types ----


@dataclass
class TrainingRow:
    role: str
    input: str
    output: str
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "role": self.role,
            "input": self.input,
            "output": self.output,
            "metadata": dict(self.metadata),
        }


@dataclass
class DistillationResult:
    rows: list[TrainingRow] = field(default_factory=list)
    skill_suggestion: dict[str, Any] = field(default_factory=dict)
    bug_card: dict[str, Any] = field(default_factory=dict)
    prompt_suggestion: str = ""
    confidence: float = 0.0
    is_success: bool = False
    source_trace: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "row_count": len(self.rows),
            "rows": [r.to_dict() for r in self.rows],
            "skill_suggestion": dict(self.skill_suggestion),
            "bug_card": dict(self.bug_card),
            "prompt_suggestion": self.prompt_suggestion,
            "confidence": round(self.confidence, 3),
            "is_success": self.is_success,
            "source_trace": self.source_trace,
        }


# ---- helpers ----


def _clip(text: str, max_chars: int) -> str:
    if not text:
        return ""
    if len(text) <= max_chars:
        return text
    return text[: max(0, max_chars - 30)] + "\n...[truncated]"


def _payload(ev: dict[str, Any]) -> dict[str, Any]:
    p = ev.get("payload")
    return p if isinstance(p, dict) else {}


def _event_type(ev: dict[str, Any]) -> str:
    return str(ev.get("event") or ev.get("kind") or "")


def _get_first(trace: list[dict[str, Any]], event_type: str) -> dict[str, Any] | None:
    for ev in trace:
        if _event_type(ev) == event_type:
            return ev
    return None


def _get_last(trace: list[dict[str, Any]], event_type: str) -> dict[str, Any] | None:
    last: dict[str, Any] | None = None
    for ev in trace:
        if _event_type(ev) == event_type:
            last = ev
    return last


def _is_success(trace: list[dict[str, Any]]) -> bool:
    fin = _get_last(trace, "run_finished")
    if not fin:
        return False
    p = _payload(fin)
    return bool(p.get("success"))


def _finished_by(trace: list[dict[str, Any]]) -> str:
    fin = _get_last(trace, "run_finished")
    if not fin:
        return ""
    return str(_payload(fin).get("finished_by", ""))


def _all_actions(trace: list[dict[str, Any]]) -> list[str]:
    out: list[str] = []
    for ev in trace:
        if _event_type(ev) == "model_output":
            act = _payload(ev).get("parsed_action") or {}
            if isinstance(act, dict):
                n = act.get("action")
                if isinstance(n, str) and n:
                    out.append(n)
    return out


def _all_files_touched(trace: list[dict[str, Any]]) -> list[str]:
    out: list[str] = []
    for ev in trace:
        if _event_type(ev) == "diff_generated":
            p = _payload(ev).get("path")
            if isinstance(p, str) and p:
                out.append(p)
    return out


def _failure_summary(trace: list[dict[str, Any]]) -> dict[str, Any]:
    fs = _get_last(trace, "failure_summary")
    return _payload(fs) if fs else {}


def _localization_files(trace: list[dict[str, Any]]) -> list[str]:
    loc = _get_first(trace, "localization_result")
    if not loc:
        return []
    sf = _payload(loc).get("suspected_files") or []
    out: list[str] = []
    for f in sf:
        if isinstance(f, dict) and isinstance(f.get("path"), str):
            out.append(f["path"])
    return out


def _classify_bug_type(trace: list[dict[str, Any]]) -> str:
    fs = _failure_summary(trace)
    blob_parts: list[str] = []
    if isinstance(fs.get("error_type"), str):
        blob_parts.append(fs["error_type"])
    if isinstance(fs.get("summary"), str):
        blob_parts.append(fs["summary"])
    for ev in trace:
        if _event_type(ev) in ("command_run", "diff_guard_result"):
            p = _payload(ev)
            for k in ("stderr", "stdout", "summary", "reasons"):
                v = p.get(k)
                if isinstance(v, str):
                    blob_parts.append(v)
    blob = "\n".join(blob_parts)
    for label, pat in _BUG_PATTERNS:
        if pat.search(blob):
            return label
    return ""


def _hash_dedupe_key(row: TrainingRow) -> str:
    h = hashlib.sha256()
    h.update(row.role.encode("utf-8"))
    h.update(b"\x00")
    h.update(row.input[:2000].encode("utf-8", errors="ignore"))
    h.update(b"\x00")
    h.update(row.output[:2000].encode("utf-8", errors="ignore"))
    return h.hexdigest()


# ---- row builders ----


def _build_localizer_row(
    trace: list[dict[str, Any]], run_id: str
) -> TrainingRow | None:
    files = _localization_files(trace)
    if not files:
        return None
    task_ev = _get_first(trace, "task_received") or _get_first(trace, "run_start")
    task = (
        str((_payload(task_ev).get("task")) or (_payload(task_ev).get("task")) or "")
        if task_ev
        else ""
    )
    if not task:
        # Fall back to run_start.task
        rs = _get_first(trace, "run_start")
        if rs:
            task = str(_payload(rs).get("task", ""))
    if not task:
        return None
    output = json.dumps(
        {
            "suspected_files": [{"path": p, "confidence": 0.5} for p in files[:5]],
        },
        ensure_ascii=False,
    )
    md = {
        "repo": str(
            _payload(_get_first(trace, "run_start") or {}).get("repo_root", "")
        ),
        "success": _is_success(trace),
        "source_trace": run_id,
        "tokens_est": (len(task) + len(output)) // 4,
    }
    return TrainingRow(
        role="localizer",
        input=_clip(task, 1200),
        output=_clip(output, 800),
        metadata=md,
    )


def _build_patcher_row(trace: list[dict[str, Any]], run_id: str) -> TrainingRow | None:
    """Only emit for successful traces."""
    if not _is_success(trace):
        return None
    files = _all_files_touched(trace)
    if not files:
        return None
    diffs: list[dict[str, Any]] = []
    for ev in trace:
        if _event_type(ev) == "diff_generated":
            p = _payload(ev)
            diffs.append(
                {
                    "path": p.get("path"),
                    "old": _clip(str(p.get("old", "") or ""), 600),
                    "new": _clip(str(p.get("new", "") or ""), 600),
                }
            )
        if len(diffs) >= 3:
            break
    if not diffs:
        return None
    rs = _get_first(trace, "run_start")
    task = str(_payload(rs).get("task", "")) if rs else ""
    fs = _failure_summary(trace)
    summary = str(fs.get("summary", "")) if isinstance(fs.get("summary"), str) else ""
    input_parts: list[str] = []
    if task:
        input_parts.append(f"TASK: {task}")
    if summary:
        input_parts.append(f"FAILURE: {summary}")
    if files:
        input_parts.append("TOUCHED FILES: " + ", ".join(files[:5]))
    if not input_parts:
        return None
    output = json.dumps({"patches": diffs}, ensure_ascii=False)
    md = {
        "repo": str(_payload(rs).get("repo_root", "")) if rs else "",
        "success": True,
        "source_trace": run_id,
        "tokens_est": (sum(len(s) for s in input_parts) + len(output)) // 4,
        "confidence": 0.8 if _finished_by(trace) == "finish" else 0.5,
    }
    return TrainingRow(
        role="patcher",
        input=_clip("\n".join(input_parts), 1500),
        output=_clip(output, 1200),
        metadata=md,
    )


def _build_failure_analyst_row(
    trace: list[dict[str, Any]], run_id: str
) -> TrainingRow | None:
    fs = _failure_summary(trace)
    if not fs:
        return None
    rs = _get_first(trace, "run_start")
    task = str(_payload(rs).get("task", "")) if rs else ""
    error_type = str(fs.get("error_type", "") or "")
    test = str(fs.get("test", "") or "")
    summary = str(fs.get("summary", "") or "")
    files = fs.get("top_stack_files") or fs.get("files") or []
    if not isinstance(files, list):
        files = []
    input_text = "TASK: " + (task or "(unknown)") + "\n"
    if summary:
        input_text += "FAILURE SUMMARY: " + summary + "\n"
    output = json.dumps(
        {
            "error_type": error_type,
            "test": test,
            "likely_files": [str(f) for f in files[:5]] if files else [],
        },
        ensure_ascii=False,
    )
    md = {
        "repo": str(_payload(rs).get("repo_root", "")) if rs else "",
        "success": _is_success(trace),
        "source_trace": run_id,
        "tokens_est": (len(input_text) + len(output)) // 4,
    }
    return TrainingRow(
        role="failure_analyst",
        input=_clip(input_text, 1200),
        output=_clip(output, 800),
        metadata=md,
    )


def _build_diff_guard_row(
    trace: list[dict[str, Any]], run_id: str
) -> TrainingRow | None:
    g = _get_last(trace, "diff_guard_result")
    if not g:
        return None
    p = _payload(g)
    accepted = bool(p.get("accepted"))
    reasons = p.get("reasons") or []
    risk_score = p.get("risk_score", 0.0)
    if not isinstance(reasons, list):
        reasons = []
    reasons = [str(x) for x in reasons if x]
    # find the most recent diff
    d = _get_last(trace, "diff_generated")
    diff_text = ""
    if d:
        pp = _payload(d)
        diff_text = str(pp.get("diff", "") or pp.get("text", "") or "")
    if not diff_text:
        return None
    input_text = "DIFF:\n" + _clip(diff_text, 1200) + "\n"
    output = json.dumps(
        {
            "accepted": accepted,
            "risk_score": float(risk_score)
            if isinstance(risk_score, (int, float))
            else 0.0,
            "reasons": reasons[:5],
        },
        ensure_ascii=False,
    )
    md = {
        "success": _is_success(trace),
        "source_trace": run_id,
        "tokens_est": (len(input_text) + len(output)) // 4,
    }
    return TrainingRow(
        role="diff_guard",
        input=_clip(input_text, 1400),
        output=_clip(output, 600),
        metadata=md,
    )


def _build_tool_policy_row(
    trace: list[dict[str, Any]], run_id: str
) -> TrainingRow | None:
    actions = _all_actions(trace)
    if not actions:
        return None
    fs = _failure_summary(trace)
    rs = _get_first(trace, "run_start")
    task = str(_payload(rs).get("task", "")) if rs else ""
    # crude state inference using existing tool_policy if importable
    state = ""
    try:
        from cheater.tool_policy import infer_state

        state = infer_state(task, _get_last(trace, "failure_summary"), fs)
    except Exception:
        state = ""
    preferred = actions[:6]
    input_text = "TASK: " + (task or "(unknown)") + "\n"
    if state:
        input_text += "STATE: " + state + "\n"
    if fs.get("error_type"):
        input_text += "ERROR: " + str(fs.get("error_type")) + "\n"
    output = json.dumps(
        {
            "preferred_next_tools": preferred,
            "is_success": _is_success(trace),
        },
        ensure_ascii=False,
    )
    md = {
        "success": _is_success(trace),
        "source_trace": run_id,
        "tokens_est": (len(input_text) + len(output)) // 4,
    }
    return TrainingRow(
        role="tool_policy",
        input=_clip(input_text, 1000),
        output=_clip(output, 600),
        metadata=md,
    )


# ---- skill / anti-pattern / prompt suggestions ----


def suggest_skill_from_trace(trace: list[dict[str, Any]]) -> dict[str, Any]:
    """Produce a skill draft (with trigger / steps / validation / when-not)
    from a single successful trace.
    """
    rs = _get_first(trace, "run_start")
    task = str(_payload(rs).get("task", "")) if rs else ""
    actions = _all_actions(trace)
    files = _all_files_touched(trace)
    bug_type = _classify_bug_type(trace)
    trigger_keywords = _top_keywords(task + " " + " ".join(actions))
    trigger = ", ".join(trigger_keywords[:6]) or "general"
    steps: list[str] = []
    # Pick 4-6 representative actions
    seen: set[str] = set()
    for a in actions:
        if a in seen:
            continue
        seen.add(a)
        steps.append(f"Call `{a}` with appropriate args.")
        if len(steps) >= 6:
            break
    validation = (
        "Run focused test command. Patch is correct iff the failing test now passes."
    )
    when_not = (
        "Don't use this skill if the task is purely about exploring or answering a question "
        "without editing files."
    )
    name = f"auto-{bug_type or 'fix'}-{(trigger_keywords[0] if trigger_keywords else 'general')}"
    return {
        "name": name[:60],
        "trigger": trigger,
        "bug_type": bug_type,
        "files": files[:5],
        "steps": steps,
        "validation": validation,
        "when_not_to_use": when_not,
        "source": "trace_distiller",
        "confidence": 0.6 if _is_success(trace) else 0.2,
    }


def _top_keywords(text: str, k: int = 6) -> list[str]:
    if not text:
        return []
    tokens = re.findall(r"[A-Za-z_][A-Za-z0-9_]{2,}", text)
    stop: set[str] = {
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
    }
    counts: Counter[str] = Counter()
    for t in tokens:
        lt = t.lower()
        if lt in stop:
            continue
        if len(lt) < 3:
            continue
        counts[lt] += 1
    return [w for w, _ in counts.most_common(k)]


def suggest_antipatterns(
    failed_traces: list[list[dict[str, Any]]],
) -> list[dict[str, Any]]:
    """From a collection of failed traces, surface recurring anti-patterns."""
    if not failed_traces:
        return []
    # Count (first action, finished_by) pairs
    pair_counts: Counter[tuple[str, str]] = Counter()
    bug_counts: Counter[str] = Counter()
    long_runs: list[int] = []
    for tr in failed_traces:
        if _is_success(tr):
            continue
        actions = _all_actions(tr)
        first = actions[0] if actions else "(none)"
        fb = _finished_by(tr) or "?"
        pair_counts[(first, fb)] += 1
        bt = _classify_bug_type(tr)
        if bt:
            bug_counts[bt] += 1
        if len(actions) >= 5:
            long_runs.append(len(actions))
    out: list[dict[str, Any]] = []
    for (action, fb), n in pair_counts.most_common(8):
        if n < 2 and len(failed_traces) > 5:
            continue
        out.append(
            {
                "kind": "first_action",
                "first_action": action,
                "finished_by": fb,
                "count": n,
                "advice": (
                    f"Don't start with `{action}` for runs that end in `{fb}`. "
                    "Prefer localize/context/memory first."
                ),
            }
        )
    for bt, n in bug_counts.most_common(5):
        if n < 2:
            continue
        out.append(
            {
                "kind": "bug_type",
                "bug_type": bt,
                "count": n,
                "advice": f"Recurring `{bt}` failures: add a skill or memory card for this pattern.",
            }
        )
    if long_runs:
        avg = sum(long_runs) / len(long_runs)
        out.append(
            {
                "kind": "long_run",
                "avg_actions": round(avg, 1),
                "count": len(long_runs),
                "advice": (
                    "Some failures run >5 actions without progress. Encourage i_dont_know "
                    "after the per-state max_tool_calls."
                ),
            }
        )
    return out


def _prompt_suggestion(trace: list[dict[str, Any]]) -> str:
    if _is_success(trace):
        return ""
    fb = _finished_by(trace)
    actions = _all_actions(trace)
    if fb == "i_dont_know" and actions:
        return (
            "Model gave up after calling: "
            + ", ".join(actions[:6])
            + ". Try a smaller first action and fewer tool calls before reflection."
        )
    if fb == "max_steps":
        return "Model hit max_steps. Tighten the per-state tool policy."
    if fb == "no_model":
        return "No model configured; the loop returns no_model honestly."
    return ""


# ---- per-trace distillation ----


def distill_trace(trace: list[dict[str, Any]], run_id: str = "") -> DistillationResult:
    """Produce a DistillationResult from one trace."""
    if not run_id:
        run_id = (
            str(_payload(_get_first(trace, "run_start") or {}).get("run_id", ""))
            or "unknown"
        )
    is_success = _is_success(trace)
    rows: list[TrainingRow] = []
    # Localizer
    r = _build_localizer_row(trace, run_id)
    if r:
        rows.append(r)
    # Patcher: ONLY for successful traces
    if is_success:
        r = _build_patcher_row(trace, run_id)
        if r:
            rows.append(r)
    # Failure analyst: emit if failure_summary exists (success or fail)
    r = _build_failure_analyst_row(trace, run_id)
    if r:
        rows.append(r)
    # Diff guard: emit if a diff_guard event exists
    r = _build_diff_guard_row(trace, run_id)
    if r:
        rows.append(r)
    # Tool policy: emit if we have actions
    r = _build_tool_policy_row(trace, run_id)
    if r:
        rows.append(r)
    skill = suggest_skill_from_trace(trace) if is_success else {}
    bug = _bug_card_from_trace(trace, run_id) if is_success else {}
    prompt = _prompt_suggestion(trace)
    conf = 0.8 if is_success else 0.3
    return DistillationResult(
        rows=rows,
        skill_suggestion=skill,
        bug_card=bug,
        prompt_suggestion=prompt,
        confidence=conf,
        is_success=is_success,
        source_trace=run_id,
    )


def _bug_card_from_trace(trace: list[dict[str, Any]], run_id: str) -> dict[str, Any]:
    rs = _get_first(trace, "run_start")
    task = str(_payload(rs).get("task", "")) if rs else ""
    fs = _failure_summary(trace)
    bt = _classify_bug_type(trace)
    files = _all_files_touched(trace)
    if not (task or fs or files):
        return {}
    return {
        "kind": "bug_card",
        "bug_type": bt or "generic",
        "task_signature": task[:200],
        "files": files[:5],
        "fix_summary": (
            str(fs.get("summary", "")) if isinstance(fs.get("summary"), str) else ""
        )[:300],
        "source_trace": run_id,
        "tags": [bt] if bt else [],
    }


# ---- bulk distillation ----


def load_trace_file(path: str | Path) -> list[dict[str, Any]]:
    """Convenience: load a single trace JSONL file."""
    from cheater.trace_recorder import load_trace

    return load_trace(path)


def distill_traces(
    trace_dir: str | Path,
    out_dir: str | Path,
    *,
    min_success_only: bool = True,
) -> dict[str, Any]:
    """Distill every trace under `trace_dir` into training rows + skill
    suggestions + anti-patterns.

    Output layout (created under out_dir):
        localizer_sft.jsonl
        patcher_sft.jsonl
        failure_analyst_sft.jsonl
        diff_guard_sft.jsonl
        tool_policy_sft.jsonl
        skill_suggestions.jsonl
        bug_cards.jsonl
        antipatterns.json
        summary.json
    """
    src = Path(trace_dir)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    if not src.is_dir():
        return {"ok": False, "error": f"trace_dir not found: {src}"}
    files = sorted(src.glob("*.jsonl"))
    # Exclude "latest.jsonl" symlinks/copies (we only want one source of truth)
    files = [f for f in files if f.name != "latest.jsonl"]
    all_results: list[DistillationResult] = []
    failed_traces: list[list[dict[str, Any]]] = []
    successes = 0
    for f in files:
        trace = load_trace_file(f)
        if not trace:
            continue
        run_id = f.stem
        if min_success_only and not _is_success(trace):
            failed_traces.append(trace)
            continue
        result = distill_trace(trace, run_id=run_id)
        all_results.append(result)
        if result.is_success:
            successes += 1
        else:
            failed_traces.append(trace)
    # Collect rows
    write_training_rows(all_results, out)
    # Skills + bug cards
    skills = [r.skill_suggestion for r in all_results if r.skill_suggestion]
    cards = [r.bug_card for r in all_results if r.bug_card]
    (out / "skill_suggestions.jsonl").write_text(
        "\n".join(json.dumps(s, ensure_ascii=False) for s in skills)
        + ("\n" if skills else ""),
        encoding="utf-8",
    )
    (out / "bug_cards.jsonl").write_text(
        "\n".join(json.dumps(c, ensure_ascii=False) for c in cards)
        + ("\n" if cards else ""),
        encoding="utf-8",
    )
    # Anti-patterns (always from failed traces)
    anti = suggest_antipatterns(failed_traces)
    (out / "antipatterns.json").write_text(
        json.dumps(anti, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    summary = {
        "ok": True,
        "trace_dir": str(src),
        "out_dir": str(out),
        "trace_files": [f.name for f in files],
        "traces_distilled": len(all_results),
        "successes": successes,
        "failed_traces_seen": len(failed_traces),
        "antipattern_count": len(anti),
        "skill_suggestions": len(skills),
        "bug_cards": len(cards),
        "rows_per_role": _row_counts(all_results),
    }
    (out / "summary.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    return summary


def _row_counts(results: list[DistillationResult]) -> dict[str, int]:
    counts: Counter[str] = Counter()
    for r in results:
        for row in r.rows:
            counts[row.role] += 1
    return dict(counts)


# ---- writers ----


def write_training_rows(
    results: list[DistillationResult] | list[TrainingRow],
    out_dir: str | Path,
) -> dict[str, int]:
    """Write per-role JSONL files. Deduplicates by (role, input[:2000], output[:2000]).

    Returns a dict of role -> row count written.
    """
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    rows: list[TrainingRow] = []
    for r in results:
        if isinstance(r, TrainingRow):
            rows.append(r)
        elif isinstance(r, DistillationResult):
            rows.extend(r.rows)
    seen: set[str] = set()
    per_role: dict[str, list[TrainingRow]] = {role: [] for role in ROLES}
    written: dict[str, int] = {}
    for row in rows:
        if row.role not in per_role:
            per_role[row.role] = []
        key = _hash_dedupe_key(row)
        if key in seen:
            continue
        seen.add(key)
        per_role[row.role].append(row)
    for role, items in per_role.items():
        path = out / f"{role}_sft.jsonl"
        if not items:
            # still create an empty file so the contract is stable
            path.write_text("", encoding="utf-8")
            written[role] = 0
            continue
        lines = "\n".join(json.dumps(r.to_dict(), ensure_ascii=False) for r in items)
        path.write_text(lines + "\n", encoding="utf-8")
        written[role] = len(items)
    return written

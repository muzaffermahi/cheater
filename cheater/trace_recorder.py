"""Cheater trace recorder.

A trace is a streamable JSONL file where each line is one structured event.
Traces are the input to the arena, the distiller, and the context optimizer.
They are deliberately compact: no giant raw logs, no full prompts unless
explicitly enabled.

Event types (stable contract):

    run_start            - {run_id, ts, task, repo_root, mode}
    task_received        - {task, hint?}
    repo_map_selected    - {files: [...], query}
    context_pack_built   - {providers: [{name, chars}], total_chars, truncated}
    localization_result  - {suspected_files: [...], source}
    memory_retrieved     - {ids: [...], tags: [...]}
    skill_used           - {skill, why}
    model_prompt         - {prompt_hash, prompt_excerpt?, tokens_est}
    model_output         - {text_hash, text_excerpt?, parsed_action, finish}
    diff_generated       - {path, old, new, lines, risk_flags}
    diff_guard_result    - {accepted, reasons, risk_score}
    command_run          - {cmd, returncode, elapsed, summary}
    failure_summary      - {error_type, test, files: [...]}
    repair_attempt       - {round, action, success, diff_size}
    run_finished         - {success, finished_by, elapsed, steps}
    learned_card_written - {kind: memory|skill, id, text, tags}

Storage:
    .cheater/traces/<run_id>.jsonl     -- streamable, one event per line
    .cheater/traces/latest.jsonl       -- symlink/copy of the most recent run

Privacy:
    - The default mode stores only prompt hashes and excerpts.
    - The redact_trace() helper removes anything that looks like an
      API key, bearer token, or env-style secret.
    - trace_full_prompts (config) controls whether full prompts are stored.

Public API:
    TraceRecorder(run_id, root_dir=None)         -- create or append
    recorder.record(event_type, payload=None)    -- write one event
    recorder.close()                             -- finalize
    load_trace(path)                             -- list[dict] from a file
    summarize_trace(trace)                       -- compact stats
    redact_trace(trace, mode="safe")             -- strip secrets
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable


# Stable event-type set. Anything not in this set is allowed but
# flagged as "custom" in summaries.
KNOWN_EVENTS: frozenset[str] = frozenset(
    {
        "run_start",
        "task_received",
        "repo_map_selected",
        "context_pack_built",
        "localization_result",
        "memory_retrieved",
        "skill_used",
        "model_prompt",
        "model_output",
        "diff_generated",
        "diff_guard_result",
        "command_run",
        "failure_summary",
        "repair_attempt",
        "run_finished",
        "learned_card_written",
    }
)


# ---- redaction ----

# Substrings that suggest a secret. Matched case-insensitively, on the
# value side of "k=v" or on a bare token-shaped string.
_SECRET_KEYS_RE = re.compile(
    r"(api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|"
    r"bearer|openai[_-]?key|hf[_-]?token|github[_-]?token|slack[_-]?token)\s*"
    r"[:=]\s*['\"]?([A-Za-z0-9._\-/+=]{6,})['\"]?",
    re.IGNORECASE,
)
_BEARER_RE = re.compile(r"Bearer\s+[A-Za-z0-9._\-]{6,}", re.IGNORECASE)
_SK_RE = re.compile(r"sk-[A-Za-z0-9_\-]{8,}")


def _scrub_string(s: str) -> str:
    """Replace anything that looks like a secret with ***REDACTED***."""
    if not s:
        return s
    s = _SECRET_KEYS_RE.sub(lambda m: f"{m.group(1)}=***REDACTED***", s)
    s = _BEARER_RE.sub("Bearer ***REDACTED***", s)
    s = _SK_RE.sub("sk-***REDACTED***", s)
    return s


def _scrub_value(v: Any) -> Any:
    """Recursively scrub strings inside a JSON-like value."""
    if isinstance(v, str):
        return _scrub_string(v)
    if isinstance(v, dict):
        return {k: _scrub_value(val) for k, val in v.items()}
    if isinstance(v, list):
        return [_scrub_value(x) for x in v]
    if isinstance(v, tuple):
        return tuple(_scrub_value(x) for x in v)
    return v


def redact_trace(trace: list[dict], mode: str = "safe") -> list[dict]:
    """Return a copy of the trace with secrets scrubbed.

    mode="safe"   -- always scrub strings (default)
    mode="strict" -- also drop model_prompt / model_output excerpts
    mode="off"    -- return the trace unchanged
    """
    if mode == "off":
        return list(trace)
    out: list[dict] = []
    DROP_KEYS = ("text_excerpt", "prompt_excerpt", "output", "stderr", "stdout")
    for ev in trace:
        if not isinstance(ev, dict):
            out.append(ev)
            continue
        new_ev = {k: _scrub_value(val) for k, val in ev.items()}
        if mode == "strict":
            for k in DROP_KEYS:
                new_ev.pop(k, None)
            # Also drop excerpts inside payload (where they actually live)
            payload = new_ev.get("payload")
            if isinstance(payload, dict):
                for k in DROP_KEYS:
                    payload.pop(k, None)
        out.append(new_ev)
    return out


# ---- hash + excerpt helpers ----


def _stable_hash(text: str) -> str:
    if text is None:
        return ""
    return hashlib.sha256(text.encode("utf-8", errors="ignore")).hexdigest()[:16]


def _clip_excerpt(text: str, max_chars: int = 280) -> str:
    if not text:
        return ""
    text = str(text)
    if len(text) <= max_chars:
        return text
    return text[: max(0, max_chars - 30)] + "...[truncated]"


# ---- recorder ----


@dataclass
class TraceRecorder:
    """Streams JSONL events to .cheater/traces/<run_id>.jsonl.

    Parameters
    ----------
    run_id : str
        Stable id for this run. Use uuid4().hex[:12] if unsure.
    root_dir : str | Path | None
        Project root. Defaults to current working directory.
    store_prompts : bool
        If True, full prompt text is included on model_prompt events.
        If False (default), only a short excerpt is stored.
    store_outputs : bool
        If True, full model output is included on model_output events.
        If False (default), only a short excerpt is stored.
    overwrite : bool
        If True, replace any existing trace file with the same run_id.
    """

    run_id: str
    root_dir: str | Path | None = None
    store_prompts: bool = False
    store_outputs: bool = False
    overwrite: bool = True
    _fp: Any = field(default=None, init=False, repr=False)
    _path: Path = field(default=Path(), init=False)
    _events: int = 0
    _open_at: float = field(default=0.0, init=False)
    _closed: bool = field(default=False, init=False)

    def __post_init__(self) -> None:
        if not self.run_id:
            self.run_id = uuid.uuid4().hex[:12]
        root = Path(self.root_dir) if self.root_dir else Path.cwd()
        self._path = root / ".cheater" / "traces" / f"{self.run_id}.jsonl"
        self._path.parent.mkdir(parents=True, exist_ok=True)
        mode = "w" if self.overwrite else "a"
        # newline="" is required for JSONL on Windows
        self._fp = open(self._path, mode, encoding="utf-8", newline="")
        self._open_at = time.time()

    @property
    def path(self) -> Path:
        return self._path

    @property
    def event_count(self) -> int:
        return self._events

    def record(self, event_type: str, payload: dict[str, Any] | None = None) -> None:
        """Write one event. Never raises (failures are swallowed so a
        broken recorder cannot crash the agent loop)."""
        if self._closed or self._fp is None:
            return
        try:
            event = {
                "ts": round(time.time(), 3),
                "event": event_type,
                "kind": event_type if event_type in KNOWN_EVENTS else "custom",
                "payload": dict(payload or {}),
            }
            # Auto-hash for known prompt/output events if a full text is given
            if event_type == "model_prompt" and isinstance(
                event["payload"].get("prompt"), str
            ):
                text = event["payload"].pop("prompt")
                event["payload"]["prompt_hash"] = _stable_hash(text)
                if self.store_prompts:
                    event["payload"]["prompt"] = text
                else:
                    event["payload"]["prompt_excerpt"] = _clip_excerpt(text)
            if event_type == "model_output" and isinstance(
                event["payload"].get("text"), str
            ):
                text = event["payload"].pop("text")
                event["payload"]["text_hash"] = _stable_hash(text)
                if self.store_outputs:
                    event["payload"]["text"] = text
                else:
                    event["payload"]["text_excerpt"] = _clip_excerpt(text)
            line = json.dumps(event, ensure_ascii=False, default=str)
            self._fp.write(line + "\n")
            self._fp.flush()
            self._events += 1
        except Exception:
            # Tracing must never break the agent.
            pass

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            if self._fp is not None:
                self._fp.flush()
                self._fp.close()
        except Exception:
            pass
        # Best-effort "latest" symlink
        try:
            latest = self._path.parent / "latest.jsonl"
            if latest.is_file() or latest.is_symlink():
                try:
                    latest.unlink()
                except OSError:
                    pass
            try:
                if os.name == "nt":
                    # On Windows, copy file rather than symlink
                    import shutil

                    shutil.copyfile(self._path, latest)
                else:
                    os.symlink(self._path.name, latest)
            except OSError:
                pass
        except Exception:
            pass

    def __enter__(self) -> "TraceRecorder":
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        self.close()


# ---- loader ----


def load_trace(path: str | Path) -> list[dict[str, Any]]:
    """Load a trace JSONL file. Tolerant of partial / corrupt lines.

    Returns a list of event dicts. Lines that fail to parse are skipped.
    """
    p = Path(path)
    out: list[dict[str, Any]] = []
    if not p.is_file():
        return out
    try:
        with p.open("r", encoding="utf-8", errors="ignore") as f:
            for raw in f:
                line = raw.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(obj, dict):
                    out.append(obj)
    except OSError:
        return out
    return out


# ---- summarizer ----


def summarize_trace(trace: list[dict[str, Any]]) -> dict[str, Any]:
    """Compute compact stats over a trace. Cheap and deterministic."""
    counts: dict[str, int] = {}
    first_ts: float | None = None
    last_ts: float | None = None
    total_prompt_tokens_est = 0
    total_output_tokens_est = 0
    actions: list[str] = []
    files_touched: set[str] = set()
    finished_by = ""
    success: bool | None = None
    error_type = ""
    for ev in trace:
        if not isinstance(ev, dict):
            continue
        ev_type = str(ev.get("event", ""))
        counts[ev_type] = counts.get(ev_type, 0) + 1
        ts = ev.get("ts")
        if isinstance(ts, (int, float)):
            if first_ts is None:
                first_ts = ts
            last_ts = ts
        payload = ev.get("payload") if isinstance(ev.get("payload"), dict) else {}
        if ev_type == "model_prompt":
            tot = payload.get("tokens_est")
            if isinstance(tot, (int, float)):
                total_prompt_tokens_est += int(tot)
        if ev_type == "model_output":
            tot = payload.get("tokens_est")
            if isinstance(tot, (int, float)):
                total_output_tokens_est += int(tot)
            act = payload.get("parsed_action") or {}
            if isinstance(act, dict) and act.get("action"):
                actions.append(str(act["action"]))
        if ev_type == "diff_generated":
            p = payload.get("path")
            if isinstance(p, str) and p:
                files_touched.add(p)
        if ev_type == "run_finished":
            finished_by = str(payload.get("finished_by", ""))
            if "success" in payload:
                success = bool(payload.get("success"))
        if ev_type == "failure_summary":
            et = payload.get("error_type")
            if isinstance(et, str) and et and not error_type:
                error_type = et
    elapsed = 0.0
    if first_ts is not None and last_ts is not None:
        elapsed = max(0.0, float(last_ts) - float(first_ts))
    return {
        "event_count": len(trace),
        "event_types": counts,
        "elapsed_sec": round(elapsed, 2),
        "actions": actions,
        "tool_call_count": sum(
            1 for a in actions if a and a not in ("finish", "i_dont_know")
        ),
        "model_call_count": counts.get("model_prompt", 0),
        "total_prompt_tokens_est": total_prompt_tokens_est,
        "total_output_tokens_est": total_output_tokens_est,
        "files_touched": sorted(files_touched),
        "finished_by": finished_by,
        "success": success,
        "error_type": error_type,
    }

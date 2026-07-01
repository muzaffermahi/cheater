"""Thin adapter layer between Cheater backend modules and the TUI.

Why this file exists:

* the TUI screens and widgets should not import the heavy backend
  modules directly (config, runner, localizer, etc.) so that simply
  ``import cheater.tui`` never crashes;
* tests can mock this module wholesale;
* the worker thread emits :class:`~cheater.tui.events.TuiEvent`
  instances which the TUI posts to its widgets.

The adapters in this file are intentionally narrow: each one is the
smallest unit of work the TUI needs from the backend. They are not
intended to be the only public API; they just call into the real
Cheater modules.
"""

from __future__ import annotations

import os
import re
import time
from dataclasses import asdict
from pathlib import Path
from typing import Any, Callable

from cheater.tui.events import TuiEvent, make_event


# ----- helpers -----


def redact(value: Any) -> Any:
    """Best-effort secret redaction for things shown in the UI."""
    if isinstance(value, str):
        # crude but matches what trace_recorder._scrub_string does
        v = value
        v = re.sub(r"sk-[A-Za-z0-9_\-]{8,}", "sk-***REDACTED***", v)
        v = re.sub(
            r"(api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|"
            r"bearer|openai[_-]?key|hf[_-]?token|github[_-]?token|slack[_-]?token)"
            r"(\s*[:=]\s*['\"]?)([A-Za-z0-9._\-/+=]{6,})",
            r"\1\2***REDACTED***",
            v,
            flags=re.IGNORECASE,
        )
        return v
    if isinstance(value, dict):
        return {k: redact(v) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(x) for x in value]
    return value


def truncate(text: str, limit: int = 1500) -> tuple[str, bool]:
    """Truncate text to ``limit`` characters, returning (text, was_truncated)."""
    if not text:
        return "", False
    if len(text) <= limit:
        return text, False
    return text[: max(0, limit - 30)] + "...[truncated]", True


# ----- config / settings -----


def load_config_for_root(project_root: str | Path) -> Any:
    """Load the cheater config, with safe defaults if not configured."""
    from cheater.config import load_config as _load

    try:
        return _load(Path(project_root))
    except Exception:
        from cheater.config import CheaterConfig

        cfg = CheaterConfig()
        cfg.project_root = str(project_root)
        return cfg


def config_to_safe_dict(cfg: Any) -> dict[str, Any]:
    """Return cfg.to_dict() with secrets redacted."""
    try:
        d = cfg.to_dict()
    except Exception:
        d = asdict(cfg)
    return redact(d)


# ----- repo map / localization / context -----


def build_repo_map(project_root: str | Path) -> dict[str, Any]:
    """Build (or load) a repo map. Returns a small dict for the TUI."""
    from cheater.repo_map import build_repo_map as _build, render_repo_map_markdown

    try:
        m = _build(Path(project_root))
    except Exception as e:
        return {"ok": False, "error": str(e), "files": [], "markdown": ""}
    try:
        md = render_repo_map_markdown(m, max_tokens=2000)
    except Exception:
        md = ""
    files = [f.get("path", "?") for f in (m.files or [])]
    return {
        "ok": True,
        "error": "",
        "files": files,
        "markdown": md,
        "summary": m.summary if hasattr(m, "summary") else "",
    }


def search_repo_map(
    query: str, project_root: str | Path, top_k: int = 8
) -> list[dict[str, Any]]:
    from cheater.repo_map import build_repo_map as _build, select_relevant_map

    try:
        m = _build(Path(project_root))
        sel = select_relevant_map(query, m, top_k=top_k)
        return [
            {"path": f.get("path", "?"), "why": f.get("why", [])}
            for f in (sel.files or [])
        ]
    except Exception as e:
        return [{"path": f"<error: {e}>", "why": []}]


def localize_task(
    task: str, project_root: str | Path, traceback: str = ""
) -> dict[str, Any]:
    """Run the localizer and return a small result dict."""
    from cheater.localizer import deterministic_localize

    try:
        result = deterministic_localize(
            task=task, repo_root=Path(project_root), traceback=traceback
        )
    except Exception as e:
        return {"ok": False, "error": str(e), "suspected": []}
    suspected = result.get("suspected", []) if isinstance(result, dict) else []
    return {"ok": True, "error": "", "suspected": suspected}


def build_context_pack(
    task: str,
    project_root: str | Path,
    traceback: str = "",
    memory_dir: str | Path | None = None,
    max_tokens: int = 8000,
) -> dict[str, Any]:
    from cheater.context_pack import build_context_pack as _build

    try:
        pack = _build(
            task=task,
            repo_root=Path(project_root),
            traceback=traceback,
            memory_dir=Path(memory_dir) if memory_dir else None,
            max_tokens=max_tokens,
        )
        providers = []
        if hasattr(pack, "providers"):
            providers = [
                {"name": p.name, "chars": getattr(p, "chars", 0)}
                for p in pack.providers
            ]
        return {
            "ok": True,
            "error": "",
            "providers": providers,
            "total_chars": getattr(pack, "total_chars", 0),
            "truncated": getattr(pack, "truncated", False),
            "preview": getattr(pack, "preview", "")[:1500],
        }
    except Exception as e:
        return {"ok": False, "error": str(e), "providers": [], "total_chars": 0}


# ----- memory (curated store) -----


def open_memory_store(memory_dir: str | Path | None = None) -> Any:
    from cheater.memory_store import MemoryStore

    return MemoryStore(Path(memory_dir) if memory_dir else None)


def memory_list(store: Any) -> list[dict[str, Any]]:
    try:
        return [e.to_dict() for e in store.all()]
    except Exception:
        return []


def memory_search(store: Any, query: str, top_k: int = 10) -> list[dict[str, Any]]:
    try:
        return store.search(query, top_k=top_k)
    except Exception:
        return []


def memory_add(store: Any, text: str, tags: list[str]) -> str:
    return store.add(text=text, tags=tags, source="manual")


def memory_forget(store: Any, memory_id: str | None, query: str | None) -> int:
    return store.remove(memory_id=memory_id, query=query)


# ----- skills -----


def skill_dir_for(project_root: str | Path) -> Path:
    p = Path(project_root) / ".cheater" / "skills"
    if not p.is_dir():
        # also check repo_map default
        alt = Path(project_root) / "data" / "skills"
        if alt.is_dir():
            return alt
    return p


def list_skills(project_root: str | Path) -> list[dict[str, Any]]:
    from cheater.skill_janitor import parse_skill

    d = skill_dir_for(project_root)
    items: list[SkillItemLite] = []
    if d.is_dir():
        for p in sorted(d.glob("*.md")):
            try:
                s = parse_skill(p)
            except Exception:
                s = None
            if s is None:
                items.append(
                    SkillItemLite(
                        name=p.stem,
                        path=str(p),
                        trigger="",
                        summary="(could not parse)",
                        front_matter={},
                        raw="",
                    )
                )
                continue
            items.append(
                SkillItemLite(
                    name=s.name,
                    path=str(s.path) if hasattr(s, "path") else str(p),
                    trigger=getattr(s, "trigger", "") or "",
                    summary=getattr(s, "summary", "") or "",
                    front_matter=dict(getattr(s, "front_matter", {}) or {}),
                    raw=s.raw_markdown if hasattr(s, "raw_markdown") else "",
                )
            )
    return [asdict(x) for x in items]


# tiny local dataclass to keep load_skills output stable for the TUI
from dataclasses import dataclass, field  # noqa: E402  (placed after function to keep grouping)


@dataclass
class SkillItemLite:
    name: str
    path: str
    trigger: str = ""
    summary: str = ""
    front_matter: dict[str, Any] = field(default_factory=dict)
    raw: str = ""


def run_skill_janitor(project_root: str | Path, store: Any) -> dict[str, Any]:
    from cheater.skill_janitor import audit_skills, audit_memories

    skills = list_skills(project_root)
    try:
        skill_report = audit_skills([])
    except Exception as e:
        skill_report = {"error": str(e)}
    try:
        mem_report = audit_memories(store)
    except Exception as e:
        mem_report = {"error": str(e)}
    return {"skills": skills, "skill_report": skill_report, "memory_report": mem_report}


# ----- traces -----


def traces_dir_for(project_root: str | Path) -> Path:
    return Path(project_root) / ".cheater" / "traces"


def list_traces(project_root: str | Path, limit: int = 200) -> list[dict[str, Any]]:
    from cheater.trace_recorder import load_trace, summarize_trace

    d = traces_dir_for(project_root)
    if not d.is_dir():
        return []
    files = sorted(d.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
    out: list[dict[str, Any]] = []
    for f in files[:limit]:
        try:
            events = load_trace(f)
        except Exception:
            events = []
        try:
            summary = summarize_trace(events) if events else {}
        except Exception:
            summary = {}
        out.append(
            {
                "run_id": f.stem,
                "path": str(f),
                "size": f.stat().st_size,
                "mtime": f.stat().st_mtime,
                "event_count": len(events),
                "summary": summary,
            }
        )
    return out


def load_trace(project_root: str | Path, run_id: str) -> list[dict[str, Any]]:
    from cheater.trace_recorder import load_trace as _load

    p = traces_dir_for(project_root) / f"{run_id}.jsonl"
    if not p.is_file():
        return []
    return _load(p)


def summarize_trace_file(project_root: str | Path, run_id: str) -> dict[str, Any]:
    from cheater.trace_recorder import summarize_trace

    events = load_trace(project_root, run_id)
    if not events:
        return {}
    return summarize_trace(events)


def distill_trace_to_skill(project_root: str | Path, run_id: str) -> dict[str, Any]:
    from cheater.trace_distiller import load_trace_file, suggest_skill_from_trace

    events = load_trace_file(traces_dir_for(project_root) / f"{run_id}.jsonl")
    return suggest_skill_from_trace(events)


def distill_trace_to_training(project_root: str | Path, run_id: str) -> dict[str, Any]:
    from cheater.trace_distiller import distill_trace, load_trace_file

    events = load_trace_file(traces_dir_for(project_root) / f"{run_id}.jsonl")
    res = distill_trace(events, run_id=run_id)
    return res.to_dict() if hasattr(res, "to_dict") else {"ok": True}


# ----- arena -----


def arena_dir_for(project_root: str | Path) -> Path:
    return Path(project_root) / ".cheater" / "arena"


def latest_arena_report(project_root: str | Path) -> dict[str, Any] | None:
    p = arena_dir_for(project_root) / "latest.json"
    if not p.is_file():
        # fallback: any *.json sorted by mtime
        d = arena_dir_for(project_root)
        if not d.is_dir():
            return None
        files = sorted(d.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True)
        if not files:
            return None
        p = files[0]
    from cheater.arena import read_arena_report

    try:
        return read_arena_report(p)
    except Exception:
        return None


def list_arena_reports(project_root: str | Path) -> list[dict[str, Any]]:
    d = arena_dir_for(project_root)
    if not d.is_dir():
        return []
    out = []
    for p in sorted(d.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True):
        out.append({"path": str(p), "mtime": p.stat().st_mtime, "name": p.name})
    return out


def compare_two_arena_reports(
    project_root: str | Path, old_path: str, new_path: str
) -> dict[str, Any]:
    from cheater.arena import compare_reports, read_arena_report

    return compare_reports(
        read_arena_report(Path(old_path)), read_arena_report(Path(new_path))
    )


def render_arena_summary(report: dict[str, Any]) -> str:
    from cheater.arena import render_arena_summary as _render

    try:
        return _render(report)
    except Exception:
        return "(could not render arena report)"


# ----- failure compression + runner -----


def detect_test_command(project_root: str | Path) -> str:
    from cheater.runner import detect_test_command as _detect

    cmd = _detect(Path(project_root))
    return cmd or ""


def run_focused_tests(
    cmd: str, project_root: str | Path, timeout: float = 120.0
) -> dict[str, Any]:
    from cheater.runner import run as _run, summarize_failure

    try:
        r = _run(cmd, cwd=Path(project_root), yes=True, timeout=timeout)
    except Exception as e:
        return {
            "ok": False,
            "returncode": -1,
            "summary": str(e),
            "stdout": "",
            "stderr": "",
        }
    try:
        s = summarize_failure(r)
    except Exception:
        s = {"ok": r.ok, "returncode": r.returncode}
    out = {
        "ok": r.ok,
        "returncode": r.returncode,
        "stdout": (r.stdout or "")[:5000],
        "stderr": (r.stderr or "")[:5000],
        "summary": s,
    }
    return out


def compress_failure(run_result: dict[str, Any]) -> dict[str, Any]:
    from cheater.failure_compressor import compress_command_result

    # Reconstruct a minimal CommandResult-like object for the compressor.
    class _CR:
        def __init__(self, d: dict[str, Any]) -> None:
            self.cmd = d.get("cmd", "")
            self.returncode = d.get("returncode", -1)
            self.stdout = d.get("stdout", "")
            self.stderr = d.get("stderr", "")
            self.ok = d.get("ok", False)
            self.timed_out = d.get("timed_out", False)

    try:
        s = compress_command_result(_CR(run_result))
    except Exception as e:
        return {"ok": False, "error": str(e), "summary": ""}
    return {
        "ok": True,
        "summary": getattr(s, "summary", "") or "",
        "error_type": getattr(s, "error_type", "") or "",
        "test": getattr(s, "test", "") or "",
        "files": getattr(s, "files", []) or [],
    }


# ----- tool policy -----


def tool_policy_for(
    task: str, project_root: str | Path, traceback: str = ""
) -> dict[str, Any]:
    from cheater.tool_policy import (
        infer_state,
        recommend_tools,
        render_tool_policy_nudge,
    )

    try:
        st = infer_state(task=task, last_event=None, failure=None)
        rec = recommend_tools(st, available_tools=None)
        nudge = render_tool_policy_nudge(rec)
    except Exception as e:
        return {"ok": False, "error": str(e), "allowed": [], "nudge": ""}
    allowed = list(getattr(rec, "allowed", []) or [])
    blocked = list(getattr(rec, "blocked", []) or [])
    return {
        "ok": True,
        "error": "",
        "allowed": allowed,
        "blocked": blocked,
        "nudge": nudge,
    }


# ----- agent loop helper -----


def build_agent_loop(
    task: str,
    project_root: str | Path,
    *,
    read_only: bool = False,
    max_steps: int = 20,
    memory_dir: str | Path | None = None,
    on_event: Callable[[TuiEvent], None] | None = None,
    with_trace: bool = True,
) -> Any:
    """Construct a configured AgentLoop, suitable to be run in a worker.

    The returned object's ``run`` method blocks; callers should run it in
    a worker thread. ``on_event`` receives :class:`TuiEvent` instances.
    """
    from cheater.agent_loop import AgentLoop, LoopEvent
    from cheater.config import load_config
    from cheater.memory_store import MemoryStore
    from cheater.providers import get_provider, ProviderConfig
    from cheater.retrieval import load_index_cards
    from cheater.trace_recorder import TraceRecorder

    root = Path(project_root).resolve()
    cfg = load_config(root)
    pc = ProviderConfig(
        provider=cfg.provider.provider,
        model=cfg.provider.model,
        base_url=cfg.provider.base_url,
        api_key=cfg.provider.api_key,
        temperature=cfg.provider.temperature,
        max_tokens=cfg.provider.max_tokens,
        timeout=cfg.provider.timeout,
        max_retries=cfg.provider.max_retries,
    )
    provider = get_provider(pc)

    cards: list[dict[str, Any]] = []
    for path in (root / cfg.cards_path, root / cfg.sample_cards_path):
        if path.is_file():
            try:
                cards = load_index_cards(path)
                if cards:
                    break
            except Exception:
                continue

    mem = None
    try:
        mem = MemoryStore(Path(memory_dir) if memory_dir else None)
    except Exception:
        mem = None

    rec = None
    if with_trace:
        try:
            run_id = time.strftime("%Y%m%d-%H%M%S") + "-" + os.urandom(2).hex()
            rec = TraceRecorder(
                run_id=run_id,
                root_dir=root,
                store_prompts=bool(cfg.arena.trace_full_prompts),
                store_outputs=bool(cfg.arena.trace_full_prompts),
            )
        except Exception:
            rec = None

    def _adapt(e: LoopEvent) -> None:
        if on_event is None:
            return
        kind = _loop_event_to_tui_kind(e.kind)
        payload: dict[str, Any] = {
            "step_num": e.step_num,
            "action": e.action,
            "args": e.args,
            "result_summary": e.result_summary,
            "success": e.success,
            "message": e.message,
            "elapsed": e.elapsed,
        }
        if e.extra:
            payload["extra"] = e.extra
        on_event(make_event(kind, **redact(payload)))

    loop = AgentLoop(
        provider=provider,
        repo_root=root,
        max_steps=max_steps,
        read_only=read_only,
        verbose=False,
        cards=cards,
        on_event=_adapt,
        memory_store=mem,
        trace_recorder=rec,
    )
    return loop, rec


def _loop_event_to_tui_kind(loop_kind: str) -> str:
    return {
        "plan": "plan",
        "step": "tool_start",
        "step_done": "tool_end",
        "finish": "run_finished",
        "warn": "risk_flag",
        "error": "error",
        "budget": "budget",
    }.get(loop_kind, "system_message")


# ----- simple patching -----


def apply_replace_patch(
    path: str, old: str, new: str, repo_root: str | Path
) -> dict[str, Any]:
    from cheater.patch_engine import make_replace, apply, preview

    try:
        prop = make_replace(path=path, old=old, new=new, description="tui:apply")
    except Exception as e:
        return {"ok": False, "error": f"build: {e}"}
    try:
        prev = preview(prop)
    except Exception as e:
        prev = f"(preview error: {e})"
    try:
        snap = apply(prop)
    except Exception as e:
        return {"ok": False, "error": f"apply: {e}", "preview": prev}
    return {"ok": True, "snapshot_id": snap, "preview": prev}


# ----- top-level entry for one-shot chat/repair -----


def one_shot_agent_run(
    task: str,
    project_root: str | Path,
    *,
    max_steps: int = 20,
    read_only: bool = True,
    on_event: Callable[[TuiEvent], None] | None = None,
) -> dict[str, Any]:
    """Build and run the agent loop synchronously, returning a small result dict.

    Designed to be called from a worker thread. The ``on_event`` callback
    receives :class:`TuiEvent` instances for every agent event.
    """
    try:
        loop, rec = build_agent_loop(
            task=task,
            project_root=project_root,
            read_only=read_only,
            max_steps=max_steps,
            on_event=on_event,
        )
    except Exception as e:
        return {"ok": False, "error": f"build: {e}"}
    try:
        result = loop.run(task)
    except Exception as e:
        return {"ok": False, "error": f"run: {e}"}
    finally:
        try:
            if rec is not None:
                rec.close()
        except Exception:
            pass
    return {
        "ok": True,
        "result": result.to_dict() if hasattr(result, "to_dict") else {},
    }


def one_shot_chat_answer(
    task: str,
    project_root: str | Path,
    *,
    on_event: Callable[[TuiEvent], None] | None = None,
) -> dict[str, Any]:
    """Answer a normal chat message through Cheater's ask-mode agent.

    This is intentionally separate from ``one_shot_agent_run``. Chat mode
    should feel like messaging a local LLM with Cheater context, while repair
    mode can still use the stricter JSON action loop and tool stream.
    """
    from dataclasses import asdict

    from cheater.agent import Agent
    from cheater.config import load_config

    root = Path(project_root).resolve()
    try:
        cfg = load_config(root)
        provider = cfg.provider
        if on_event is not None:
            on_event(
                make_event(
                    "system_message",
                    message=(
                        f"provider={provider.provider or 'none'} "
                        f"model={provider.model or '-'} "
                        f"base_url={provider.base_url or '-'}"
                    ),
                )
            )
        agent = Agent(cfg, project_root=root)
        answer = agent.ask(task)
        if (answer.final or "").startswith("Cheater answer (no model configured):"):
            answer.final = (
                "I can chat through your local model once provider/model/base_url "
                "are configured. Open Settings and use provider `openai` for LM "
                "Studio, Ollama, llama.cpp, or any OpenAI-compatible local server."
            )
        if on_event is not None and answer.plan:
            on_event(make_event("plan", message=answer.plan))
        return {"ok": True, "answer": asdict(answer)}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ----- tools listing (for slash command help) -----


def list_tool_names(read_only: bool = True) -> list[str]:
    from cheater.tools import default_tool_registry

    try:
        return list(default_tool_registry(read_only=read_only).names())
    except Exception:
        return []


# ----- git diff (for review) -----


def git_diff(project_root: str | Path) -> dict[str, Any]:
    import subprocess

    try:
        r = subprocess.run(
            ["git", "diff"],
            cwd=str(project_root),
            capture_output=True,
            text=True,
            timeout=15,
        )
        diff = r.stdout or ""
    except Exception as e:
        return {"ok": False, "error": str(e), "diff": "", "files": []}
    files: list[str] = []
    for line in diff.splitlines():
        if line.startswith("+++ b/") or line.startswith("--- a/"):
            continue
        if line.startswith("+++") or line.startswith("---"):
            continue
        if line.startswith("diff --git "):
            parts = line.split()
            if len(parts) >= 4:
                files.append(parts[-1].lstrip("b/"))
    return {"ok": True, "error": "", "diff": diff[:5000], "files": files}

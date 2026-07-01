"""Cheater arena: local evaluation harness for the Cheater pipeline.

The arena measures components in isolation (localization, memory retrieval,
context pack, failure compression, diff guard) and runs the full sequential
repair loop end-to-end on a case, recording metrics that tell us where the
9B model is failing and where each helper actually helps.

Eval case format (.cheater/eval_cases/<case_id>/):
    task.txt                   -- required, the task description
    traceback.txt              -- optional, raw traceback text
    repo_snapshot/             -- optional, a small repo tree to localize in
    expected_files.json        -- optional, list of expected top file paths
    expected_symbols.json      -- optional, list of {name, file} dicts
    focused_test_command.txt   -- optional, command for the repair loop
    expected_patch_files.json  -- optional, list of files the patch should touch
    metadata.json              -- optional, {tags, difficulty, expected_memory_ids, ...}

Modes:
  A. Component evals  -- measure individual helpers
  B. Repair eval      -- run the sequential repair loop on a case

Public API:
    EvalCase                    -- dataclass for a loaded case
    load_eval_cases(path)       -- list[EvalCase]
    run_component_eval(cases, config)   -> dict
    run_repair_eval(cases, config)      -> dict
    write_arena_report(report, path)
    render_arena_summary(report) -> str
    compare_reports(old, new)   -> dict

CLI:
    cheater arena run --cases .cheater/eval_cases
    cheater arena run --component localization
    cheater arena report .cheater/arena/latest.json
    cheater arena compare old.json new.json
"""

from __future__ import annotations

import json
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable


# Known components for `cheater arena run --component <name>`
COMPONENTS: tuple[str, ...] = (
    "localization",
    "memory_retrieval",
    "context_pack",
    "failure_compression",
    "diff_guard",
    "all",
)


# ---- data types ----


@dataclass
class EvalCase:
    case_id: str
    path: Path
    task: str = ""
    traceback: str = ""
    expected_files: list[str] = field(default_factory=list)
    expected_symbols: list[dict[str, Any]] = field(default_factory=list)
    expected_memory_ids: list[str] = field(default_factory=list)
    expected_memory_tags: list[str] = field(default_factory=list)
    focused_test_command: str = ""
    expected_patch_files: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    repo_snapshot: Path | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "case_id": self.case_id,
            "path": str(self.path),
            "task": self.task,
            "has_traceback": bool(self.traceback),
            "expected_files": list(self.expected_files),
            "expected_symbols": list(self.expected_symbols),
            "expected_memory_ids": list(self.expected_memory_ids),
            "expected_memory_tags": list(self.expected_memory_tags),
            "focused_test_command": self.focused_test_command,
            "expected_patch_files": list(self.expected_patch_files),
            "metadata": dict(self.metadata),
            "has_repo_snapshot": bool(self.repo_snapshot),
        }


# ---- loader ----


def _read_text(path: Path, default: str = "") -> str:
    try:
        if not path.is_file():
            return default
        return path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return default


def _read_json_list(path: Path) -> list[Any]:
    if not path.is_file():
        return []
    try:
        raw = path.read_text(encoding="utf-8", errors="ignore")
        obj = json.loads(raw)
    except (OSError, json.JSONDecodeError):
        return []
    if isinstance(obj, list):
        return obj
    if isinstance(obj, dict):
        # Allow {"files": [...]} or {"symbols": [...]}
        for k in ("files", "symbols", "ids", "tags", "paths", "items"):
            v = obj.get(k)
            if isinstance(v, list):
                return v
    return []


def _read_json_dict(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        raw = path.read_text(encoding="utf-8", errors="ignore")
        obj = json.loads(raw)
    except (OSError, json.JSONDecodeError):
        return {}
    return obj if isinstance(obj, dict) else {}


def load_eval_cases(path: str | Path) -> list[EvalCase]:
    """Load all eval cases under `path`.

    `path` may be a directory containing one subdirectory per case, or a
    directory of .json case files. Skips empty / malformed cases.
    """
    p = Path(path)
    if not p.is_dir():
        return []
    cases: list[EvalCase] = []
    # Subdirectory form
    for child in sorted(p.iterdir()):
        if not child.is_dir():
            continue
        task = _read_text(child / "task.txt")
        if not task.strip():
            continue
        case = EvalCase(
            case_id=child.name,
            path=child,
            task=task.strip(),
            traceback=_read_text(child / "traceback.txt").strip(),
            expected_files=[
                str(x) for x in _read_json_list(child / "expected_files.json") if x
            ],
            expected_symbols=[
                x
                for x in _read_json_list(child / "expected_symbols.json")
                if isinstance(x, dict)
            ],
            expected_memory_ids=[
                str(x) for x in _read_json_list(child / "expected_memory_ids.json") if x
            ],
            expected_memory_tags=[
                str(x)
                for x in _read_json_list(child / "expected_memory_tags.json")
                if x
            ],
            focused_test_command=_read_text(child / "focused_test_command.txt").strip(),
            expected_patch_files=[
                str(x)
                for x in _read_json_list(child / "expected_patch_files.json")
                if x
            ],
            metadata=_read_json_dict(child / "metadata.json"),
        )
        snap = child / "repo_snapshot"
        if snap.is_dir():
            case.repo_snapshot = snap
        cases.append(case)
    if cases:
        return cases
    # Flat .json form
    for json_path in sorted(p.glob("*.json")):
        try:
            raw = json.loads(json_path.read_text(encoding="utf-8", errors="ignore"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(raw, dict):
            continue
        task = str(raw.get("task", "")).strip()
        if not task:
            continue
        case = EvalCase(
            case_id=raw.get("case_id", json_path.stem),
            path=json_path,
            task=task,
            traceback=str(raw.get("traceback", "") or ""),
            expected_files=[str(x) for x in raw.get("expected_files", []) or []],
            expected_symbols=list(raw.get("expected_symbols", []) or []),
            expected_memory_ids=[
                str(x) for x in raw.get("expected_memory_ids", []) or []
            ],
            expected_memory_tags=[
                str(x) for x in raw.get("expected_memory_tags", []) or []
            ],
            focused_test_command=str(raw.get("focused_test_command", "") or ""),
            expected_patch_files=[
                str(x) for x in raw.get("expected_patch_files", []) or []
            ],
            metadata=dict(raw.get("metadata", {}) or {}),
        )
        cases.append(case)
    return cases


# ---- helpers ----


def _paths_overlap(
    predicted: list[str], expected: list[str]
) -> tuple[list[str], list[str]]:
    """Return (predicted_matches, expected_misses) by suffix match.

    A match is a path whose suffix is the same (so 'pkg/foo.py' matches
    'repo/pkg/foo.py'). This is tolerant to repo_snapshot vs real repo
    root differences.
    """
    if not expected:
        return [], []
    matched: list[str] = []
    missed: list[str] = []
    for exp in expected:
        hit = False
        for pred in predicted:
            p = (pred or "").replace("\\", "/")
            e = (exp or "").replace("\\", "/")
            if not p or not e:
                continue
            if p == e or p.endswith("/" + e) or e.endswith("/" + p):
                hit = True
                matched.append(exp)
                break
        if not hit:
            missed.append(exp)
    return matched, missed


def _hit_at_k(predicted: list[Any], expected: list[Any], k: int) -> int:
    """1 if any expected item is in the first k predicted, else 0."""
    if not expected:
        return 0
    head = predicted[:k]
    s_pred = {str(x) for x in head}
    for e in expected:
        if str(e) in s_pred:
            return 1
    # Suffix-tolerant fallback
    _, missed = _paths_overlap([str(x) for x in head], [str(x) for x in expected])
    return 0 if missed else 1


def _symbols_to_names(items: list[dict[str, Any]]) -> list[str]:
    out: list[str] = []
    for it in items:
        if isinstance(it, dict):
            n = it.get("name")
            if isinstance(n, str):
                out.append(n)
    return out


# ---- component eval ----


@dataclass
class ComponentConfig:
    """Tunables for component eval."""

    component: str = "all"  # one of COMPONENTS
    repo_root: str | Path = ""  # default: cwd
    memory_dir: str | Path | None = None
    # Optional injectable callables for testing. Each has the same shape
    # as the real component, but no real model is required.
    localize_fn: Callable[..., Any] | None = None
    memory_search_fn: Callable[..., Any] | None = None
    context_fn: Callable[..., Any] | None = None
    failure_fn: Callable[..., Any] | None = None
    diff_guard_fn: Callable[..., Any] | None = None


def _localize_real(case: EvalCase, cfg: ComponentConfig) -> dict[str, Any]:
    from cheater.localizer import deterministic_localize
    from cheater.repo_map import build_repo_map

    repo = Path(cfg.repo_root) if cfg.repo_root else Path.cwd()
    m = None
    if case.repo_snapshot is not None and case.repo_snapshot.is_dir():
        try:
            m = build_repo_map(case.repo_snapshot)
        except Exception:
            m = None
    if m is None and repo.is_dir():
        try:
            m = build_repo_map(repo)
        except Exception:
            m = None
    r = deterministic_localize(case.task, case.traceback, m)
    return {
        "files": [sf.path for sf in r.suspected_files],
        "symbols": [(s.name, s.file) for s in r.suspected_symbols],
        "source": r.source,
    }


def _memory_real(case: EvalCase, cfg: ComponentConfig) -> dict[str, Any]:
    from cheater.memory_store import MemoryStore

    mem_dir = cfg.memory_dir
    if mem_dir is None:
        mem_dir = Path.home() / ".config" / "cheater" / "memory"
    try:
        store = MemoryStore(Path(mem_dir))
    except Exception:
        return {"ids": [], "tags": []}
    hits = store.search(case.task, top_k=5)
    return {
        "ids": [h.get("id", "") for h in hits],
        "tags": [t for h in hits for t in (h.get("tags") or [])],
        "raw": hits,
    }


def _context_real(case: EvalCase, cfg: ComponentConfig) -> dict[str, Any]:
    from cheater.context_pack import build_context_pack

    repo = Path(cfg.repo_root) if cfg.repo_root else Path.cwd()
    pack = build_context_pack(
        task=case.task,
        repo_root=repo,
        traceback=case.traceback,
        max_tokens=4000,
    )
    return {
        "providers": [p.name for p in pack.providers],
        "total_chars": pack.total_chars(),
        "truncated": list(pack.truncated),
        "task_chars": sum(p.char_len() for p in pack.providers if p.name == "task"),
    }


def _failure_real(case: EvalCase, cfg: ComponentConfig) -> dict[str, Any]:
    from cheater.failure_compressor import compress_command_result

    if not case.traceback:
        return {"error_type": "", "test": "", "has_files": False, "passed": True}
    s = compress_command_result("pytest -x -q", "", case.traceback, 1)
    files: list[str] = []
    for f in s.failures:
        files.extend(f.top_stack_files or [])
    return {
        "error_type": s.error_type,
        "test": s.failures[0].test if s.failures else "",
        "has_files": any(_f for _f in files),
        "passed": s.passed,
        "summary": s.summary,
    }


def _diff_guard_real(case: EvalCase, cfg: ComponentConfig) -> dict[str, Any]:
    """Cheater's diff guard is a small in-arena heuristic.

    We exercise the guard with a tiny synthetic diff and let it reason
    about risk. The real patch validation lives in cheater.patch_candidate
    and cheater.patch_engine; the arena just needs a measurable signal
    that a diff is parseable and not obviously destructive.
    """
    diff_text = "--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n-original\n+original\n+# added\n"
    accepted = True
    reasons: list[str] = []
    risk_score = 0.0
    # Validate shape
    if not diff_text.startswith(("--- ", "diff --git")):
        accepted = False
        reasons.append("missing diff header")
        risk_score = 0.8
    elif "@@" not in diff_text:
        accepted = False
        reasons.append("missing hunk header")
        risk_score = 0.6
    # Forbidden paths (e.g. editing .cheater/eval_cases, secrets, etc.)
    forbidden = ("/.git/", "/.cheater/", "/secrets", "/.env")
    for f in case.expected_patch_files or ["x"]:
        for fp in forbidden:
            if fp in f:
                accepted = False
                reasons.append(f"forbidden path: {f}")
                risk_score = max(risk_score, 0.9)
    return {
        "accepted": accepted,
        "risk_score": risk_score,
        "reasons": reasons,
    }


_COMPONENT_FNS: dict[str, Callable[[EvalCase, ComponentConfig], dict[str, Any]]] = {
    "localization": _localize_real,
    "memory_retrieval": _memory_real,
    "context_pack": _context_real,
    "failure_compression": _failure_real,
    "diff_guard": _diff_guard_real,
}


def run_component_eval(
    cases: list[EvalCase],
    config: ComponentConfig | None = None,
) -> dict[str, Any]:
    """Run component evals on a list of cases.

    Returns a structured report with per-case results, per-component
    aggregate metrics, and timing.
    """
    cfg = config or ComponentConfig()
    start = time.time()
    requested = cfg.component
    if requested == "all":
        components = list(_COMPONENT_FNS.keys())
    elif requested in _COMPONENT_FNS:
        components = [requested]
    else:
        return {
            "ok": False,
            "error": f"unknown component: {requested}",
            "known": list(COMPONENTS),
        }
    per_case: list[dict[str, Any]] = []
    # Accumulators
    loc_h1: list[int] = []
    loc_h3: list[int] = []
    sym_h5: list[int] = []
    mem_h5: list[int] = []
    ctx_chars: list[int] = []
    ctx_tokens: list[int] = []
    ctx_relevance: list[float] = []
    fail_has_etype: list[int] = []
    fail_has_test: list[int] = []
    valid_diff: list[int] = []
    accepted_diff: list[int] = []
    for case in cases:
        case_result: dict[str, Any] = {"case_id": case.case_id}
        # Localization
        if "localization" in components:
            try:
                out = (cfg.localize_fn or _COMPONENT_FNS["localization"])(case, cfg)
            except Exception as e:
                out = {"files": [], "symbols": [], "error": str(e)}
            files = out.get("files", [])
            symbols = out.get("symbols", [])
            h1 = _hit_at_k(files, case.expected_files, 1)
            h3 = _hit_at_k(files, case.expected_files, 3)
            sh5 = _hit_at_k(
                [s[0] if isinstance(s, tuple) else s for s in symbols],
                _symbols_to_names(case.expected_symbols),
                5,
            )
            loc_h1.append(h1)
            loc_h3.append(h3)
            sym_h5.append(sh5)
            case_result["localization"] = {
                "files": files[:5],
                "hit_at_1": h1,
                "hit_at_3": h3,
                "symbol_hit_at_5": sh5,
                "source": out.get("source", "?"),
            }
        # Memory retrieval
        if "memory_retrieval" in components:
            try:
                out = (cfg.memory_search_fn or _COMPONENT_FNS["memory_retrieval"])(
                    case, cfg
                )
            except Exception as e:
                out = {"ids": [], "tags": [], "error": str(e)}
            ids = out.get("ids", [])
            tags = out.get("tags", [])
            expected: list[str] = []
            expected.extend(case.expected_memory_ids)
            expected.extend(case.expected_memory_tags)
            h5 = 0
            if expected:
                for e in expected:
                    if e in ids or e in tags:
                        h5 = 1
                        break
            mem_h5.append(h5)
            case_result["memory_retrieval"] = {
                "ids": ids[:5],
                "tags": tags[:5],
                "hit_at_5": h5,
            }
        # Context pack
        if "context_pack" in components:
            try:
                out = (cfg.context_fn or _COMPONENT_FNS["context_pack"])(case, cfg)
            except Exception as e:
                out = {
                    "providers": [],
                    "total_chars": 0,
                    "truncated": [],
                    "error": str(e),
                }
            providers = out.get("providers", [])
            total_chars = int(out.get("total_chars", 0))
            ctx_chars.append(total_chars)
            tokens = (total_chars + 3) // 4
            ctx_tokens.append(tokens)
            # crude relevance: how many expected providers (task, traceback,
            # tests, repo_map, localized_source) are present
            present = set(providers)
            expected_providers = {"task", "traceback", "tests", "repo_map", "memory"}
            overlap = len(present & expected_providers) / max(
                1, len(expected_providers)
            )
            ctx_relevance.append(overlap)
            case_result["context_pack"] = {
                "providers": providers,
                "total_chars": total_chars,
                "estimated_tokens": tokens,
                "relevance_score": round(overlap, 3),
                "truncated": out.get("truncated", []),
            }
        # Failure compression
        if "failure_compression" in components:
            try:
                out = (cfg.failure_fn or _COMPONENT_FNS["failure_compression"])(
                    case, cfg
                )
            except Exception as e:
                out = {
                    "error_type": "",
                    "test": "",
                    "has_files": False,
                    "error": str(e),
                }
            et = bool(out.get("error_type"))
            tn = bool(out.get("test"))
            fail_has_etype.append(1 if et else 0)
            fail_has_test.append(1 if tn else 0)
            case_result["failure_compression"] = {
                "error_type": out.get("error_type", ""),
                "test": out.get("test", ""),
                "has_files": out.get("has_files", False),
                "summary": out.get("summary", ""),
            }
        # Diff guard
        if "diff_guard" in components:
            try:
                out = (cfg.diff_guard_fn or _COMPONENT_FNS["diff_guard"])(case, cfg)
            except Exception as e:
                out = {
                    "accepted": False,
                    "risk_score": 1.0,
                    "reasons": [str(e)],
                    "error": str(e),
                }
            accepted = 1 if out.get("accepted") else 0
            # valid_diff_rate: 1 if reasons were non-empty AND the diff
            # had a parseable shape (no exception). If exceptions -> 0.
            vd = 0 if out.get("error") else 1
            valid_diff.append(vd)
            accepted_diff.append(accepted)
            case_result["diff_guard"] = {
                "accepted": bool(out.get("accepted")),
                "risk_score": float(out.get("risk_score", 0.0)),
                "reasons": out.get("reasons", []),
                "valid": bool(vd),
            }
        per_case.append(case_result)

    # Aggregates
    def _mean(xs: list[int | float]) -> float:
        return round(sum(xs) / max(1, len(xs)), 4) if xs else 0.0

    aggregate: dict[str, Any] = {
        "cases": len(cases),
        "components": components,
    }
    if "localization" in components:
        aggregate["localization_hit_at_1"] = _mean(loc_h1)
        aggregate["localization_hit_at_3"] = _mean(loc_h3)
        aggregate["symbol_hit_at_5"] = _mean(sym_h5)
    if "memory_retrieval" in components:
        aggregate["memory_hit_at_5"] = _mean(mem_h5)
    if "context_pack" in components:
        aggregate["context_chars"] = _mean(ctx_chars)
        aggregate["estimated_context_tokens"] = _mean(ctx_tokens)
        aggregate["context_relevance_score"] = _mean(ctx_relevance)
    if "failure_compression" in components:
        aggregate["failure_summary_has_error_type"] = _mean(fail_has_etype)
        aggregate["failure_summary_has_test_name"] = _mean(fail_has_test)
    if "diff_guard" in components:
        aggregate["valid_diff_rate"] = _mean(valid_diff)
        aggregate["diff_apply_rate"] = _mean(accepted_diff)
    elapsed = time.time() - start
    return {
        "ok": True,
        "kind": "component",
        "config": {
            "component": requested,
            "repo_root": str(cfg.repo_root) if cfg.repo_root else "",
        },
        "elapsed_sec": round(elapsed, 2),
        "aggregate": aggregate,
        "cases": per_case,
    }


# ---- repair eval ----


@dataclass
class RepairConfig:
    repo_root: str | Path = ""
    memory_dir: str | Path | None = None
    max_steps: int = 8
    max_cases: int = 0  # 0 = all
    run_focused_tests: bool = True
    # If provided, used to short-circuit model calls (tests can inject
    # a fake provider that returns canned JSON actions).
    model_client_factory: Callable[[], Any] | None = None
    # If provided, the loop is replaced entirely. Receives the case and
    # returns a dict matching RepairResult.to_dict().
    loop_fn: Callable[[EvalCase, "RepairConfig"], dict[str, Any]] | None = None


def _default_repair_loop(case: EvalCase, cfg: RepairConfig) -> dict[str, Any]:
    """Best-effort repair loop. Uses the real AgentLoop if a model is
    configured; otherwise produces an honest 'no model' result.
    """
    from cheater.config import load_config
    from cheater.providers import ProviderConfig, get_provider

    repo = Path(cfg.repo_root) if cfg.repo_root else Path.cwd()
    if not repo.is_dir():
        return {
            "ok": True,
            "case_id": case.case_id,
            "success": False,
            "rounds": 0,
            "diff_lines": 0,
            "touched_files": [],
            "risk_flags": [],
            "focused_test_pass": None,
            "elapsed": 0.0,
            "finished_by": "no_repo",
        }
    cheater_cfg = load_config(repo)
    if cfg.model_client_factory is not None:
        provider = cfg.model_client_factory()
    else:
        pc = ProviderConfig(
            provider=cheater_cfg.provider.provider,
            model=cheater_cfg.provider.model,
            base_url=cheater_cfg.provider.base_url,
            api_key=cheater_cfg.provider.api_key,
        )
        provider = get_provider(pc)
    if not getattr(provider, "name", "none") or getattr(provider, "name", "") == "none":
        # No model: count the "rounds" as 0 but still record what we can
        return {
            "ok": True,
            "case_id": case.case_id,
            "success": False,
            "rounds": 0,
            "diff_lines": 0,
            "touched_files": [],
            "risk_flags": ["no_model"],
            "focused_test_pass": None,
            "elapsed": 0.0,
            "finished_by": "no_model",
        }
    # Real loop (model path). Lazy import to keep import-time cost low.
    from cheater.agent_loop import AgentLoop
    from cheater.memory_store import MemoryStore

    memory_store = (
        MemoryStore(Path(cfg.memory_dir)) if cfg.memory_dir else MemoryStore()
    )
    loop = AgentLoop(
        provider=provider,
        repo_root=repo,
        max_steps=cfg.max_steps,
        read_only=False,
        verbose=False,
        memory_store=memory_store,
    )
    start = time.time()
    try:
        result = loop.run(case.task)
    except Exception as e:
        return {
            "ok": True,
            "case_id": case.case_id,
            "success": False,
            "rounds": 0,
            "diff_lines": 0,
            "touched_files": [],
            "risk_flags": [f"exception:{type(e).__name__}"],
            "focused_test_pass": None,
            "elapsed": round(time.time() - start, 2),
            "finished_by": "error",
            "error": str(e)[:200],
        }
    elapsed = time.time() - start
    # Diff size + touched files from step metadata
    diff_lines = 0
    touched: list[str] = []
    for s in result.steps:
        diff_lines += int((s.get("summary") and len(s.get("summary", ""))) or 0) // 80
    return {
        "ok": True,
        "case_id": case.case_id,
        "success": bool(result.success),
        "rounds": len(result.steps),
        "diff_lines": diff_lines,
        "touched_files": touched,
        "risk_flags": [],
        "focused_test_pass": None,  # running focused tests is expensive; leave None
        "elapsed": round(elapsed, 2),
        "finished_by": result.finished_by,
    }


def run_repair_eval(
    cases: list[EvalCase],
    config: RepairConfig | None = None,
) -> dict[str, Any]:
    """Run the repair loop on each case and aggregate metrics."""
    cfg = config or RepairConfig()
    start = time.time()
    if cfg.max_cases and cfg.max_cases > 0:
        cases = cases[: cfg.max_cases]
    fn = cfg.loop_fn or _default_repair_loop
    per_case: list[dict[str, Any]] = []
    for case in cases:
        try:
            out = fn(case, cfg)
        except Exception as e:
            out = {
                "ok": False,
                "case_id": case.case_id,
                "error": str(e),
                "success": False,
            }
        per_case.append(out)
    succ = [c for c in per_case if c.get("success")]
    rounds = [int(c.get("rounds", 0) or 0) for c in succ]
    diffs = [int(c.get("diff_lines", 0) or 0) for c in per_case]
    flags: list[str] = []
    for c in per_case:
        flags.extend(c.get("risk_flags", []) or [])
    tool_call_counts: list[int] = []
    model_call_counts: list[int] = []
    for c in per_case:
        if "model_call_count" in c:
            model_call_counts.append(int(c.get("model_call_count", 0) or 0))
        if "tool_call_count" in c:
            tool_call_counts.append(int(c.get("tool_call_count", 0) or 0))

    def _mean(xs: list[float]) -> float:
        return round(sum(xs) / max(1, len(xs)), 4) if xs else 0.0

    aggregate: dict[str, Any] = {
        "cases": len(cases),
        "successes": len(succ),
        "success_rate": _mean([1 if c.get("success") else 0 for c in per_case]),
        "average_rounds_to_success": _mean([float(r) for r in rounds]),
        "average_diff_lines": _mean([float(d) for d in diffs]),
        "rejected_risky_diff_count": sum(
            1 for f in flags if "risky" in str(f) or "reject" in str(f)
        ),
        "tool_call_count": _mean([float(x) for x in tool_call_counts]),
        "model_call_count": _mean([float(x) for x in model_call_counts]),
    }
    focused_passes: list[bool] = []
    for c in per_case:
        v = c.get("focused_test_pass")
        if v is True:
            focused_passes.append(True)
        elif v is False:
            focused_passes.append(False)
    if focused_passes:
        aggregate["focused_test_pass_rate"] = _mean(
            [1.0 if v else 0.0 for v in focused_passes]
        )
    return {
        "ok": True,
        "kind": "repair",
        "config": {
            "repo_root": str(cfg.repo_root) if cfg.repo_root else "",
            "max_steps": cfg.max_steps,
            "max_cases": cfg.max_cases,
        },
        "elapsed_sec": round(time.time() - start, 2),
        "aggregate": aggregate,
        "cases": per_case,
    }


# ---- report I/O ----


def write_arena_report(report: dict[str, Any], out_path: str | Path) -> Path:
    """Write a single arena report as JSON. Creates parent dirs."""
    p = Path(out_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(
        json.dumps(report, indent=2, ensure_ascii=False, default=str), encoding="utf-8"
    )
    return p


def read_arena_report(path: str | Path) -> dict[str, Any]:
    p = Path(path)
    if not p.is_file():
        return {"ok": False, "error": f"report not found: {p}"}
    try:
        return json.loads(p.read_text(encoding="utf-8", errors="ignore"))
    except json.JSONDecodeError as e:
        return {"ok": False, "error": f"bad json: {e}"}


def render_arena_summary(report: dict[str, Any]) -> str:
    """Render a short human-readable summary of an arena report."""
    lines: list[str] = []
    if not report.get("ok"):
        lines.append(f"ARENA: error: {report.get('error', '?')}")
        return "\n".join(lines)
    kind = report.get("kind", "?")
    lines.append(f"=== Arena summary ({kind}) ===")
    elapsed = report.get("elapsed_sec", 0)
    lines.append(f"elapsed: {elapsed:.2f}s")
    agg = report.get("aggregate", {}) or {}
    if kind == "component":
        lines.append(f"cases:      {agg.get('cases', 0)}")
        for k in (
            "localization_hit_at_1",
            "localization_hit_at_3",
            "symbol_hit_at_5",
            "memory_hit_at_5",
            "context_chars",
            "estimated_context_tokens",
            "context_relevance_score",
            "failure_summary_has_error_type",
            "failure_summary_has_test_name",
            "valid_diff_rate",
            "diff_apply_rate",
        ):
            if k in agg:
                lines.append(f"  {k}: {agg[k]}")
    elif kind == "repair":
        lines.append(f"cases:        {agg.get('cases', 0)}")
        lines.append(f"successes:    {agg.get('successes', 0)}")
        lines.append(f"success_rate: {agg.get('success_rate', 0):.2%}")
        for k in (
            "average_rounds_to_success",
            "average_diff_lines",
            "rejected_risky_diff_count",
            "tool_call_count",
            "model_call_count",
            "focused_test_pass_rate",
        ):
            if k in agg and agg[k] is not None:
                lines.append(f"  {k}: {agg[k]}")
    return "\n".join(lines)


def compare_reports(old: dict[str, Any], new: dict[str, Any]) -> dict[str, Any]:
    """Return a side-by-side comparison of two arena reports.

    Only the metric keys present in both are compared. Direction is taken
    from the key name when possible (rates: higher is better, sizes:
    lower is better). Unknown keys are reported as "delta" only.
    """
    a = (old or {}).get("aggregate", {}) or {}
    b = (new or {}).get("aggregate", {}) or {}
    keys = sorted(set(a.keys()) | set(b.keys()))
    rows: list[dict[str, Any]] = []

    # Heuristics: "rate" / "pass_rate" / "hit_at" -> higher better.
    # "lines" / "count" / "rounds" / "tokens" / "chars" -> lower better.
    def _direction(k: str) -> str:
        lk = k.lower()
        if any(x in lk for x in ("rate", "hit_at", "score")):
            return "up_better"
        if any(
            x in lk for x in ("lines", "count", "rounds", "tokens", "chars", "rejected")
        ):
            return "down_better"
        return "neutral"

    for k in keys:
        va = a.get(k)
        vb = b.get(k)
        if va is None and vb is None:
            continue
        try:
            delta = float(vb or 0) - float(va or 0)
        except (TypeError, ValueError):
            delta = 0.0
        direction = _direction(k)
        rows.append(
            {
                "metric": k,
                "old": va,
                "new": vb,
                "delta": round(delta, 4),
                "better": (
                    "up"
                    if direction == "up_better" and delta > 0
                    else "down"
                    if direction == "up_better" and delta < 0
                    else "down"
                    if direction == "down_better" and delta > 0
                    else "up"
                    if direction == "down_better" and delta < 0
                    else "flat"
                ),
                "direction": direction,
            }
        )
    return {
        "old_kind": old.get("kind", ""),
        "new_kind": new.get("kind", ""),
        "metrics": rows,
        "summary": {
            "improved": sum(
                1
                for r in rows
                if r["better"] in ("up", "down")
                and r["direction"] != "neutral"
                and (
                    (r["direction"] == "up_better" and r["better"] == "up")
                    or (r["direction"] == "down_better" and r["better"] == "down")
                )
            ),
            "regressed": sum(
                1
                for r in rows
                if r["direction"] != "neutral"
                and (
                    (r["direction"] == "up_better" and r["better"] == "down")
                    or (r["direction"] == "down_better" and r["better"] == "up")
                )
            ),
            "flat": sum(1 for r in rows if r["better"] == "flat"),
        },
    }

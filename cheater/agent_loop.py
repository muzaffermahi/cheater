"""The Cheater agent loop (v0.4 — the 9B adaptation pass).

v0.3 was the foundation: constrained tools, evidence-required finish,
working memory, retry. v0.4 adds:

  1. Forgiving tool-call parser (multi-format + auto-repair)
  2. Context budget engine (cap, evict, compress)
  3. 2-stage tool routing (category first, then tools)
  4. TODO-driven planning (re-anchor plan each turn)
  5. Quality monitor (catch empty turns, hallucinated tools, repeats)
  6. Tool-call dedup (cache results for read-only tools)

Plus adaptive retry temperature (different temp per attempt).

The loop is designed to make 9B local models work reliably. The
constraints we built in v0.3 (JSON tools, evidence-required finish)
are still there. The new features help the model USE those constraints
correctly: forgiving parser catches the malformed output, budget engine
prevents context overflow, 2-stage routing halves schema overhead,
TODO planning prevents drift, quality monitor catches failure modes,
dedup stops redundant calls.

Works without a model: returns finished_by="no_model" honestly.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from cheater.budget import ContextBudget
from cheater.dedup import ToolCallDedup
from cheater.parser import parse_json_loose, parse_tool_call, repair_json
from cheater.prompts import (
    PLAN_PROMPT,
    SMALL_MODEL_HARNESS_NUDGE,
    SYSTEM_PROMPT,
)
from cheater.quality_monitor import QualityMonitor
from cheater.tools import (
    ToolContext,
    default_tool_registry,
)
from cheater.working_memory import Step, WorkingMemory


# CATEGORIES list is sent to the model in the 2-stage router
CATEGORIES: list[str] = ["read", "write", "run", "meta"]


# Adaptive retry temperature schedule
RETRY_TEMPERATURE_SCHEDULE: list[float] = [-0.15, 0.0, +0.15]


@dataclass
class LoopResult:
    """Result of an agent loop run."""

    success: bool
    task: str
    steps: list[dict[str, Any]] = field(default_factory=list)
    plan: list[str] = field(default_factory=list)
    summary: str = ""
    error: str = ""
    finished_by: str = ""
    elapsed: float = 0.0
    working_memory: dict[str, Any] = field(default_factory=dict)
    budget: dict[str, Any] = field(default_factory=dict)
    # v0.8: lifecycle outputs. Always present as None when no
    # controller was provided, so older callers are unaffected.
    ledger: dict[str, Any] | None = None
    robustness: dict[str, Any] | None = None
    stuck: dict[str, Any] | None = None
    playbook: str = ""
    # v0.9: anti-stall outcome. Always None when no anti-stall
    # controller was attached, so older callers are unaffected.
    anti_stall: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "success": self.success,
            "task": self.task,
            "steps": self.steps,
            "plan": self.plan,
            "summary": self.summary,
            "error": self.error,
            "finished_by": self.finished_by,
            "elapsed": round(self.elapsed, 2),
            "budget": self.budget,
            "playbook": self.playbook,
            "ledger": self.ledger,
            "robustness": self.robustness,
            "stuck": self.stuck,
            "anti_stall": self.anti_stall,
        }


@dataclass
class LoopEvent:
    kind: str  # "plan", "step", "finish", "warn", "error", "budget"
    step_num: int = 0
    action: str = ""
    args: dict = field(default_factory=dict)
    result_summary: str = ""
    success: bool = True
    message: str = ""
    elapsed: float = 0.0
    extra: dict = field(default_factory=dict)


class AgentLoop:
    """The Cheater multi-step agent loop (v0.4)."""

    def __init__(
        self,
        provider: Any,
        repo_root: str | Path,
        *,
        max_steps: int = 20,
        read_only: bool = False,
        verbose: bool = False,
        cards: list[dict] | None = None,
        on_event: Callable[[LoopEvent], None] | None = None,
        # v0.4 tuning knobs
        budget_max_chars: int = 20000,
        tool_cap: int = 4000,
        dedup_window: int = 5,
        quality_monitor_enabled: bool = True,
        two_stage_routing: bool = True,
        todo_anchoring: bool = True,
        memory_store: Any | None = None,
        memory_top_k: int = 3,
        # v0.7: arena / distiller / tool-policy integration
        trace_recorder: Any | None = None,
        tool_policy_enabled: bool = True,
        context_optimizer: Any | None = None,
        auto_compact_context: bool = True,
        context_compact_ratio: float = 0.85,
        compact_keep_last: int = 8,
        max_context_tokens: int = 100000,
        # v0.8: lifecycle controller. When provided, the agent loop:
        #   * wraps the runner so every command is classified and recorded
        #   * gates the finish action through the controller's ledger
        #   * reports a robustness score at the end of the run
        # When None, behavior is identical to v0.7.
        lifecycle_controller: Any | None = None,
        # v0.9: anti-stall controller. When provided (or attached to
        # the lifecycle controller), the agent loop:
        #   * gates the finish action through the anti-stall controller
        #   * forces a fresh worker / strategy switch when the loop
        #     has stalled past the recovery ladder
        # When None, behavior is identical to v0.8.
        anti_stall_controller: Any | None = None,
    ) -> None:
        self.provider = provider
        self.repo_root = Path(repo_root).resolve()
        self.max_steps = max(1, max_steps)
        self.read_only = read_only
        self.verbose = verbose
        self.registry = default_tool_registry(read_only=read_only)
        self._provider_context_tokens = self._detect_provider_context_window(provider)
        self.max_context_tokens = self._effective_context_tokens(max_context_tokens)
        if budget_max_chars == 20000:
            budget_max_chars = self.max_context_tokens * 4
        self.memory = WorkingMemory(
            max_chars=min(24000, max(8000, budget_max_chars // 6))
        )
        self.budget = ContextBudget(max_chars=budget_max_chars, tool_cap=tool_cap)
        self.dedup = ToolCallDedup(window=dedup_window)
        self.quality = QualityMonitor() if quality_monitor_enabled else None
        self.two_stage = two_stage_routing
        self.todo_anchoring = todo_anchoring
        # v0.5: agent-curated memory (None means no memory tools available)
        self.memory_store = memory_store
        self.memory_top_k = memory_top_k
        # v0.7: optional self-improvement instrumentation
        self.trace_recorder = trace_recorder
        self.tool_policy_enabled = bool(tool_policy_enabled)
        self.context_optimizer = context_optimizer
        self.auto_compact_context = auto_compact_context
        self.context_compact_ratio = max(0.1, min(1.0, context_compact_ratio))
        self.compact_keep_last = max(1, compact_keep_last)
        # Lazy imports
        from cheater.runner import run as runner_run
        from cheater.memory import memory_search

        self._runner_run = runner_run
        self._memory_search = memory_search
        # v0.8: lifecycle controller. When present, the runner is wrapped
        # so the controller can record every command, and the finish path
        # is gated by the ledger.
        self.lifecycle = lifecycle_controller
        # v0.9: anti-stall controller. Two ways to attach it:
        #   1. Pass it directly via the constructor.
        #   2. The lifecycle controller already has one (via
        #      LifecycleController.anti_stall). In that case we use it
        #      but do NOT double-wrap.
        self.anti_stall = anti_stall_controller
        if self.anti_stall is None and self.lifecycle is not None:
            self.anti_stall = getattr(self.lifecycle, "anti_stall", None)
        if self.lifecycle is not None:
            try:
                self._runner_run = self.lifecycle.wrap_runner(self._runner_run)
            except Exception:
                # If the controller fails to wrap, fall back to the raw
                # runner. Lifecycle is additive, never required.
                pass
            try:
                self.lifecycle.worker_max_steps = self.max_steps
            except Exception:
                pass
        self._cards = cards or []
        self.on_event = on_event or (lambda e: None)
        # Per-step state
        self._plan_step_status: list[str] = []  # pending | in_progress | done
        self._category: str = ""  # last category used (for re-anchor)
        # v0.6: small-model harness. Build the repo map eagerly so the
        # system prompt can reference it. Cache it on the instance so we
        # don't rebuild every step.
        self._repo_map = None
        self._repo_map_excerpt: str = ""
        self._harness_nudge: str = SMALL_MODEL_HARNESS_NUDGE
        try:
            from cheater.repo_map import build_repo_map

            self._repo_map = build_repo_map(self.repo_root)
            # Excerpt is built lazily, once the task is known.
        except Exception:
            self._repo_map = None

    @staticmethod
    def _detect_provider_context_window(provider: Any) -> int | None:
        try:
            getter = getattr(provider, "get_context_window", None)
            if callable(getter):
                value = getter()
                if isinstance(value, int) and value > 0:
                    return value
        except Exception:
            return None
        return None

    def _effective_context_tokens(self, configured: int | None) -> int:
        candidates = [100000]
        if configured and configured > 0:
            candidates.append(int(configured))
        if self._provider_context_tokens and self._provider_context_tokens > 0:
            candidates.append(int(self._provider_context_tokens))
        return max(1024, min(candidates))

    @property
    def compact_threshold_tokens(self) -> int:
        return max(512, int(self.max_context_tokens * self.context_compact_ratio))

    def _trace(self, event_type: str, payload: dict | None = None) -> None:
        """Record a trace event if a TraceRecorder is attached."""
        rec = self.trace_recorder
        if rec is None:
            return
        try:
            rec.record(event_type, payload or {})
        except Exception:
            pass

    def _tool_policy_nudge(self, task: str) -> str:
        """Return a short nudge from the tool policy, or "" if disabled."""
        if not self.tool_policy_enabled:
            return ""
        try:
            from cheater.tool_policy import (
                infer_state,
                recommend_tools,
                render_tool_policy_nudge,
            )

            last_event: dict | None = None
            # Use the most recent failure_summary event we have, if any
            fs = self._last_failure_summary()
            if fs is not None:
                last_event = {"event": "failure_summary", "payload": fs}
            state = infer_state(task, last_event, fs)
            rec_obj = recommend_tools(state, available_tools=self.registry.names())
            return render_tool_policy_nudge(rec_obj)
        except Exception:
            return ""

    def _last_failure_summary(self) -> dict | None:
        """Return the failure summary dict of the most recent command_run
        step that failed, or None. Cheap: walks result.steps on the live
        working memory.
        """
        try:
            for s in reversed(self.memory.steps):
                if s.action in ("run_command", "test_summary", "run_focused_tests"):
                    if not s.success and s.summary:
                        return {
                            "error_type": "",
                            "test": "",
                            "summary": s.summary,
                            "passed": False,
                        }
        except Exception:
            return None
        return None

    def _emit(self, event: LoopEvent) -> None:
        self.on_event(event)
        if self.verbose:
            print(f"[{event.kind}] {event.message}")

    # ---- public API ----

    def run(self, task: str) -> LoopResult:
        start = time.time()
        result = LoopResult(success=False, task=task)
        # v0.7: emit run_start and task_received traces
        self._trace(
            "run_start",
            {
                "task": task,
                "repo_root": str(self.repo_root),
                "max_steps": self.max_steps,
                "read_only": self.read_only,
            },
        )
        self._trace("task_received", {"task": task})
        if not self._has_model():
            result.finished_by = "no_model"
            result.error = "no model configured; cannot run the agent loop"
            result.elapsed = time.time() - start
            if self.lifecycle is not None:
                try:
                    self.lifecycle.finalize(
                        success=False,
                        reason=result.error,
                        confidence="low",
                    )
                    result.ledger = self.lifecycle.ledger.to_dict()
                    result.robustness = self.lifecycle.score().to_dict()
                    result.playbook = self.lifecycle.playbook.kind.value
                except Exception:
                    pass
            self._trace(
                "run_finished",
                {
                    "success": False,
                    "finished_by": result.finished_by,
                    "elapsed": round(result.elapsed, 2),
                    "error": result.error,
                    "steps": len(result.steps),
                },
            )
            return result
        # 1. Plan
        try:
            plan = self._plan(task)
        except Exception as e:
            result.error = f"plan failed: {e}"
            result.finished_by = "error"
            result.elapsed = time.time() - start
            self._trace(
                "run_finished",
                {
                    "success": False,
                    "finished_by": result.finished_by,
                    "elapsed": round(result.elapsed, 2),
                    "error": result.error,
                    "steps": len(result.steps),
                },
            )
            return result
        result.plan = plan
        self.memory.set_plan(plan)
        self._plan_step_status = ["pending"] * len(plan)
        self.budget.allocate(
            "plan", "\n".join(f"  {i + 1}. {p}" for i, p in enumerate(plan))
        )
        self._emit(LoopEvent(kind="plan", message=f"Plan: {len(plan)} steps"))
        # 2. Loop
        last_action_str = "(none)"
        last_result_str = "(none)"
        quality_steer: str | None = None
        category_hint: str | None = None
        retry_count = 0
        last_action_name: str | None = None
        for step_num in range(1, self.max_steps + 1):
            self._maybe_compact_context(step_num=step_num, reason="pre-model call")
            if self.verbose:
                print(
                    f"[DEBUG] === step {step_num} ===  category_hint={category_hint}  quality_steer={'set' if quality_steer else 'none'}"
                )
            # Get next action
            try:
                action_obj, raw = self._next_action(
                    task=task,
                    plan=plan,
                    last_action=last_action_str,
                    last_result=last_result_str,
                    quality_steer=quality_steer,
                    category_hint=category_hint,
                    step_num=step_num,
                )
            except _ModelUnavailable as e:
                result.finished_by = "no_model"
                result.error = str(e)
                break
            except _InvalidJSONAfterRetry as e:
                result.finished_by = "i_dont_know"
                result.error = f"model could not produce valid JSON after retry: {e}"
                break
            if action_obj is None:
                result.finished_by = "i_dont_know"
                result.error = "model returned empty response"
                break
            # v0.7: trace the model output
            try:
                self._trace(
                    "model_output",
                    {
                        "parsed_action": {
                            "action": str(action_obj.get("action", "")),
                            "args": _truncate_args_dict(
                                action_obj.get("args", {}) or {}
                            ),
                        },
                        "tokens_est": max(1, len(str(raw)) // 4),
                    },
                )
            except Exception:
                pass
            # 2-stage routing: if the model picked a category instead of a tool, ask again
            if (
                self.two_stage
                and "category" in action_obj
                and "action" not in action_obj
            ):
                cat = action_obj.get("category", "").lower()
                if cat in self.registry.categories():
                    self._category = cat
                    category_hint = cat
                    # Loop back and ask for the actual action in this category
                    quality_steer = (
                        f"[ROUTING] Category '{cat}' selected. "
                        f"Available tools in '{cat}': {', '.join(t.name for t in self.registry.tools_in_category(cat))}. "
                        f"Output the next action as a single JSON object with 'action' and 'args'."
                    )
                    if self.verbose:
                        print(f"[DEBUG] category picked: {cat}; continuing")
                    continue
                else:
                    quality_steer = (
                        f"[ROUTING] Unknown category '{cat}'. "
                        f"Valid: {', '.join(self.registry.categories())}. "
                        f"Output a single JSON object with 'action' and 'args'."
                    )
                    continue
            action_name = action_obj.get("action", "")
            args = action_obj.get("args", {})
            if self.verbose:
                print(f"[DEBUG]   -> processing action {action_name}({args})")
            # Tool-call dedup FIRST: if it's a cached call, use the cache
            # (don't flag it as a quality issue; re-reading is legitimate)
            cached = self.dedup.check(action_name, args)
            if self.verbose:
                print(
                    f"[DEBUG] dedup.check({action_name}, {args}) -> cached={cached is not None}"
                )
            if cached is not None:
                step = Step(
                    action=action_name,
                    args=args,
                    summary=f"[cached] {cached.summary}",
                    success=cached.success,
                    elapsed=0.0,
                )
                step.files_read = cached.files_read
                self.memory.record(step)
                result.steps.append(
                    {
                        "step": step_num,
                        "action": action_name,
                        "args": args,
                        "summary": f"[dedup-cached] {cached.summary}",
                        "success": cached.success,
                    }
                )
                self._emit(
                    LoopEvent(
                        kind="step",
                        step_num=step_num,
                        action=action_name,
                        args=args,
                        result_summary=f"[dedup-cached] {cached.summary}",
                        success=cached.success,
                        message=f"[{step_num}/{self.max_steps}] [dedup-cached] {cached.summary}",
                    )
                )
                last_action_str = f"{action_name}({_truncate_args(args)})"
                last_result_str = f"[cached] {cached.summary}"
                if self.quality is not None:
                    self.quality.on_success()
                continue
            # Quality monitor
            if self.quality is not None:
                steer = self.quality.check(action_obj, self.registry)
                if steer:
                    quality_steer = steer
                    continue
            # Quality ok
            if self.quality is not None:
                self.quality.record(action_obj)
                self.quality.on_success()
            quality_steer = None
            # Special-case finish / i_dont_know
            if action_name == "finish":
                finish_summary = args.get("summary", "")
                evidence = args.get("evidence", "")
                if not _evidence_is_concrete(evidence):
                    retry_count += 1
                    if retry_count >= 2:
                        result.finished_by = "i_dont_know"
                        result.error = (
                            "finish rejected: evidence not concrete after 2 retries"
                        )
                        break
                    last_result_str = (
                        f"finish rejected: 'evidence' must be a real artifact "
                        f"(test that passed, file changed, command output). "
                        f"Your evidence was: {evidence[:200]!r}. Try again with concrete evidence."
                    )
                    continue
                # v0.8: lifecycle gate. The harness refuses to allow a
                # finish if the ledger says the run is not in a state
                # that proves completion. The agent is steered to do
                # the missing work instead of being told "done".
                if self.lifecycle is not None:
                    allowed, reason = self.lifecycle.feed_finish_attempt(evidence)
                    if not allowed:
                        retry_count += 1
                        if retry_count >= 2:
                            result.finished_by = "i_dont_know"
                            result.error = f"finish rejected: {reason}"
                            try:
                                self.lifecycle.feed_idk(result.error)
                                self.lifecycle.finalize(
                                    success=False,
                                    reason=result.error,
                                    confidence="low",
                                )
                            except Exception:
                                pass
                            break
                        last_result_str = (
                            f"finish rejected by lifecycle: {reason}. "
                            f"Address the missing evidence and try again."
                        )
                        continue
                step = Step(
                    action="finish", args=args, summary=finish_summary, success=True
                )
                self.memory.record(step)
                self._update_plan_status("finish")
                result.steps.append(
                    {
                        "step": step_num,
                        "action": "finish",
                        "args": args,
                        "summary": finish_summary,
                        "success": True,
                    }
                )
                result.success = True
                result.summary = finish_summary
                result.finished_by = "finish"
                self._emit(
                    LoopEvent(
                        kind="finish",
                        step_num=step_num,
                        action="finish",
                        args=args,
                        result_summary=finish_summary,
                        success=True,
                        message=f"finish: {finish_summary}",
                    )
                )
                break
            if action_name == "i_dont_know":
                reason = args.get("reason", "")
                step = Step(
                    action="i_dont_know", args=args, summary=reason, success=False
                )
                self.memory.record(step)
                result.steps.append(
                    {
                        "step": step_num,
                        "action": "i_dont_know",
                        "args": args,
                        "summary": reason,
                        "success": False,
                    }
                )
                result.finished_by = "i_dont_know"
                result.error = reason
                # v0.8: feed the lifecycle so the ledger records the
                # honest give-up and the watchdog resets.
                if self.lifecycle is not None:
                    try:
                        self.lifecycle.feed_idk(reason)
                        self.lifecycle.finalize(
                            success=False,
                            reason=reason or "i_dont_know",
                            confidence="low",
                        )
                    except Exception:
                        pass
                self._emit(
                    LoopEvent(
                        kind="finish",
                        step_num=step_num,
                        action="i_dont_know",
                        args=args,
                        result_summary=reason,
                        success=False,
                        message=f"i_dont_know: {reason}",
                    )
                )
                break
            # Reset retry counter when action changes
            if action_name != last_action_name:
                retry_count = 0
                last_action_name = action_name
            # v0.9: anti-stall gating. If the action is banned by the
            # anti-stall controller, refuse to dispatch and surface a
            # steering message instead. The loop stays bounded: it
            # does not retry the same banned action, it asks the
            # model to try something genuinely different.
            if self.anti_stall is not None:
                try:
                    allowed, reason = self.anti_stall.is_action_allowed(
                        action_name, args or {}
                    )
                    if not allowed:
                        retry_count += 1
                        if retry_count >= 2:
                            result.finished_by = "i_dont_know"
                            result.error = (
                                f"anti-stall banned action {action_name}: {reason}"
                            )
                            try:
                                if self.lifecycle is not None:
                                    self.lifecycle.feed_idk(result.error)
                                    self.lifecycle.finalize(
                                        success=False,
                                        reason=result.error,
                                        confidence="low",
                                    )
                            except Exception:
                                pass
                            break
                        last_result_str = (
                            f"anti-stall rejected {action_name}({_truncate_args(args)}): {reason}. "
                            f"Try a different action. Banned actions are listed in the recovery capsule."
                        )
                        quality_steer = (
                            f"[ANTI-STALL] {last_result_str}"
                        )
                        continue
                except Exception:
                    pass
            # Run the tool
            tr = self._run_tool(action_name, args)
            self._record_tool_budget(tr)
            # v0.8: feed the lifecycle controller with the result so
            # the watchdog / ledger observe the step.
            if self.lifecycle is not None:
                try:
                    self.lifecycle.feed_tool_result(action_name, args, tr)
                except Exception:
                    pass
            # Cache for read-only
            self.dedup.store(action_name, args, tr)
            # Bump memory use_count for memory_recall hits
            if (
                action_name == "memory_recall"
                and self.memory_store is not None
                and tr.success
            ):
                for mem_id in tr.memory_cards or []:
                    try:
                        self.memory_store.touch(mem_id)
                    except Exception:
                        pass
            # v0.7: emit per-tool traces
            if action_name == "run_command":
                self._trace(
                    "command_run",
                    {
                        "cmd": str(args.get("cmd", ""))[:200],
                        "returncode": tr.success and 0 or -1,
                        "summary": tr.summary,
                        "elapsed": round(tr.elapsed, 2),
                    },
                )
            elif action_name in ("edit_file", "create_file", "apply_patch"):
                self._trace(
                    "diff_generated",
                    {
                        "path": str(args.get("path", "")),
                        "old": str(args.get("old", ""))[:200],
                        "new": str(args.get("new", args.get("content", "")))[:200],
                        "lines": (
                            len(str(args.get("old", "")))
                            + len(str(args.get("new", args.get("content", ""))))
                        )
                        // 40,
                    },
                )
            # Update plan step status: mark relevant step as in_progress / done
            self._update_plan_status(action_name)
            step = Step(
                action=action_name,
                args=args,
                summary=tr.summary,
                success=tr.success,
                error=tr.error,
                elapsed=tr.elapsed,
            )
            step.files_read = tr.files_read
            step.files_written = tr.files_written
            step.commands_run = tr.commands_run
            step.memory_cards = tr.memory_cards
            self.memory.record(step)
            result.steps.append(
                {
                    "step": step_num,
                    "action": action_name,
                    "args": args,
                    "summary": tr.summary,
                    "success": tr.success,
                    "elapsed": round(tr.elapsed, 2),
                }
            )
            self._emit(
                LoopEvent(
                    kind="step",
                    step_num=step_num,
                    action=action_name,
                    args=args,
                    result_summary=tr.summary,
                    success=tr.success,
                    message=f"[{step_num}/{self.max_steps}] {tr.summary}",
                    elapsed=tr.elapsed,
                )
            )
            # Track for next prompt
            last_action_str = f"{action_name}({_truncate_args(args)})"
            if tr.success:
                last_result_str = tr.summary
                retry_count = 0
                # If we used the budget, emit a budget event
                self._emit(
                    LoopEvent(
                        kind="budget",
                        step_num=step_num,
                        message=f"budget: {self.budget.usage_summary()}",
                        extra=self.budget.to_dict(),
                    )
                )
            else:
                retry_count += 1
                last_result_str = f"FAILED: {tr.summary} (error: {tr.error[:200]})"
                if retry_count >= 2:
                    last_result_str += (
                        "\nYou have retried this action 2 times. "
                        "If you cannot make progress, use i_dont_know with a reason. "
                        "If you need clarification, use ask_user."
                    )
            # v0.9: anti-stall assessment. After each step, ask the
            # anti-stall controller if it wants to escalate. The
            # controller returns a RecoveryAction or None. If the
            # ladder has reached HONEST_BLOCKED, we end the loop
            # with a blocked report instead of letting the model
            # spin further.
            if self.anti_stall is not None:
                try:
                    recovery_action = self.anti_stall.on_stall()
                    if recovery_action is not None:
                        level = recovery_action.level.value
                        # Surface the recovery as a steer into the
                        # next prompt so the model knows what to do.
                        if recovery_action.level.value >= 6:  # HONEST_BLOCKED
                            result.finished_by = "blocked"
                            result.error = recovery_action.description
                            try:
                                if self.lifecycle is not None:
                                    self.lifecycle.feed_idk(result.error)
                                    self.lifecycle.finalize(
                                        success=False,
                                        reason=result.error,
                                        confidence="low",
                                    )
                            except Exception:
                                pass
                            self._emit(
                                LoopEvent(
                                    kind="finish",
                                    step_num=step_num,
                                    action="blocked",
                                    args={},
                                    result_summary=recovery_action.description,
                                    success=False,
                                    message=f"anti-stall blocked: {recovery_action.description}",
                                )
                            )
                            break
                        # Otherwise, steer the next prompt. We add
                        # the recovery hint to last_result_str.
                        if level >= 3:  # FRESH_WORKER and above
                            capsule_text = ""
                            try:
                                capsule_text = self.anti_stall.render_capsule()
                            except Exception:
                                pass
                            quality_steer = (
                                f"[ANTI-STALL LEVEL {level}: {recovery_action.name}] "
                                f"{recovery_action.description}\n{capsule_text}"
                            )
                        else:
                            quality_steer = (
                                f"[ANTI-STALL LEVEL {level}: {recovery_action.name}] "
                                f"{recovery_action.description}"
                            )
                except Exception:
                    pass
        else:
            result.finished_by = "max_steps"
            result.error = f"reached max_steps={self.max_steps} without finishing"
        result.elapsed = time.time() - start
        result.working_memory = self.memory.to_dict()
        result.budget = self.budget.to_dict()
        # v0.8: lifecycle finalisation. The controller owns the
        # final ledger entry, the robustness score, and the stuck
        # assessment. Failures here never break the run.
        if self.lifecycle is not None:
            try:
                if not result.success and result.finished_by != "i_dont_know":
                    # The loop did not finish cleanly (max_steps, error,
                    # or finish-rejected-by-lifecycle). Reflect that in
                    # the ledger so the user can see why.
                    self.lifecycle.finalize(
                        success=False,
                        reason=result.error or result.finished_by or "no success",
                        confidence="low",
                    )
                elif result.success and result.finished_by == "finish":
                    # The loop finished; the controller already accepted
                    # the finish attempt. We still need a finalize
                    # call so the ledger is closed and the watchdog's
                    # last_finish tracker is reset.
                    self.lifecycle.finalize(
                        success=True,
                        reason=result.summary or "finish accepted",
                        confidence="medium",
                    )
                stuck = self.lifecycle.watchdog.assess()
                report = self.lifecycle.score()
                result.ledger = self.lifecycle.ledger.to_dict()
                result.robustness = report.to_dict()
                result.stuck = stuck.to_dict()
                result.playbook = self.lifecycle.playbook.kind.value
                # v0.9: anti-stall outcome. Only emit if the
                # lifecycle controller has one attached; otherwise
                # the standalone anti_stall path below covers it.
                if self.anti_stall is not None and self.anti_stall is getattr(self.lifecycle, "anti_stall", None):
                    try:
                        result.anti_stall = self.anti_stall.outcome().to_dict()
                    except Exception:
                        pass
            except Exception:
                pass
        # v0.9: anti-stall outcome (standalone path: anti-stall
        # was attached but no lifecycle controller was). Always
        # best-effort.
        if result.anti_stall is None and self.anti_stall is not None:
            try:
                result.anti_stall = self.anti_stall.outcome().to_dict()
            except Exception:
                pass
        # v0.7: emit run_finished trace
        self._trace(
            "run_finished",
            {
                "success": bool(result.success),
                "finished_by": result.finished_by,
                "elapsed": round(result.elapsed, 2),
                "steps": len(result.steps),
                "error": (result.error or "")[:300],
            },
        )
        return result

    # ---- internals ----

    def _has_model(self) -> bool:
        if self.provider is None:
            return False

        return not (
            hasattr(self.provider, "chat")
            and getattr(self.provider, "name", "") == "none"
        )

    def _update_plan_status(self, action_name: str) -> None:
        """Mark a plan step as done based on the action taken.

        Each tool action corresponds to one plan step. The action marks the
        first pending step as done. A finish / i_dont_know marks all remaining
        as done. (The step in_progress is mainly for display.)
        """
        if not self.todo_anchoring or not self._plan_step_status:
            return
        if action_name in ("finish", "i_dont_know"):
            for i, status in enumerate(self._plan_step_status):
                if status != "done":
                    self._plan_step_status[i] = "done"
            return
        # First promote any in_progress to done (the previous action completed it)
        for i, status in enumerate(self._plan_step_status):
            if status == "in_progress":
                self._plan_step_status[i] = "done"
                break
        # Then mark the next pending as in_progress
        for i, status in enumerate(self._plan_step_status):
            if status == "pending":
                self._plan_step_status[i] = "in_progress"
                break

    def _plan_status_block(self) -> str:
        """Render the plan + step status for re-anchoring."""
        if not self.todo_anchoring or not self._plan_step_status:
            return ""
        lines = ["PLAN PROGRESS:"]
        for i, (step, status) in enumerate(
            zip(self.memory.plan, self._plan_step_status), start=1
        ):
            mark = {"pending": "[ ]", "in_progress": "[~]", "done": "[x]"}.get(
                status, "[ ]"
            )
            lines.append(f"  {mark} {i}. {step}")
        done = sum(1 for s in self._plan_step_status if s == "done")
        total = len(self._plan_step_status)
        lines.append(f"  Progress: {done}/{total}")
        return "\n".join(lines)

    def _plan(self, task: str) -> list[str]:
        prompt = PLAN_PROMPT.format(task=task, repo_root=self.repo_root)
        msgs = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ]
        text = self._chat(msgs, max_tokens=400, temperature=0.2)
        parsed, _err = parse_json_loose(text)
        if not isinstance(parsed, dict) or not isinstance(parsed.get("plan"), list):
            raise ValueError(
                f"plan response was not a valid plan object: {text[:200]!r}"
            )
        return [str(s) for s in parsed["plan"]][:10]

    def _next_action(
        self,
        *,
        task: str,
        plan: list[str],
        last_action: str,
        last_result: str,
        quality_steer: str | None,
        category_hint: str | None,
        step_num: int = 1,
    ) -> tuple[dict | None, str]:
        # Build tool schemas. Either 2-stage (categories only) or full.
        if self.two_stage and category_hint is None:
            tool_schemas = [{"available_categories": self.registry.categories()}]
            tools_intro = (
                "STEP 1: Pick a category. Valid categories:\n"
                + "\n".join(f"  - {c}" for c in self.registry.categories())
                + '\n\nOutput: {"category": "<one of the above>"}'
            )
        else:
            cat = category_hint or "read"
            tool_schemas = self.registry.descriptions_for_category(cat)
            cat_tools = self.registry.tools_in_category(cat)
            tools_intro = (
                f"STEP 2: You picked category '{cat}'. "
                f"Available tools in this category:\n"
                + "\n".join(f"  - {t.name}: {t.description}" for t in cat_tools)
                + '\n\nOutput: {"action": "<tool_name>", "args": {...}}'
            )
        # Add budget info
        budget_info = (
            f"\nCONTEXT BUDGET: {self.budget.usage_summary()}. "
            f"If approaching the limit, prefer concise actions and i_dont_know."
        )
        # Build the prompt
        plan_anchor = self._plan_status_block() if self.todo_anchoring else ""
        steer = f"\n\n{quality_steer}" if quality_steer else ""
        evicted = self.budget.evicted_summaries()
        evicted_block = ""
        if evicted:
            evicted_block = (
                "\nEVICTED FROM CONTEXT (one-line summaries):\n"
                + "\n".join(f"  - {s}" for s in evicted[-5:])
            )
        # v0.5: agent-curated memory — surface the most relevant memories
        # at the start of the prompt, and the nudge at session start.
        memory_block = ""
        nudge_block = ""
        if self.memory_store is not None:
            from cheater.memory_nudges import format_session_start_nudge

            try:
                memory_block = self.memory_store.for_prompt(
                    top_k=self.memory_top_k,
                    query=task,
                )
            except Exception:
                memory_block = ""
            # Only show the session-start nudge on the first turn
            if step_num == 1:
                try:
                    nudge_block = format_session_start_nudge(self.memory_store)
                except Exception:
                    nudge_block = ""
        # v0.6: small-model harness nudge + a small repo-map excerpt.
        harness_block = ""
        if step_num == 1:
            try:
                from cheater.repo_map import select_relevant_map

                if self._repo_map is not None and not self._repo_map_excerpt:
                    self._repo_map_excerpt = select_relevant_map(
                        self._repo_map,
                        query=task,
                        traceback="",
                        top_k=6,
                    )
                if self._repo_map_excerpt:
                    harness_block = (
                        self._harness_nudge
                        + "\nREPO MAP (relevant slice):\n"
                        + self._repo_map_excerpt
                    )
                else:
                    harness_block = self._harness_nudge
            except Exception:
                harness_block = self._harness_nudge
        prompt = (
            f"TASK: {task}\n\n"
            + (f"{harness_block}\n" if harness_block else "")
            + "PLAN:\n"
            + "\n".join(f"  {i + 1}. {p}" for i, p in enumerate(plan))
            + "\n"
            + (f"\n{plan_anchor}\n" if plan_anchor else "")
            + (f"\n{memory_block}\n" if memory_block else "")
            + f"\nWORKING MEMORY:\n{self.memory.to_prompt()}"
            + f"\n{evicted_block}"
            + f"\n\nLAST ACTION: {last_action}"
            + f"\nLAST RESULT: {last_result}"
            + budget_info
            + (f"\n\n{nudge_block}" if nudge_block else "")
            + steer
            + f"\n\n{tools_intro}\n"
            + "\nExamples:\n"
            + '  {"action": "read_file", "args": {"path": "cheater/quality.py"}}\n'
            + '  {"action": "run_command", "args": {"cmd": "pytest tests/test_x.py -x -q"}}\n'
            + '  {"action": "edit_file", "args": {"path": "x.py", "old": "a", "new": "b"}}\n'
            + '  {"action": "finish", "args": {"summary": "...", "evidence": "tests/test_x.py passed"}}\n'
            + '  {"action": "i_dont_know", "args": {"reason": "..."}}\n'
        )
        # v0.7: inject tool policy nudge (small, capped) on every turn
        try:
            policy_nudge = self._tool_policy_nudge(task)
            if policy_nudge:
                prompt = policy_nudge + "\n\n" + prompt
        except Exception:
            pass
        msgs = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ]
        # v0.7: trace the model prompt (excerpt + tokens estimate, never full text)
        try:
            self._trace(
                "model_prompt",
                {
                    "step_num": step_num,
                    "tokens_est": max(1, len(prompt) // 4),
                },
            )
        except Exception:
            pass
        # Adaptive retry temperature
        attempt = 0
        text = ""
        while attempt < 2:
            try:
                text = self._chat(
                    msgs, max_tokens=300, temperature=self._temp_for_attempt(attempt)
                )
            except _ModelUnavailable:
                raise
            parsed = _parse_action(text)
            if parsed is not None:
                return parsed, text
            # Try a retry with repair
            attempt += 1
            if attempt >= 2:
                raise _InvalidJSONAfterRetry(text[:200])
            # One retry with the error message
            try:
                repaired = (
                    repair_json(text)
                    if text and text.strip().startswith(("{", "["))
                    else text
                )
                parsed_repair = parse_json_loose(repaired)
            except Exception:
                parsed_repair = (None, "parse error")
            if parsed_repair and isinstance(parsed_repair[0], dict):
                return parsed_repair[0], text
            retry_prompt = (
                f"Your previous output was not parseable as a JSON tool call.\n"
                f"Error: {parsed_repair[1] if isinstance(parsed_repair, tuple) else 'unknown'}\n"
                f"Previous output (truncated): {text[:300]!r}\n"
                f"\nTASK: {task}\nLAST VALID ACTION: {last_action}\nLAST VALID RESULT: {last_result}\n"
                f"WORKING MEMORY: {self.memory.to_prompt()}\n"
                f"{tools_intro}\n"
                "Output a single valid JSON object. No markdown, no code fences, no prose."
            )
            msgs2 = [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": retry_prompt},
            ]
            try:
                text = self._chat(
                    msgs2, max_tokens=300, temperature=self._temp_for_attempt(attempt)
                )
            except _ModelUnavailable:
                raise
            parsed2 = _parse_action(text)
            if parsed2 is not None:
                return parsed2, text
        raise _InvalidJSONAfterRetry(text[:200])

    def _temp_for_attempt(self, attempt: int) -> float:
        """Adaptive retry temperature: lower for first retry, higher for second."""
        base = 0.1
        delta = RETRY_TEMPERATURE_SCHEDULE[
            min(attempt, len(RETRY_TEMPERATURE_SCHEDULE) - 1)
        ]
        return max(0.0, min(1.0, base + delta))

    def _run_tool(self, name: str, args: dict) -> Any:
        ctx = ToolContext(
            repo_root=self.repo_root,
            cards=self._cards,
            runner=self._runner_run,
            memory_search=self._memory_search,
            memory_store=self.memory_store,
            provider=self.provider,
            read_only=self.read_only,
            ask_user=lambda q: self._safe_ask_user(q),
        )
        return self.registry.run(name, args, ctx)

    def _record_tool_budget(self, tr: Any) -> None:
        """Account for tool output so context pressure triggers compaction."""
        try:
            parts = [str(getattr(tr, "summary", "") or "")]
            output = str(getattr(tr, "output", "") or "")
            error = str(getattr(tr, "error", "") or "")
            if output:
                parts.append(output)
            if error:
                parts.append(f"ERROR: {error}")
            self.budget.allocate("tool", "\n".join(p for p in parts if p))
        except Exception:
            pass

    def _maybe_compact_context(self, *, step_num: int, reason: str) -> None:
        """Compact old working-memory steps before the provider loses the thread."""
        if not self.auto_compact_context:
            return
        over_budget = self.budget.usage_pct >= (self.context_compact_ratio * 100.0)
        too_many_steps = len(self.memory.steps) > self.compact_keep_last * 2
        prompt_too_large = len(self.memory.to_prompt()) >= int(
            self.memory.max_chars * self.context_compact_ratio
        )
        if not (over_budget or too_many_steps or prompt_too_large):
            return
        note = self.memory.compact_old_steps(
            keep_last=self.compact_keep_last,
            reason=reason,
        )
        if not note:
            return
        self.budget.allocate("memory", note)
        self._emit(
            LoopEvent(
                kind="budget",
                step_num=step_num,
                message=f"auto-compact: {note[:180]}",
                extra={"auto_compacted": True, **self.budget.to_dict()},
            )
        )

    def _fit_messages_to_context(self, messages: list[dict]) -> list[dict]:
        """Clamp an outgoing provider request below the effective context cap."""
        max_chars = self.max_context_tokens * 4
        threshold_chars = self.compact_threshold_tokens * 4
        total = sum(len(str(m.get("content", ""))) for m in messages)
        if total < threshold_chars:
            return messages
        if self.auto_compact_context:
            note = self.memory.compact_old_steps(
                keep_last=self.compact_keep_last,
                reason=f"provider request near {self.compact_threshold_tokens} token threshold",
            )
            if note:
                self.budget.allocate("memory", note)
                self._emit(
                    LoopEvent(
                        kind="budget",
                        message=f"auto-compact before provider request: {note[:180]}",
                        extra={
                            "auto_compacted": True,
                            "max_context_tokens": self.max_context_tokens,
                        },
                    )
                )
        total = sum(len(str(m.get("content", ""))) for m in messages)
        if total <= max_chars:
            return messages
        fitted = [dict(m) for m in messages]
        reserved = sum(len(str(m.get("content", ""))) for m in fitted[:-1])
        available = max(1000, max_chars - reserved - 500)
        last = dict(fitted[-1])
        content = str(last.get("content", ""))
        if len(content) > available:
            last["content"] = (
                "[Cheater truncated this prompt to stay under the hard context cap. "
                "Older repeated context was compacted or dropped.]\n\n"
                + content[-available:]
            )
            fitted[-1] = last
        return fitted

    def _safe_ask_user(self, question: str) -> str:
        try:
            return input(f"\n[cheater asks] {question}\n> ").strip()
        except (EOFError, KeyboardInterrupt):
            return ""

    def _chat(
        self, messages: list[dict], *, max_tokens: int, temperature: float
    ) -> str:
        from cheater.providers import ModelNotConfigured

        try:
            messages = self._fit_messages_to_context(messages)
            text = self.provider.chat(
                messages, max_tokens=max_tokens, temperature=temperature
            )
            try:
                self.budget.allocate("response", text)
            except Exception:
                pass
            return text
        except ModelNotConfigured as e:
            raise _ModelUnavailable(str(e))
        except Exception as e:
            return f"<<provider error: {type(e).__name__}: {e}>>"


class _ModelUnavailable(Exception):
    pass


class _InvalidJSONAfterRetry(Exception):
    pass


def _parse_action(text: str) -> dict | None:
    """Parse a model response into an action dict using the forgiving parser."""
    parsed, _err = parse_tool_call(text)
    return parsed if isinstance(parsed, dict) else None


def _truncate_args(args: dict) -> str:
    parts: list[str] = []
    for k, v in (args or {}).items():
        s = repr(v)
        if len(s) > 60:
            s = s[:57] + "..."
        parts.append(f"{k}={s}")
    return ", ".join(parts)


def _truncate_args_dict(args: dict, max_str: int = 80) -> dict:
    """Return a copy of args with long string values clipped. Used for
    trace payloads to keep the JSONL small.
    """
    out: dict = {}
    for k, v in (args or {}).items():
        if isinstance(v, str):
            out[k] = v[:max_str] + ("..." if len(v) > max_str else "")
        elif isinstance(v, dict):
            out[k] = _truncate_args_dict(v, max_str)
        elif isinstance(v, list):
            out[k] = [
                (x[:max_str] + "...") if isinstance(x, str) and len(x) > max_str else x
                for x in v[:10]
            ]
        else:
            out[k] = v
    return out


def _evidence_is_concrete(evidence: str) -> bool:
    if not isinstance(evidence, str) or len(evidence.strip()) < 5:
        return False
    e = evidence.strip().lower()
    if "test_" in e or "::" in e:
        return True
    if "/" in e and (
        e.endswith(".py")
        or e.endswith(".md")
        or e.endswith(".txt")
        or e.endswith(".json")
        or e.endswith(".toml")
        or e.endswith(".yaml")
        or e.endswith(".yml")
    ):
        return True
    if re.search(r"[a-z_/.-]+\.(py|md|txt|json|toml|yaml|yml|sh|js|ts|tsx|jsx)\b", e):
        return True
    if "pytest" in e or "ruff" in e or "mypy" in e:
        return True
    if "passed" in e or "exit" in e or "0 fail" in e:
        return True
    return False

"""Cheater agent loop.

The minimal real agent loop:
  1. observe   -- parse user task
  2. plan      -- build a plan (deterministic if no model)
  3. explore   -- call cheater.explorer for repo context
  4. retrieve  -- call cheater.memory for memory hits
  5. propose   -- if model configured, ask for a patch draft
  6. patch     -- preview + apply
  7. test      -- run approved commands
  8. reflect   -- summarize failure
  9. summarize -- final summary + save session

Always works without a model. With a model, gets smarter.

Public API:
  Agent(config)             -- an agent bound to a config
  agent.ask(task)           -- ask mode: read-only, returns Answer
  agent.plan(task)          -- plan mode: produces a Plan
  agent.build(task)         -- build mode: produces PatchProposal
  agent.review()            -- review mode: review git diff
  agent.run_loop(task)      -- full agent loop (used by build mode)

Answers, Plans, PatchProposals are returned as dataclasses.
"""
from __future__ import annotations

import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from cheater.config import CheaterConfig
from cheater.explorer import explore
from cheater.memory import (
    MemoryHit,
    format_brief,
    load_cards_for_memory,
    memory_search,
)
from cheater.providers import (
    ModelNotConfigured,
    ProviderConfig,
    get_provider,
)


@dataclass
class Answer:
    """Result of ask mode."""
    task: str
    explorer: dict[str, Any] = field(default_factory=dict)
    memory_brief: str = ""
    plan: str = ""
    final: str = ""
    mode: str = "ask"


@dataclass
class Plan:
    """Result of plan mode."""
    task: str
    steps: list[str] = field(default_factory=list)
    files_to_inspect: list[str] = field(default_factory=list)
    tests_to_run: list[str] = field(default_factory=list)
    memory_brief: str = ""
    repo_context: dict[str, Any] = field(default_factory=dict)


@dataclass
class BuildResult:
    """Result of build mode (may include a proposed patch)."""
    task: str
    plan: Plan
    proposed_patch: str | None = None  # unified diff text
    applied: bool = False
    snapshot_id: str | None = None
    command_results: list[dict[str, Any]] = field(default_factory=list)
    summary: str = ""


@dataclass
class ReviewResult:
    """Result of review mode."""
    diff: str = ""
    files: list[str] = field(default_factory=list)
    memory_brief: str = ""
    suggestions: list[str] = field(default_factory=list)
    summary: str = ""


def _provider_from_config(cfg: CheaterConfig) -> Any:
    """Build a provider from CheaterConfig."""
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
    return get_provider(pc)


def _git_diff(repo_root: Path) -> tuple[str, list[str]]:
    """Get current git diff (vs HEAD). Returns (unified_diff, files)."""
    try:
        out = subprocess.run(
            ["git", "diff", "HEAD"],
            cwd=str(repo_root),
            capture_output=True,
            text=True,
            timeout=10,
        )
        diff = out.stdout or ""
        files_out = subprocess.run(
            ["git", "diff", "--name-only", "HEAD"],
            cwd=str(repo_root),
            capture_output=True,
            text=True,
            timeout=10,
        )
        files = [
            line.strip()
            for line in (files_out.stdout or "").splitlines()
            if line.strip()
        ]
        return diff, files
    except (OSError, subprocess.TimeoutExpired, FileNotFoundError):
        return "", []


def _build_memory_brief(
    task: str,
    cards: list[dict[str, Any]],
    cfg: CheaterConfig,
    *,
    language: str | None = None,
) -> tuple[str, list[MemoryHit]]:
    """Build a memory brief and return (text, hits)."""
    hits = memory_search(
        task, cards,
        mode=cfg.memory.mode,
        language=language,
        top_k_override=cfg.memory.top_k,
    )
    if not hits:
        return "(no memory hits)", []
    brief = format_brief(hits, task)
    return brief, hits


def _build_plan(task: str, explorer: dict[str, Any], memory_brief: str) -> Plan:
    """Deterministic plan from task + explorer + memory."""
    plan = Plan(task=task, memory_brief=memory_brief, repo_context=explorer)
    # 1. Inspect repo top files
    for tf in (explorer.get("top_files") or [])[:5]:
        plan.files_to_inspect.append(tf.get("path", ""))
    # 2. Test files
    for tf in (explorer.get("test_files") or [])[:3]:
        plan.tests_to_run.append(f"pytest {tf}")
    # 3. Steps
    plan.steps = []
    plan.steps.append(f"1. Read the task: {task[:100]}")
    if explorer.get("top_files"):
        plan.steps.append("2. Inspect repo files most likely related:")
        for tf in (explorer.get("top_files") or [])[:3]:
            plan.steps.append(f"   - {tf.get('path', '?')}")
    if memory_brief and memory_brief != "(no memory hits)":
        plan.steps.append("3. Compare memory brief to repo (analogies, not templates)")
    if explorer.get("test_files"):
        plan.steps.append("4. Run tests to confirm the bug reproduces:")
        for t in (explorer.get("test_files") or [])[:2]:
            plan.steps.append(f"   - pytest {t}")
    plan.steps.append("5. Identify the minimal change")
    plan.steps.append("6. Apply patch with cheater (preview before apply)")
    plan.steps.append("7. Re-run tests to confirm")
    return plan


def _maybe_ask_provider(provider: Any, system: str, user: str, max_tokens: int = 600) -> str | None:
    """Call provider if configured. Returns text or None on no-model."""
    try:
        return provider.chat([
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ], max_tokens=max_tokens)
    except ModelNotConfigured:
        return None
    except Exception as e:
        return f"(provider error: {type(e).__name__}: {str(e)[:200]})"


class Agent:
    """A Cheater agent bound to a config and a project root."""

    def __init__(self, cfg: CheaterConfig, project_root: str | Path | None = None) -> None:
        self.cfg = cfg
        self.root = Path(project_root or cfg.project_root or Path.cwd()).resolve()
        self.provider = _provider_from_config(cfg)
        self.cards: list[dict[str, Any]] = []
        self._load_cards()

    def _load_cards(self) -> None:
        # Choose corpus: full if it exists, else sample
        full = self.root / self.cfg.cards_path
        sample = self.root / self.cfg.sample_cards_path
        if full.is_file():
            self.cards = load_cards_for_memory(full)
        elif sample.is_file():
            self.cards = load_cards_for_memory(sample)
        else:
            self.cards = []

    def ask(self, task: str) -> Answer:
        """Read-only answer to a question."""
        ans = Answer(task=task, mode="ask")
        ex = explore(task, repo_root=self.root, max_files=300)
        ans.explorer = ex.to_dict()
        brief, _ = _build_memory_brief(task, self.cards, self.cfg)
        ans.memory_brief = brief
        plan = _build_plan(task, ans.explorer, brief)
        ans.plan = "\n".join(plan.steps)
        # Try the provider
        ctx = _format_ask_context(ans, plan)
        prompt = (
            f"Task: {task}\n\n"
            f"Repo context (top files / symbols):\n{ctx['explorer']}\n\n"
            f"Memory brief:\n{ctx['memory']}\n\n"
            f"Plan:\n{ctx['plan']}\n\n"
            "Answer the task concisely. Ground each claim in the memory brief (cite card IDs) "
            "or in the repo files (cite paths). If unsure, say so."
        )
        response = _maybe_ask_provider(
            self.provider,
            "You are Cheater, a careful coding assistant. Be concise and grounded.",
            prompt,
            max_tokens=self.cfg.provider.max_tokens,
        )
        if response is None:
            ans.final = _deterministic_ask(ans, plan)
        else:
            ans.final = response
        return ans

    def plan(self, task: str) -> Plan:
        """Produce a plan without making changes."""
        ex = explore(task, repo_root=self.root, max_files=300)
        brief, _ = _build_memory_brief(task, self.cards, self.cfg)
        p = _build_plan(task, ex.to_dict(), brief)
        return p

    def review(self) -> ReviewResult:
        """Review the current git diff and suggest improvements."""
        diff, files = _git_diff(self.root)
        rr = ReviewResult(diff=diff, files=files)
        if not diff.strip():
            rr.summary = "No git diff (working tree is clean). Nothing to review."
            return rr
        # Build a memory brief keyed off the diff content
        task = "Review the following changes and suggest likely bugs or improvements"
        brief, _ = _build_memory_brief(task, self.cards, self.cfg)
        rr.memory_brief = brief
        rr.suggestions = _review_suggestions(diff, files)
        rr.summary = "\n".join(rr.suggestions) if rr.suggestions else "No specific suggestions."
        return rr

    def build(self, task: str, *, dry_run: bool = False) -> BuildResult:
        """Build mode: explore, retrieve, propose a patch, optionally apply, run tests."""
        ex = explore(task, repo_root=self.root, max_files=300)
        brief, _ = _build_memory_brief(task, self.cards, self.cfg)
        p = _build_plan(task, ex.to_dict(), brief)
        br = BuildResult(task=task, plan=p)
        # Try to propose a patch via the model
        prompt = _build_patch_prompt(task, ex.to_dict(), brief, p)
        response = _maybe_ask_provider(
            self.provider,
            "You are Cheater, a careful coding assistant. Propose minimal unified-diff patches. "
            "If you are not sure, output a one-line explanation instead of a diff.",
            prompt,
            max_tokens=self.cfg.provider.max_tokens,
        )
        if response is None or not response.strip():
            br.proposed_patch = None
            br.summary = (
                "No model configured. Cheater produced a plan and memory brief. "
                "To enable patch drafting, configure a model via `cheater init` or set "
                "CHEATER_PROVIDER / CHEATER_MODEL / CHEATER_BASE_URL."
            )
            return br
        # Try to extract a unified diff from the response
        diff = _extract_diff(response)
        if not diff:
            br.proposed_patch = response  # show full response as advice
            br.summary = "Model responded with advice but no unified diff."
            return br
        br.proposed_patch = diff
        if dry_run:
            br.summary = "Dry run; patch not applied."
            return br
        # We do NOT auto-apply. Caller (CLI / TUI) should call apply_patch with confirmation.
        br.summary = "Patch proposed. Use the patch engine to preview and apply."
        return br


def _format_ask_context(ans: Answer, plan: Plan) -> dict[str, str]:
    """Compress answer/plan into strings for the provider prompt."""
    ex = ans.explorer
    top_files = "\n".join(f"  - {tf.get('path', '?')}" for tf in (ex.get("top_files") or [])[:10])
    symbols = "\n".join(
        f"  - {s.get('name')} @ {s.get('file')}:{s.get('line')}"
        for s in (ex.get("symbols") or [])[:10]
    )
    explorer_text = f"top files:\n{top_files or '  (none)'}\n\nsymbols:\n{symbols or '  (none)'}"
    return {
        "explorer": explorer_text,
        "memory": ans.memory_brief,
        "plan": ans.plan,
    }


def _deterministic_ask(ans: Answer, plan: Plan) -> str:
    """Deterministic fallback when no model is configured."""
    parts: list[str] = []
    parts.append("Cheater answer (no model configured):\n")
    parts.append(plan.plan if hasattr(plan, "plan") else "\n".join(plan.steps))
    parts.append("\n--- Memory brief ---")
    parts.append(ans.memory_brief)
    if ans.explorer.get("top_files"):
        parts.append("\n--- Repo files to inspect ---")
        for tf in ans.explorer["top_files"][:5]:
            parts.append(f"  - {tf.get('path', '?')}")
    parts.append("\n--- Next steps ---")
    parts.append("Configure a model with `cheater init` to enable natural-language answers.")
    return "\n".join(parts)


def _build_patch_prompt(
    task: str, ex: dict[str, Any], brief: str, plan: Plan,
) -> str:
    top_files = "\n".join(f"  - {tf.get('path', '?')}" for tf in (ex.get("top_files") or [])[:10])
    symbols = "\n".join(
        f"  - {s.get('name')} @ {s.get('file')}:{s.get('line')}"
        for s in (ex.get("symbols") or [])[:10]
    )
    return (
        f"Task: {task}\n\n"
        f"Repo top files:\n{top_files or '  (none)'}\n\n"
        f"Repo symbols:\n{symbols or '  (none)'}\n\n"
        f"Memory brief:\n{brief}\n\n"
        f"Plan:\n" + "\n".join(plan.steps) + "\n\n"
        "Propose a MINIMAL unified-diff patch (--- a/path, +++ b/path, @@ ...) that fixes the bug. "
        "If you are not sure, output a one-line explanation. Do NOT propose large refactors."
    )


def _extract_diff(text: str) -> str | None:
    """Extract a unified diff from a model response, if present."""
    import re
    # Find first ```diff ... ``` block
    m = re.search(r"```(?:diff|patch)?\s*\n(.*?)```", text, re.DOTALL)
    if m:
        return m.group(1).strip()
    # Find first "--- a/" line and take from there
    m = re.search(r"^---\s+a/.*$", text, re.MULTILINE)
    if m:
        return text[m.start():].strip()
    return None


def _review_suggestions(diff: str, files: list[str]) -> list[str]:
    """Heuristic suggestions for a git diff."""
    out: list[str] = []
    if not diff:
        return out
    # Count added/removed lines
    added = sum(
        1 for line in diff.splitlines()
        if line.startswith("+") and not line.startswith("+++")
    )
    removed = sum(
        1 for line in diff.splitlines()
        if line.startswith("-") and not line.startswith("---")
    )
    if added > 200 or removed > 200:
        out.append(f"Large diff ({added} added, {removed} removed); consider splitting.")
    # Check for missing test changes
    has_test = any(("test" in f or "spec" in f) for f in files)
    if not has_test and (added > 10 or removed > 10):
        out.append("No test file in the diff; consider adding/updating tests.")
    # Check for debug prints
    if "print(" in diff or "console.log" in diff or "fmt.Println" in diff:
        out.append("Diff contains print/console.log/fmt.Println; remove before commit.")
    # Check for TODOs
    if "TODO" in diff or "FIXME" in diff:
        out.append("Diff contains TODO/FIXME; consider addressing now or filing an issue.")
    if not out:
        out.append("No heuristic issues found. Review memory brief for cross-project patterns.")
    return out

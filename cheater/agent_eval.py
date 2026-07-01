"""Agent-helpfulness benchmark: PLACEHOLDER DESIGN (not a runnable harness yet).

This module documents the future "does Cheater retrieval help a coding agent?"
evaluation. It is deliberately NOT wired into the smoke test or CI, because a
real agent eval requires an external coding-agent runtime (Pi/Qwen/etc.) that
the core memory-card pipeline must not depend on.

Future design (roadmap, not implemented in this pass):

  1. Define small reproducible bug tasks (a task = repo pinned at a failing
     commit + a failing test command + the expected patch).
  2. Run two arms:
       - baseline:    agent with NO Cheater retrieval.
       - cheater:     same agent WITH Cheater memory cards retrieved for the
                      task's symptom/error and injected as repair guidance.
  3. Compare pass rate (did the failing test go green?) across arms, using
     paired tasks and repeated trials for variance.
  4. Store per-task logs (prompt, retrieved memory ids+scores, agent diff,
     test stdout) under a run directory.
  5. Avoid benchmark contamination:
       - do NOT train/index cards on the evaluation bugs (use the existing
         contamination_filters to exclude same-repo/same-instance cards);
       - pin base_commit and refuse dirty repos;
       - keep evaluation artifacts outside the target git worktree.

The existing heavy agent scripts at repo root (run_eval.py, agent_harness.py,
benchmark_harness.py, qwen_local_agent.py, cheater_retry_controller.py) are
EXPERIMENTAL and are preserved as-is. They are out of scope for the minimal
core and are documented as quarantine/experimental in docs/STATE_OF_REPO.md.

This module exposes the BenchmarkRunner extension point only.
"""

from __future__ import annotations

from typing import Any

from cheater.errors import BenchmarkRunner


class AgentHelpfulnessRunner(BenchmarkRunner):
    """Future agent-helpfulness runner. Not implemented; raises if used."""

    def run(self, cases: list[dict[str, Any]]) -> dict[str, Any]:
        raise NotImplementedError(
            "Agent-helpfulness benchmark is a future roadmap item. "
            "Use `cheater benchmark` for the runnable retrieval-quality baseline. "
            "See docs/ARCHITECTURE.md and docs/ROADMAP.md."
        )

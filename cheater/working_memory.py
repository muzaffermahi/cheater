"""Working memory for the Cheater agent loop.

Tracks what the agent has done in this session. Serializes into a compact
form the model can include in its context. Bounded size: oldest items get
summarized when the memory grows past max_chars.

Public API:
  Step(action, args, summary, success, elapsed, error)  -- one step
  WorkingMemory(max_chars=6000)                          -- the memory
    .record(step)                                        -- add a step
    .set_files_read(paths) / set_files_written / set_commands / set_cards
    .to_prompt() -> str                                  -- for the model
    .to_dict() -> dict                                   -- for serialization
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field, asdict
from typing import Any


@dataclass
class Step:
    """One step in the agent loop."""
    action: str
    args: dict = field(default_factory=dict)
    summary: str = ""
    success: bool = True
    elapsed: float = 0.0
    error: str = ""
    ts: float = field(default_factory=time.time)

    def to_compact(self) -> dict[str, Any]:
        return {
            "action": self.action,
            "args": {k: (str(v)[:80] if not isinstance(v, (int, float, bool)) else v)
                     for k, v in self.args.items()},
            "success": self.success,
            "summary": self.summary[:200],
        }


@dataclass
class WorkingMemory:
    """Bounded working memory for the agent loop."""
    max_chars: int = 6000
    steps: list[Step] = field(default_factory=list)
    files_read: set[str] = field(default_factory=set)
    files_written: set[str] = field(default_factory=set)
    commands_run: list[str] = field(default_factory=list)
    memory_cards_seen: set[str] = field(default_factory=set)
    plan: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def record(self, step: Step) -> None:
        self.steps.append(step)
        # Auto-track
        for f in step.args.get("path", "").split() if isinstance(step.args.get("path"), str) else []:
            if step.action in ("read_file",) and f:
                self.files_read.add(f)
        fr = step.__dict__.get("files_read") or []
        for f in fr:
            self.files_read.add(f)
        fw = step.__dict__.get("files_written") or []
        for f in fw:
            self.files_written.add(f)
        for c in step.__dict__.get("commands_run") or []:
            self.commands_run.append(c)
        for cid in step.__dict__.get("memory_cards") or []:
            self.memory_cards_seen.add(cid)

    def add_note(self, note: str) -> None:
        if note and len(self.notes) < 20:
            self.notes.append(note)

    def set_plan(self, plan: list[str]) -> None:
        self.plan = list(plan)

    def _compact_steps(self) -> list[dict[str, Any]]:
        return [s.to_compact() for s in self.steps]

    def compact_old_steps(self, keep_last: int = 8, reason: str = "context pressure") -> str:
        """Summarize older steps into a note and keep only the recent tail."""
        keep_last = max(1, keep_last)
        if len(self.steps) <= keep_last:
            return ""
        old = self.steps[:-keep_last]
        self.steps = self.steps[-keep_last:]
        parts: list[str] = []
        for s in old:
            status = "ok" if s.success else "failed"
            args = s.args or {}
            path = args.get("path")
            cmd = args.get("cmd")
            target = f" {path}" if isinstance(path, str) and path else ""
            if isinstance(cmd, str) and cmd:
                target = f" `{cmd[:80]}`"
            summary = s.summary[:100] if s.summary else ""
            parts.append(f"{s.action}{target} {status}: {summary}".strip())
        note = f"Compacted {len(old)} older step(s) due to {reason}: " + " | ".join(parts)
        self.add_note(note[:1200])
        return note

    def to_prompt(self) -> str:
        """Render as a compact string for the model prompt."""
        out: list[str] = []
        if self.plan:
            out.append("PLAN:")
            for i, p in enumerate(self.plan, start=1):
                out.append(f"  {i}. {p}")
        if self.steps:
            out.append("")
            out.append("STEPS SO FAR (most recent last):")
            for s in self._compact_steps()[-15:]:  # last 15
                mark = "✓" if s["success"] else "✗"
                args_str = ", ".join(f"{k}={v!r}" for k, v in s["args"].items())[:120]
                out.append(f"  {mark} {s['action']}({args_str})")
                if s["summary"]:
                    out.append(f"      {s['summary']}")
        if self.files_read:
            out.append("")
            out.append(f"FILES READ: {', '.join(sorted(self.files_read))[:400]}")
        if self.files_written:
            out.append(f"FILES WRITTEN: {', '.join(sorted(self.files_written))[:400]}")
        if self.memory_cards_seen:
            out.append(f"MEMORY CARDS SEEN: {', '.join(sorted(self.memory_cards_seen))[:400]}")
        if self.notes:
            out.append("")
            out.append("NOTES:")
            for n in self.notes[-5:]:
                out.append(f"  - {n}")
        text = "\n".join(out)
        # If still too long, drop oldest steps
        while len(text) > self.max_chars and len(self.steps) > 3:
            self.compact_old_steps(keep_last=max(3, len(self.steps) - 1), reason="working-memory limit")
            text = self.to_prompt()
        return text

    def to_dict(self) -> dict[str, Any]:
        return {
            "max_chars": self.max_chars,
            "steps": [asdict(s) for s in self.steps],
            "files_read": sorted(self.files_read),
            "files_written": sorted(self.files_written),
            "commands_run": list(self.commands_run),
            "memory_cards_seen": sorted(self.memory_cards_seen),
            "plan": list(self.plan),
            "notes": list(self.notes),
        }

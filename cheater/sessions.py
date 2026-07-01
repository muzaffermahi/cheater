"""Cheater session storage.

Each session is a directory under .cheater/sessions/<id>/ with:
  - task.txt
  - mode.txt
  - model.json
  - explorer.json
  - memory.json
  - guide.md
  - plan.md
  - patch.diff
  - commands.jsonl
  - summary.md

Public API:
  Session(root)                        -- a session bound to a directory
  new_session(root_dir, task, mode)    -- create a new session
  list_sessions(root_dir)              -- list all session ids (newest first)
  load_session(root_dir, id)           -- load an existing session
  resume_session(root_dir, id)         -- alias
"""
from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


def _now_id() -> str:
    """Generate a sortable session id."""
    return f"{int(time.time())}-{uuid.uuid4().hex[:8]}"


@dataclass
class Session:
    """A single Cheater session."""
    root: Path
    id: str
    task: str = ""
    mode: str = "ask"
    model: dict[str, Any] = field(default_factory=dict)
    explorer: dict[str, Any] = field(default_factory=dict)
    memory: dict[str, Any] = field(default_factory=dict)
    guide: str = ""
    plan: str = ""
    patch_diff: str = ""
    commands: list[dict[str, Any]] = field(default_factory=list)
    summary: str = ""

    @property
    def path(self) -> Path:
        return self.root / self.id

    def _ensure(self) -> None:
        self.path.mkdir(parents=True, exist_ok=True)

    def save(self) -> None:
        self._ensure()
        (self.path / "task.txt").write_text(self.task, encoding="utf-8")
        (self.path / "mode.txt").write_text(self.mode, encoding="utf-8")
        (self.path / "model.json").write_text(json.dumps(self.model, indent=2), encoding="utf-8")
        (self.path / "explorer.json").write_text(json.dumps(self.explorer, indent=2), encoding="utf-8")
        (self.path / "memory.json").write_text(json.dumps(self.memory, indent=2), encoding="utf-8")
        (self.path / "guide.md").write_text(self.guide, encoding="utf-8")
        (self.path / "plan.md").write_text(self.plan, encoding="utf-8")
        (self.path / "patch.diff").write_text(self.patch_diff, encoding="utf-8")
        with (self.path / "commands.jsonl").open("w", encoding="utf-8") as f:
            for c in self.commands:
                f.write(json.dumps(c) + "\n")
        (self.path / "summary.md").write_text(self.summary, encoding="utf-8")

    def load(self) -> None:
        p = self.path
        if not p.is_dir():
            return
        f = p / "task.txt"
        if f.is_file():
            self.task = f.read_text(encoding="utf-8")
        f = p / "mode.txt"
        if f.is_file():
            self.mode = f.read_text(encoding="utf-8")
        f = p / "model.json"
        if f.is_file():
            self.model = json.loads(f.read_text(encoding="utf-8"))
        f = p / "explorer.json"
        if f.is_file():
            self.explorer = json.loads(f.read_text(encoding="utf-8"))
        f = p / "memory.json"
        if f.is_file():
            self.memory = json.loads(f.read_text(encoding="utf-8"))
        f = p / "guide.md"
        if f.is_file():
            self.guide = f.read_text(encoding="utf-8")
        f = p / "plan.md"
        if f.is_file():
            self.plan = f.read_text(encoding="utf-8")
        f = p / "patch.diff"
        if f.is_file():
            self.patch_diff = f.read_text(encoding="utf-8")
        f = p / "commands.jsonl"
        if f.is_file():
            self.commands = []
            for line in f.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    self.commands.append(json.loads(line))
                except ValueError:
                    pass
        f = p / "summary.md"
        if f.is_file():
            self.summary = f.read_text(encoding="utf-8")

    def record_command(self, cmd: list[str], result: dict[str, Any]) -> None:
        self.commands.append({"cmd": cmd, "result": result})

    def to_summary(self) -> str:
        """Human-readable summary of this session."""
        out = [
            f"# Cheater Session {self.id}",
            "",
            f"Mode: {self.mode}",
            f"Task: {self.task}",
        ]
        if self.model:
            out.append(f"Model: {self.model.get('provider', 'none')} / {self.model.get('model', '')}")
        if self.plan:
            out.append("")
            out.append("## Plan")
            out.append(self.plan)
        if self.summary:
            out.append("")
            out.append("## Summary")
            out.append(self.summary)
        if self.commands:
            out.append("")
            out.append(f"## Commands ({len(self.commands)})")
            for c in self.commands[:10]:
                cmd = " ".join(c.get("cmd") or [])
                ok = (c.get("result") or {}).get("ok")
                out.append(f"  - {'OK ' if ok else 'FAIL'} {cmd[:80]}")
        return "\n".join(out)


def session_root_for(project_root: str | Path) -> Path:
    """Return the .cheater/sessions/ dir for the project."""
    return Path(project_root) / ".cheater" / "sessions"


def new_session(project_root: str | Path, task: str, mode: str = "ask") -> Session:
    """Create a new session directory and return a Session."""
    root = session_root_for(project_root)
    sid = _now_id()
    s = Session(root=root, id=sid, task=task, mode=mode)
    s.save()
    return s


def list_sessions(project_root: str | Path) -> list[dict[str, Any]]:
    """List all sessions, newest first."""
    root = session_root_for(project_root)
    if not root.is_dir():
        return []
    out: list[dict[str, Any]] = []
    for d in root.iterdir():
        if not d.is_dir():
            continue
        info: dict[str, Any] = {"id": d.name}
        tf = d / "task.txt"
        if tf.is_file():
            info["task"] = tf.read_text(encoding="utf-8")[:200]
        mf = d / "mode.txt"
        if mf.is_file():
            info["mode"] = mf.read_text(encoding="utf-8")
        out.append(info)
    out.sort(key=lambda x: x["id"], reverse=True)
    return out


def load_session(project_root: str | Path, sid: str) -> Session:
    """Load an existing session by id."""
    root = session_root_for(project_root)
    s = Session(root=root, id=sid)
    s.load()
    return s


def resume_session(project_root: str | Path, sid: str) -> Session:
    return load_session(project_root, sid)


def format_session_list(items: list[dict[str, Any]]) -> str:
    if not items:
        return "No sessions found."
    out: list[str] = ["Sessions (newest first):"]
    for it in items:
        out.append(f"  - {it['id']}  mode={it.get('mode', '?')}  task={it.get('task', '?')[:80]}")
    return "\n".join(out)

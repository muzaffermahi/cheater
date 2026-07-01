from __future__ import annotations

import json
import subprocess
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any


@dataclass
class CheaterSessionRecord:
    session_id: str
    repo_path: str
    task: str
    error: str
    retrieval_query: str
    memories: list[dict[str, Any]]
    prompt_path: str
    run_dir: str
    pi_command: list[str] | None
    test_command: str
    mode: str
    status: str = "created"
    created_at: str = field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    updated_at: str = field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    ended_at: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def session_file(run_dir: Path) -> Path:
    return run_dir / "session.json"


def save_session_record(run_dir: Path, value: dict[str, Any] | CheaterSessionRecord) -> Path:
    data = value.to_dict() if isinstance(value, CheaterSessionRecord) else dict(value)
    data["updated_at"] = datetime.now().isoformat(timespec="seconds")
    path = session_file(run_dir)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


def load_session_record(run_dir: Path) -> dict[str, Any]:
    path = session_file(run_dir)
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def update_session_record(run_dir: Path, updates: dict[str, Any]) -> Path:
    value = load_session_record(run_dir)
    value.update(updates)
    return save_session_record(run_dir, value)


def ensure_repo_artifacts_excluded(repo: Path) -> bool:
    repo = repo.resolve()
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--git-path", "info/exclude"],
            cwd=str(repo),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
    except OSError:
        return False
    if result.returncode != 0 or not result.stdout.strip():
        return False
    exclude = Path(result.stdout.strip())
    if not exclude.is_absolute():
        exclude = repo / exclude
    exclude.parent.mkdir(parents=True, exist_ok=True)
    try:
        existing = exclude.read_text(encoding="utf-8", errors="replace") if exclude.exists() else ""
    except OSError:
        return False
    lines = {line.strip() for line in existing.splitlines()}
    if ".cheater/" not in lines:
        prefix = "" if not existing or existing.endswith("\n") else "\n"
        with exclude.open("a", encoding="utf-8") as handle:
            handle.write(prefix + ".cheater/\n")
    return True

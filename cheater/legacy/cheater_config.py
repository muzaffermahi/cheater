from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

from .agent_harness import parse_command_string


CONFIG_NAME = "cheater_config.json"
ALLOWED_KEYS = {"real_pi_command", "memory_db", "shim_dir"}


class ConfigError(RuntimeError):
    pass


def config_path(project_root: Path) -> Path:
    return project_root.resolve() / CONFIG_NAME


def load_config(project_root: Path) -> dict[str, Any]:
    path = config_path(project_root)
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ConfigError(f"Invalid JSON config at {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ConfigError(f"Config must be a JSON object: {path}")
    return value


def save_config(project_root: Path, config: dict[str, Any]) -> Path:
    path = config_path(project_root)
    path.write_text(json.dumps(config, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


def set_config_value(project_root: Path, key: str, value: str) -> Path:
    if key not in ALLOWED_KEYS:
        raise ConfigError(f"Unknown config key '{key}'. Allowed: {', '.join(sorted(ALLOWED_KEYS))}")
    config = load_config(project_root)
    config[key] = value
    return save_config(project_root, config)


def memory_db_path(project_root: Path) -> Path:
    config = load_config(project_root)
    configured = str(config.get("memory_db") or "").strip()
    if not configured:
        return project_root.resolve() / "data" / "compact_bug_cards.jsonl"
    path = Path(configured).expanduser()
    return path.resolve() if path.is_absolute() else (project_root / path).resolve()


def _where_pi() -> list[Path]:
    try:
        result = subprocess.run(
            ["where.exe", "pi"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
    except OSError:
        return []
    if result.returncode != 0:
        return []
    return [Path(line.strip()).resolve() for line in result.stdout.splitlines() if line.strip()]


def is_cheater_pi_shim(path: Path, project_root: Path, config: dict[str, Any] | None = None) -> bool:
    config = config or {}
    try:
        resolved = path.resolve()
    except OSError:
        resolved = path
    shim_dir = str(config.get("shim_dir") or "").strip()
    if shim_dir:
        try:
            if resolved.parent == Path(shim_dir).expanduser().resolve():
                return True
        except OSError:
            pass
    if resolved.name.lower() in {"pi.bat", "pi.cmd"}:
        try:
            content = resolved.read_text(encoding="utf-8", errors="replace")
            if "--wrap-pi" in content and "cheater.py" in content.lower():
                return True
        except OSError:
            pass
    return False


def detect_real_pi(project_root: Path) -> list[str] | None:
    config = load_config(project_root)
    candidates: list[Path] = []
    direct = shutil.which("pi")
    if direct:
        candidates.append(Path(direct))
    candidates.extend(_where_pi())
    appdata = os.environ.get("APPDATA")
    if appdata:
        npm_dir = Path(appdata) / "npm"
        candidates.extend(npm_dir / name for name in ("pi.cmd", "pi.ps1", "pi.exe", "pi"))

    seen: set[str] = set()
    for candidate in candidates:
        key = str(candidate).lower()
        if key in seen:
            continue
        seen.add(key)
        try:
            if not candidate.is_file() or is_cheater_pi_shim(candidate, project_root, config):
                continue
        except OSError:
            continue
        resolved = str(candidate.resolve())
        if candidate.suffix.lower() == ".ps1":
            powershell = shutil.which("powershell.exe") or "powershell"
            return [powershell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolved]
        return [resolved]
    return None


def resolve_real_pi_command(project_root: Path) -> list[str] | None:
    override = os.environ.get("CHEATER_REAL_PI_COMMAND", "").strip()
    if override:
        command = parse_command_string(override)
        return None if _command_recurses(command, project_root) else command
    config = load_config(project_root)
    configured = str(config.get("real_pi_command") or "").strip()
    if configured:
        command = parse_command_string(configured)
        return None if _command_recurses(command, project_root, config) else command
    return detect_real_pi(project_root)


def _command_recurses(
    command: list[str], project_root: Path, config: dict[str, Any] | None = None
) -> bool:
    path = command_path(command)
    if path:
        return is_cheater_pi_shim(path, project_root, config)
    if not command:
        return True
    return command[0].strip('"').lower() in {"pi", "pi.cmd", "pi.bat", "pi.ps1"}


def command_path(command: list[str] | None) -> Path | None:
    if not command:
        return None
    for part in reversed(command):
        path = Path(part.strip('"'))
        try:
            if path.is_file() and path.suffix.lower() in {".cmd", ".bat", ".ps1", ".exe", ""}:
                return path.resolve()
        except OSError:
            continue
    return None

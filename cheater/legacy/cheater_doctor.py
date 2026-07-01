from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

from .agent_harness import parse_command_string

from .cheater_config import (
    ConfigError,
    command_path,
    config_path,
    is_cheater_pi_shim,
    load_config,
    memory_db_path,
    resolve_real_pi_command,
)
from .qwen_local_agent import LocalQwenConfig, discover_local_qwen


def _where(name: str) -> list[str]:
    try:
        result = subprocess.run(
            ["where.exe", name],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
    except OSError:
        return []
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def _is_git_worktree(repo: Path) -> bool:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--is-inside-work-tree"],
            cwd=str(repo),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
    except OSError:
        return False
    return result.returncode == 0 and result.stdout.strip().lower() == "true"


def collect_doctor(project_root: Path, repo: Path | None = None) -> dict[str, Any]:
    repo = (repo or Path.cwd()).resolve()
    errors: list[str] = []
    warnings: list[str] = []
    try:
        config = load_config(project_root)
        config_valid = True
    except ConfigError as exc:
        config = {}
        config_valid = False
        errors.append(str(exc))

    try:
        real_pi = resolve_real_pi_command(project_root) if config_valid else None
    except ConfigError as exc:
        real_pi = None
        errors.append(str(exc))
    real_pi_path = command_path(real_pi)
    pi_candidates = _where("pi")
    shim_dir_text = str(config.get("shim_dir") or "").strip()
    shim_dir = Path(shim_dir_text).expanduser().resolve() if shim_dir_text else None
    shim_path = shim_dir / "pi.bat" if shim_dir else None
    first_pi = Path(pi_candidates[0]).resolve() if pi_candidates else None
    shim_active = bool(shim_path and first_pi and first_pi == shim_path.resolve())
    configured_real_pi = os.environ.get("CHEATER_REAL_PI_COMMAND", "").strip() or str(
        config.get("real_pi_command") or ""
    ).strip()
    configured_path = command_path(parse_command_string(configured_real_pi)) if configured_real_pi else None
    recursion_risk = bool(
        configured_path and is_cheater_pi_shim(configured_path, project_root, config)
    )
    if recursion_risk:
        errors.append("Configured real Pi command points to the Cheater shim (recursion risk).")
    if not real_pi:
        warnings.append("Real Pi command was not found.")
    cards = memory_db_path(project_root) if config_valid else project_root / "data" / "compact_bug_cards.jsonl"
    if not cards.exists():
        errors.append(f"Memory DB is missing: {cards}")
    repo_is_git = _is_git_worktree(repo)
    if not repo_is_git:
        warnings.append(f"Current repo is not a Git worktree: {repo}")
    cheater_command = shutil.which("cheater")
    if not cheater_command:
        warnings.append("Cheater is not currently discoverable on PATH.")
    qwen_base_url = os.getenv("CHEATER_QWEN_BASE_URL", "http://127.0.0.1:1234/v1")
    qwen_requested_model = os.getenv("CHEATER_QWEN_MODEL", "")
    qwen_model, qwen_loaded_models, qwen_error = discover_local_qwen(
        LocalQwenConfig(
            base_url=qwen_base_url,
            model=qwen_requested_model,
            request_timeout=2.0,
        )
    )
    if not qwen_model:
        warnings.append(qwen_error)

    return {
        "ok": not errors,
        "project_root": str(project_root.resolve()),
        "config_path": str(config_path(project_root)),
        "config_valid": config_valid,
        "cheater_on_path": cheater_command,
        "real_pi_command": real_pi,
        "real_pi_path": str(real_pi_path) if real_pi_path else None,
        "pi_where_results": pi_candidates,
        "shim_dir": str(shim_dir) if shim_dir else None,
        "shim_path": str(shim_path) if shim_path else None,
        "shim_active": shim_active,
        "shim_recursion_risk": recursion_risk,
        "current_repo": str(repo),
        "repo_is_git": repo_is_git,
        "memory_db": str(cards),
        "memory_db_found": cards.exists(),
        "clipboard_command": shutil.which("clip") or (_where("clip")[0] if _where("clip") else None),
        "lms_command": shutil.which("lms"),
        "qwen_base_url": qwen_base_url,
        "qwen_requested_model": qwen_requested_model or None,
        "qwen_loaded_models": qwen_loaded_models,
        "qwen_model": qwen_model,
        "qwen_available": qwen_model is not None,
        "errors": errors,
        "warnings": warnings,
    }


def print_doctor(report: dict[str, Any]) -> None:
    print("Cheater install path:", report["project_root"])
    print("Config:", report["config_path"], "(valid)" if report["config_valid"] else "(INVALID)")
    print("Cheater PATH command:", report["cheater_on_path"] or "not found")
    print("Real Pi command:", subprocess.list2cmdline(report["real_pi_command"]) if report["real_pi_command"] else "not found")
    print("Shim Pi command:", report["shim_path"] or "not installed")
    print("Shim active:", "yes" if report["shim_active"] else "no")
    print("Shim recursion risk:", "YES" if report["shim_recursion_risk"] else "no")
    print("Current repo:", report["current_repo"])
    print("Git repo:", "yes" if report["repo_is_git"] else "no")
    print("Memory DB:", report["memory_db"], "(found)" if report["memory_db_found"] else "(MISSING)")
    print("Clipboard command:", report["clipboard_command"] or "not found")
    print("LM Studio CLI:", report["lms_command"] or "not found")
    print("Local Qwen endpoint:", report["qwen_base_url"])
    print("Local Qwen model:", report["qwen_model"] or "not loaded")
    for warning in report["warnings"]:
        print("WARNING:", warning)
    for error in report["errors"]:
        print("ERROR:", error)

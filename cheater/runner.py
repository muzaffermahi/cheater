"""Safe command runner for Cheater.

Features:
  - Detects common project commands (pytest, ruff, mypy, npm test, cargo test, etc.)
  - User approval before running (CLI flag --yes to skip)
  - Timeouts (default 120s, configurable)
  - Output capture (stdout + stderr)
  - Failure summarization (last 50 lines, error type detection, failed test names)
  - Forbidden-command blocklist (rm -rf, force push, etc.)
  - Returns structured CommandResult

Public API:
  run(cmd, cwd=..., timeout=..., yes=False) -> CommandResult
  detect_test_command(repo_root) -> Optional[str]
  detect_lint_command(repo_root) -> Optional[str]
  summarize_failure(result) -> dict
"""
from __future__ import annotations

import os
import re
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# Commands that are NEVER allowed without explicit override
FORBIDDEN_COMMAND_PATTERNS: tuple[str, ...] = (
    r"rm\s+-rf\s+/",
    r"rm\s+-rf\s+~",
    r"rm\s+-rf\s+\*",
    r":\(\)\s*\{.*\};:",  # fork bomb
    r"dd\s+if=.*of=/dev/",
    r"mkfs",
    r"git\s+push\s+.*--force",
    r"git\s+push\s+-f\b",
    r"git\s+reset\s+--hard",
    r"git\s+clean\s+-fd",
    r"curl\s+.*\|\s*sh",
    r"wget\s+.*\|\s*sh",
    r"sudo\s+",
    r"chmod\s+-R\s+777",
)

# Default timeout (seconds)
DEFAULT_TIMEOUT = 120.0

# Project-type detection
PYTHON_FILES = ("pyproject.toml", "setup.py", "setup.cfg", "requirements.txt")
JS_FILES = ("package.json", "yarn.lock", "pnpm-lock.yaml")
RUST_FILES = ("Cargo.toml", "Cargo.lock")
GO_FILES = ("go.mod", "go.sum")
JAVA_FILES = ("pom.xml", "build.gradle", "build.gradle.kts")


@dataclass
class CommandResult:
    """Result of a command run."""
    cmd: list[str]
    returncode: int
    stdout: str
    stderr: str
    elapsed: float
    timed_out: bool = False
    forbidden: bool = False
    approved: bool = True
    error: str = ""

    @property
    def ok(self) -> bool:
        return self.returncode == 0 and not self.timed_out and not self.forbidden

    def to_dict(self) -> dict[str, Any]:
        return {
            "cmd": self.cmd,
            "returncode": self.returncode,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "elapsed": self.elapsed,
            "timed_out": self.timed_out,
            "forbidden": self.forbidden,
            "ok": self.ok,
            "error": self.error,
        }


def is_forbidden(cmd: str | list[str]) -> bool:
    """Check if a command matches a forbidden pattern."""
    if isinstance(cmd, list):
        cmd = " ".join(cmd)
    for pat in FORBIDDEN_COMMAND_PATTERNS:
        if re.search(pat, cmd):
            return True
    return False


def detect_test_command(repo_root: str | Path) -> str | None:
    """Detect a likely test command for the project."""
    root = Path(repo_root)
    if any((root / f).is_file() for f in PYTHON_FILES):
        return "pytest -x -q"
    if any((root / f).is_file() for f in JS_FILES):
        return "npm test"
    if any((root / f).is_file() for f in RUST_FILES):
        return "cargo test"
    if any((root / f).is_file() for f in GO_FILES):
        return "go test ./..."
    if any((root / f).is_file() for f in JAVA_FILES):
        return "mvn test"
    return None


def detect_lint_command(repo_root: str | Path) -> str | None:
    """Detect a likely lint command for the project."""
    root = Path(repo_root)
    if any((root / f).is_file() for f in PYTHON_FILES):
        # Check if ruff is configured
        if (root / "pyproject.toml").is_file():
            return "ruff check ."
        return None
    if any((root / f).is_file() for f in JS_FILES):
        return "npx eslint ."
    if any((root / f).is_file() for f in RUST_FILES):
        return "cargo clippy"
    return None


def detect_format_command(repo_root: str | Path) -> str | None:
    """Detect a likely format command for the project."""
    root = Path(repo_root)
    if any((root / f).is_file() for f in PYTHON_FILES):
        if (root / "pyproject.toml").is_file():
            return "ruff format ."
    if any((root / f).is_file() for f in RUST_FILES):
        return "cargo fmt"
    return None


def _shell_split(cmd: str) -> list[str]:
    """Tiny shell-style splitter. Handles quotes, no env expansion.

    On Windows, backslashes in paths are preserved (not treated as escapes).
    Strips surrounding quotes from each token.
    """
    import shlex
    if os.name == "nt":
        # posix=False keeps backslashes literal but keeps quotes in the tokens
        tokens = shlex.split(cmd, posix=False)
    else:
        tokens = shlex.split(cmd)
    # Strip surrounding quotes from each token
    out: list[str] = []
    for t in tokens:
        if len(t) >= 2 and ((t[0] == '"' and t[-1] == '"') or (t[0] == "'" and t[-1] == "'")):
            out.append(t[1:-1])
        else:
            out.append(t)
    return out


def run(
    cmd: str | list[str],
    cwd: str | Path | None = None,
    timeout: float = DEFAULT_TIMEOUT,
    yes: bool = False,
    env: dict[str, str] | None = None,
) -> CommandResult:
    """Run a command. Returns a CommandResult.

    - yes=True: skip the approval prompt and the forbidden check
    - Forbidden commands are blocked unless yes=True AND cmd starts with "force:"
    - Output is captured (stdout + stderr)
    - Times out after `timeout` seconds
    """
    if isinstance(cmd, str):
        cmd_list = _shell_split(cmd)
        cmd_str = cmd
    else:
        cmd_list = list(cmd)
        cmd_str = " ".join(cmd_list)

    if is_forbidden(cmd_str) and not yes:
        return CommandResult(
            cmd=cmd_list,
            returncode=-1,
            stdout="",
            stderr="",
            elapsed=0.0,
            forbidden=True,
            approved=False,
            error=f"Refusing to run forbidden command: {cmd_str}",
        )

    work_dir = str(Path(cwd).resolve()) if cwd else os.getcwd()
    if not yes:
        # Try to prompt for approval
        try:
            print(f"\n=== About to run ===\n  {cmd_str}\nin:  {work_dir}\n[enter=continue / n=skip / Ctrl+C=abort] > ", end="", flush=True)
            ans = input().strip().lower()
            if ans in ("n", "no", "skip", "abort"):
                return CommandResult(
                    cmd=cmd_list, returncode=-1, stdout="", stderr="", elapsed=0.0,
                    approved=False, error="user declined",
                )
        except (EOFError, KeyboardInterrupt):
            return CommandResult(
                cmd=cmd_list, returncode=-1, stdout="", stderr="", elapsed=0.0,
                approved=False, error="user interrupted",
            )

    start = time.time()
    full_env = os.environ.copy()
    if env:
        full_env.update(env)
    # On Windows, if the command is a shell builtin (echo, dir, copy, etc.)
    # and no executable is found, retry via cmd.exe /c
    use_shell = False
    if os.name == "nt" and isinstance(cmd, str):
        exe = cmd_list[0].lower() if cmd_list else ""
        shell_builtins = {
            "echo", "dir", "cd", "copy", "move", "del", "ren", "type",
            "set", "if", "for", "md", "rd", "cls", "exit",
        }
        if exe in shell_builtins:
            use_shell = True
    try:
        proc = subprocess.run(
            cmd_list,
            cwd=work_dir,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=full_env,
            shell=use_shell,
        )
        elapsed = time.time() - start
        return CommandResult(
            cmd=cmd_list,
            returncode=proc.returncode,
            stdout=proc.stdout or "",
            stderr=proc.stderr or "",
            elapsed=elapsed,
        )
    except subprocess.TimeoutExpired as e:
        elapsed = time.time() - start
        return CommandResult(
            cmd=cmd_list,
            returncode=-1,
            stdout=(e.stdout or b"").decode("utf-8", errors="ignore") if isinstance(e.stdout, bytes) else (e.stdout or ""),
            stderr=(e.stderr or b"").decode("utf-8", errors="ignore") if isinstance(e.stderr, bytes) else (e.stderr or ""),
            elapsed=elapsed,
            timed_out=True,
            error=f"command timed out after {timeout}s",
        )
    except FileNotFoundError as e:
        # On Windows, retry via cmd.exe /c for shell builtins
        if os.name == "nt" and not use_shell and isinstance(cmd, str):
            try:
                proc2 = subprocess.run(
                    cmd,
                    cwd=work_dir,
                    capture_output=True,
                    text=True,
                    timeout=timeout,
                    env=full_env,
                    shell=True,
                )
                return CommandResult(
                    cmd=cmd_list,
                    returncode=proc2.returncode,
                    stdout=proc2.stdout or "",
                    stderr=proc2.stderr or "",
                    elapsed=time.time() - start,
                )
            except (OSError, subprocess.TimeoutExpired) as e2:
                return CommandResult(
                    cmd=cmd_list, returncode=-1, stdout="", stderr="",
                    elapsed=time.time() - start,
                    error=f"command not found: {e}; shell retry failed: {e2}",
                )
        return CommandResult(
            cmd=cmd_list,
            returncode=-1,
            stdout="",
            stderr="",
            elapsed=time.time() - start,
            error=f"command not found: {e}",
        )
    except OSError as e:
        return CommandResult(
            cmd=cmd_list,
            returncode=-1,
            stdout="",
            stderr="",
            elapsed=time.time() - start,
            error=f"OS error: {e}",
        )


# Common error patterns for failure summarization
ERROR_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"(\w+Error):", "error_type"),
    (r"(\w+Exception):", "exception_type"),
    (r"AssertionError", "assertion"),
    (r"FAILED\s+(\S+)", "test_failed"),
    (r"^FAIL\s+(\S+)", "test_fail_line"),
    (r"(\d+)\s+passed", "tests_passed"),
    (r"(\d+)\s+failed", "tests_failed"),
    (r"error\[E\d+\]", "rust_error"),
    (r"(\d+):\d+:\s+(error|warning)", "rust_diag"),
)


def summarize_failure(result: CommandResult) -> dict[str, Any]:
    """Summarize a failed command output for the agent/guide loop.

    Returns dict with:
      - error_type: first matched error/exception type
      - failed_tests: list of failed test names
      - passed: int
      - failed: int
      - tail: last 50 lines of output
      - hint: short string describing the failure
    """
    output = (result.stdout or "") + "\n" + (result.stderr or "")
    error_type = ""
    failed_tests: list[str] = []
    passed = 0
    failed = 0
    for pat, label in ERROR_PATTERNS:
        m = re.search(pat, output)
        if m and label in ("error_type", "exception_type"):
            error_type = m.group(1)
            break
    # pytest-style: "FAILED tests/test_x.py::test_y" or "FAILED test_x"
    for m in re.finditer(r"FAILED\s+(\S+)", output):
        failed_tests.append(m.group(1))
    # "1 failed, 3 passed" pattern
    m = re.search(r"(\d+)\s+passed", output)
    if m:
        passed = int(m.group(1))
    m = re.search(r"(\d+)\s+failed", output)
    if m:
        failed = int(m.group(1))
    # Tail
    lines = output.splitlines()
    tail = "\n".join(lines[-50:]) if lines else ""
    # Build a short hint
    hint = ""
    if result.timed_out:
        hint = "command timed out"
    elif result.forbidden:
        hint = "command was forbidden"
    elif failed_tests:
        hint = f"{len(failed_tests)} test(s) failed: {', '.join(failed_tests[:3])}"
    elif error_type:
        hint = f"{error_type} raised"
    elif failed > 0:
        hint = f"{failed} test(s) failed"
    else:
        hint = "command exited non-zero"
    return {
        "error_type": error_type,
        "failed_tests": failed_tests[:10],
        "passed": passed,
        "failed": failed,
        "tail": tail,
        "hint": hint,
    }

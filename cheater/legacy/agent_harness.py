from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Sequence


def copy_text_to_clipboard(text: str) -> None:
    subprocess.run("clip", input=text, text=True, check=True, shell=True)


def _where_results(command_name: str) -> list[str]:
    try:
        result = subprocess.run(
            ["where.exe", command_name],
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
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def _powershell_command_info(command_name: str) -> dict[str, str] | None:
    powershell = shutil.which("powershell.exe") or shutil.which("powershell")
    if not powershell:
        return None
    safe_name = command_name.replace("'", "''")
    script = (
        f"$c = Get-Command -Name '{safe_name}' -ErrorAction SilentlyContinue | "
        "Select-Object -First 1; "
        "if ($c) { [pscustomobject]@{ "
        "CommandType = [string]$c.CommandType; Path = [string]$c.Path; "
        "Source = [string]$c.Source; Definition = [string]$c.Definition "
        "} | ConvertTo-Json -Compress }"
    )
    try:
        result = subprocess.run(
            [powershell, "-Command", script],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
    except OSError:
        return None
    if result.returncode != 0 or not result.stdout.strip():
        return None
    try:
        value = json.loads(result.stdout.strip())
    except json.JSONDecodeError:
        return None
    if not isinstance(value, dict):
        return None
    return {str(key): str(item or "") for key, item in value.items()}


def find_command(command_name: str) -> str | None:
    direct = shutil.which(command_name)
    if direct:
        return str(Path(direct).resolve())

    where_results = _where_results(command_name)
    if where_results:
        return str(Path(where_results[0]).resolve())

    info = _powershell_command_info(command_name)
    if not info:
        return None
    return info.get("Path") or info.get("Source") or info.get("Definition") or command_name


def detect_pi_command() -> list[str] | None:
    direct = shutil.which("pi")
    candidates = [direct] if direct else _where_results("pi")
    appdata = os.environ.get("APPDATA")
    if appdata:
        npm_dir = Path(appdata) / "npm"
        for shim_name in ("pi.cmd", "pi.ps1", "pi.exe", "pi"):
            shim = npm_dir / shim_name
            try:
                if shim.is_file() and str(shim) not in candidates:
                    candidates.append(str(shim))
            except OSError:
                pass
    for candidate in candidates:
        if not candidate:
            continue
        path = str(Path(candidate).resolve())
        suffix = Path(path).suffix.lower()
        if suffix == ".ps1":
            powershell = shutil.which("powershell.exe") or "powershell"
            return [powershell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path]
        return [path]

    info = _powershell_command_info("pi")
    if not info:
        return None
    command_type = info.get("CommandType", "").lower()
    path = info.get("Path", "")
    if path:
        resolved = str(Path(path).resolve())
        if Path(resolved).suffix.lower() == ".ps1":
            powershell = shutil.which("powershell.exe") or "powershell"
            return [
                powershell,
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                resolved,
            ]
        return [resolved]
    if command_type in {"alias", "function", "filter", "cmdlet"}:
        powershell = shutil.which("powershell.exe") or "powershell"
        return [
            powershell,
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "pi",
        ]
    return None


def parse_command_string(value: str) -> list[str]:
    unquoted = value.strip().strip('"').strip("'")
    if Path(unquoted).is_file():
        return [str(Path(unquoted).resolve())]
    parts = shlex.split(value, posix=False)
    cleaned: list[str] = []
    for part in parts:
        if len(part) >= 2 and part[0] == part[-1] and part[0] in {'"', "'"}:
            part = part[1:-1]
        cleaned.append(part)
    return cleaned


def resolve_pi_command() -> list[str] | None:
    override = os.environ.get("CHEATER_PI_COMMAND", "").strip()
    if override:
        return parse_command_string(override)
    return detect_pi_command()


def _powershell_literal(value: str | Path) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def open_pi_window(repo_path: Path, pi_command: list[str]) -> subprocess.Popen[Any]:
    powershell = shutil.which("powershell.exe") or shutil.which("powershell") or "powershell"
    invocation = "& " + " ".join(_powershell_literal(part) for part in pi_command)
    script = (
        f"Set-Location -LiteralPath {_powershell_literal(repo_path.resolve())}; "
        f"$Host.UI.RawUI.WindowTitle = {_powershell_literal('CHEATER PI - ' + repo_path.name)}; "
        + invocation
    )
    creation_flags = getattr(subprocess, "CREATE_NEW_CONSOLE", 0)
    return subprocess.Popen(
        [powershell, "-NoLogo", "-Command", script],
        creationflags=creation_flags,
    )


def send_ctrl_v_enter_best_effort(
    process_id: int | None = None,
    delay_seconds: float = 2.0,
    window_titles: Sequence[str] | None = None,
) -> tuple[bool, str]:
    powershell = shutil.which("powershell.exe") or shutil.which("powershell")
    if not powershell:
        return False, "PowerShell was not found, so SendKeys could not run."

    time.sleep(max(0.0, delay_seconds))
    targets: list[str] = []
    if process_id is not None:
        targets.append(str(process_id))
    for title in window_titles or ["CHEATER PI", "pi"]:
        targets.append(_powershell_literal(title))
    target_array = "@(" + ", ".join(targets) + ")"
    script = (
        "$shell = New-Object -ComObject WScript.Shell; "
        f"$targets = {target_array}; $active = $false; $used = ''; "
        "foreach ($target in $targets) { "
        "$active = $shell.AppActivate($target); "
        "if ($active) { $used = [string]$target; break }; "
        "Start-Sleep -Milliseconds 350 }; "
        "if (-not $active) { Write-Error 'Could not focus the Pi window'; exit 1 }; "
        "Start-Sleep -Milliseconds 500; "
        "$shell.SendKeys('^v'); "
        "Start-Sleep -Milliseconds 350; "
        "$shell.SendKeys('{ENTER}'); "
        "Write-Output ('Focused target: ' + $used)"
    )
    try:
        result = subprocess.run(
            [powershell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
            timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, f"SendKeys failed to start: {exc}"
    if result.returncode == 0:
        detail = result.stdout.strip()
        suffix = f" ({detail})" if detail else ""
        return True, "Ctrl+V and Enter were sent to the Pi window." + suffix
    detail = (result.stderr or result.stdout).strip()
    return False, detail or f"SendKeys exited with code {result.returncode}."


def load_agent_profiles(path: str | Path) -> dict[str, dict[str, Any]]:
    profile_path = Path(path)
    with profile_path.open("r", encoding="utf-8") as handle:
        profiles = json.load(handle)
    if not isinstance(profiles, dict):
        raise ValueError("Agent profiles must be a JSON object.")
    return profiles


def _path_text(value: str | Path | None) -> str:
    if value is None:
        return ""
    # Forward slashes work in Windows CLI arguments and remain safe inside the
    # dryrun profile's inline Python string.
    return Path(value).resolve().as_posix()


def _replacements(
    prompt_file: str | Path,
    repo_path: str | Path,
    task_file: str | Path | None,
    log_file: str | Path | None,
) -> dict[str, str]:
    return {
        "{prompt_file}": _path_text(prompt_file),
        "{repo_path}": _path_text(repo_path),
        "{task_file}": _path_text(task_file),
        "{log_file}": _path_text(log_file),
    }


def _render_text(text: str, replacements: dict[str, str]) -> str:
    for placeholder, value in replacements.items():
        text = text.replace(placeholder, value)
    return text


def render_command(
    profile: dict[str, Any],
    prompt_file: str | Path,
    repo_path: str | Path,
    task_file: str | Path | None = None,
    log_file: str | Path | None = None,
) -> list[str]:
    command = profile.get("command")
    if not isinstance(command, list) or not all(isinstance(part, str) for part in command):
        raise ValueError("Agent profile 'command' must be a list of strings.")
    replacements = _replacements(prompt_file, repo_path, task_file, log_file)
    return [_render_text(part, replacements) for part in command]


def render_profile_cwd(
    profile: dict[str, Any],
    prompt_file: str | Path,
    repo_path: str | Path,
    task_file: str | Path | None = None,
    log_file: str | Path | None = None,
) -> str:
    cwd = profile.get("cwd", "{repo_path}")
    if not isinstance(cwd, str):
        raise ValueError("Agent profile 'cwd' must be a string.")
    return _render_text(cwd, _replacements(prompt_file, repo_path, task_file, log_file))


def _stream_process(
    command: Sequence[str] | str,
    cwd: str | Path,
    log_file: str | Path,
    *,
    shell: bool,
) -> tuple[int, str]:
    log_path = Path(log_file)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    chunks: list[str] = []

    try:
        process = subprocess.Popen(
            command,
            cwd=str(cwd),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            shell=shell,
        )
    except OSError as exc:
        message = f"Unable to start command: {exc}\n"
        print(message, end="", file=sys.stderr)
        log_path.write_text(message, encoding="utf-8")
        return 127, message

    with log_path.open("w", encoding="utf-8") as log:
        assert process.stdout is not None
        for line in process.stdout:
            print(line, end="", flush=True)
            log.write(line)
            log.flush()
            chunks.append(line)
    return_code = process.wait()
    return return_code, "".join(chunks)


def run_agent_command(
    command: Sequence[str], cwd: str | Path, log_file: str | Path
) -> tuple[int, str]:
    return _stream_process(command, cwd, log_file, shell=False)


def run_interactive_command(
    command: Sequence[str], cwd: str | Path, log_file: str | Path
) -> tuple[int, str]:
    """Run a TUI with the real console attached so stdin and screen control work."""
    log_path = Path(log_file)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    started = f"Starting interactive command in {Path(cwd).resolve()}\n"
    log_path.write_text(started, encoding="utf-8")
    try:
        process = subprocess.Popen(command, cwd=str(cwd))
        return_code = process.wait()
    except OSError as exc:
        message = f"Unable to start interactive command: {exc}\n"
        print(message, end="", file=sys.stderr)
        log_path.write_text(started + message, encoding="utf-8")
        return 127, started + message

    finished = f"Interactive command exited with code {return_code}.\n"
    with log_path.open("a", encoding="utf-8") as log:
        log.write(finished)
    return return_code, started + finished


def build_agent_prompt(
    task: str,
    error: str | None,
    memories: str,
    repo_path: str | Path,
    mode: str,
) -> str:
    observed_error = (error or "").strip() or "No specific error text was provided."
    return f"""# Task

{task.strip()}

Repository: `{Path(repo_path).resolve()}`

# Observed Error / Failure

{observed_error}

# Relevant solved bug memories

{memories.strip()}

# Instructions

This is the {mode} attempt.

Use the memories as hints, not as patches to copy blindly.
Inspect the current repository before editing.
Identify whether the current bug matches any retrieved fix pattern.
Adapt the pattern to the current codebase.
Make the smallest correct change.
Run relevant tests.
Do not modify unrelated files.
Do not add random reproduction files unless needed, and clean them up before finalizing.
Do not copy code from memories unless it directly applies.
"""


def extract_failure_query(log_text: str, task: str, max_chars: int = 4000) -> str:
    failure = (log_text or "").strip()
    if len(failure) > max_chars:
        failure = failure[-max_chars:]
    return f"{task.strip()}\n{failure}".strip()


def run_tests(
    test_command: str, repo_path: str | Path, log_file: str | Path
) -> tuple[int, str]:
    return _stream_process(test_command, repo_path, log_file, shell=True)

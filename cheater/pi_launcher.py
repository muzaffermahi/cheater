"""Thin Cheater launcher for the Pi-based distribution.

The historical Python CLI remains in the package for legacy tests and imports,
but this module is the only user-facing console path. It never starts the old
Python TUI or agent loop; it only resolves and launches Pi with Cheater
resources preloaded.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

from cheater import __version__


REPO_ROOT = Path(__file__).resolve().parents[1]
PACKAGE_DIR = REPO_ROOT / "cheater-pi"
EXTENSION_PATH = PACKAGE_DIR / "src" / "extension.ts"
PROMPTS_DIR = PACKAGE_DIR / "prompts"
SKILLS_DIR = PACKAGE_DIR / "skills"
THEME_PATH = PACKAGE_DIR / "themes" / "cheater.json"
CONFIG_PATHS = (
    Path.home() / ".config" / "cheater" / "config.json",
    REPO_ROOT / ".cheater" / "config.json",
)

LEGACY_COMMANDS = {
    "agent",
    "arena",
    "audit-cards",
    "bench",
    "benchmark",
    "build-cards",
    "build-index",
    "budget",
    "ctx",
    "doctor",
    "explore",
    "guide",
    "init",
    "init-data",
    "janitor",
    "lint",
    "localize",
    "map",
    "memory",
    "model",
    "patch",
    "rescore",
    "run",
    "search",
    "sessions",
    "smoke",
    "test",
    "trace",
    "tui",
    "undo",
}


@dataclass(frozen=True)
class LauncherConfig:
    pi_command: list[str] | None = None
    provider: str | None = None
    model: str | None = None
    theme_enabled: bool = True
    debug: bool = False
    show_startup_card: bool = True


@dataclass(frozen=True)
class LaunchOptions:
    doctor: bool = False
    debug: bool = False
    no_theme: bool = False
    print_pi_command: bool = False
    help: bool = False
    version: bool = False
    passthrough: tuple[str, ...] = ()


def main(argv: Sequence[str] | None = None) -> int:
    raw = list(sys.argv[1:] if argv is None else argv)
    if raw and raw[0] == "gym":
        return run_gym_cli(raw[1:], cwd=Path.cwd())
    if len(raw) >= 2 and raw[0] == "bench" and raw[1] == "reliability":
        return run_reliability_bench_cli(raw[2:], cwd=Path.cwd())
    args = parse_args(tuple(raw))
    cfg = load_config()
    if args.help:
        print_help()
        return 0
    if args.version:
        print(f"cheater {__version__}")
        return 0
    if args.doctor:
        return run_doctor(cfg, args)

    legacy = first_legacy_command(args.passthrough)
    if legacy:
        sys.stderr.write(
            f"cheater: `{legacy}` was part of the old Python agent CLI and is no longer "
            "a primary Cheater command.\n"
            "Run `cheater` to open the Cheater-flavored Pi TUI, or use Pi slash "
            "commands such as /mission, /fix, /orient, /repro, /evidence, /verify, /learn, /test, /map, /skills, and /doctor.\n"
        )
        return 2

    command = build_pi_command(cfg, args)
    if args.print_pi_command or args.debug or cfg.debug:
        print(format_command(command))
        if args.print_pi_command:
            return 0
    try:
        completed = subprocess.run(command, cwd=Path.cwd())
    except FileNotFoundError:
        print_missing_pi_message()
        return 127
    except KeyboardInterrupt:
        return 130
    return completed.returncode


def run_gym_cli(rest: Sequence[str], cwd: Path) -> int:
    """Delegate `cheater gym ...` to the TypeScript CLI when available.

    The Gym implementation lives in the cheater-pi package. This launcher
    prefers a real built `cheater-pi/dist/src/index.js` run with node, and
    avoids recursively calling the `cheater` command on PATH (which may be
    this same Python launcher and would loop forever).
    """
    dist_index = PACKAGE_DIR / "dist" / "src" / "index.js"
    candidates: list[list[str]] = []
    if dist_index.is_file():
        candidates.append(["node", str(dist_index)])
    npm_cheater = _resolve_external_cheater_binary()
    if npm_cheater:
        candidates.append([npm_cheater])

    if not candidates:
        sys.stderr.write(
            "cheater gym: no built cheater-pi/dist/src/index.js found and no external cheater binary.\n"
            "Build the package first: `cd cheater-pi && npm run build`.\n"
        )
        return 127

    last_error: Exception | None = None
    for cmd in candidates:
        try:
            completed = subprocess.run([*cmd, "gym", *rest], cwd=cwd)
            return completed.returncode
        except FileNotFoundError as err:
            last_error = err
            continue
    sys.stderr.write("cheater gym: could not run the TypeScript CLI.\n")
    if last_error:
        sys.stderr.write(f"last error: {last_error}\n")
    return 127


def run_reliability_bench_cli(rest: Sequence[str], cwd: Path) -> int:
    """Delegate `cheater bench reliability ...` to the TypeScript package."""
    dist_index = PACKAGE_DIR / "dist" / "src" / "index.js"
    if not dist_index.is_file():
        sys.stderr.write(
            "cheater bench reliability: built cheater-pi/dist/src/index.js not found.\n"
            "Build the package first: `cd cheater-pi && npm run build`.\n"
        )
        return 127
    try:
        completed = subprocess.run(
            ["node", str(dist_index), "bench", "reliability", *rest], cwd=cwd
        )
    except FileNotFoundError:
        sys.stderr.write("cheater bench reliability: node not found.\n")
        return 127
    return completed.returncode


def parse_args(argv: tuple[str, ...]) -> LaunchOptions:
    passthrough: list[str] = []
    doctor = debug = no_theme = print_pi_command = help_flag = version = False
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg in {"--help", "-h", "help"}:
            help_flag = True
        elif arg in {"--version", "-v"}:
            version = True
        elif arg == "--doctor":
            doctor = True
        elif arg == "--debug":
            debug = True
        elif arg == "--no-theme":
            no_theme = True
        elif arg == "--print-pi-command":
            print_pi_command = True
        else:
            passthrough.append(arg)
        i += 1
    return LaunchOptions(
        doctor=doctor,
        debug=debug,
        no_theme=no_theme,
        print_pi_command=print_pi_command,
        help=help_flag,
        version=version,
        passthrough=tuple(passthrough),
    )


def load_config() -> LauncherConfig:
    data: dict[str, object] = {}
    for path in CONFIG_PATHS:
        if path.is_file():
            try:
                loaded = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if isinstance(loaded, dict):
                data.update(loaded)
    env_pi = os.environ.get("CHEATER_PI_COMMAND") or os.environ.get("CHEATER_PI_PATH")
    pi_command = _coerce_command(data.get("piCommand") or data.get("pi_command"))
    if env_pi:
        pi_command = [env_pi]
    return LauncherConfig(
        pi_command=pi_command,
        provider=_coerce_str(data.get("provider")),
        model=_coerce_str(data.get("model")),
        theme_enabled=bool(data.get("themeEnabled", data.get("theme_enabled", True))),
        debug=bool(data.get("debug", False)),
        show_startup_card=bool(
            data.get("showStartupCard", data.get("show_startup_card", True))
        ),
    )


def build_pi_command(cfg: LauncherConfig, opts: LaunchOptions) -> list[str]:
    pi = resolve_pi_command(cfg)
    # Cheater's system prompt is injected once, config-aware, at before_agent_start by the
    # extension (see cheater-pi/src/prompts.ts buildSystemPrompt). We deliberately do NOT also
    # pass --append-system-prompt for cheater.md: a small model reconciling two drifted copies
    # of the same rulebook is a known failure mode. Keeps this launcher in sync with launcher.ts.
    command = [
        *pi,
        "--extension",
        str(EXTENSION_PATH),
        "--skill",
        str(SKILLS_DIR),
        "--prompt-template",
        str(PROMPTS_DIR),
        "--name",
        "Cheater",
    ]
    if cfg.provider:
        command.extend(["--provider", cfg.provider])
    if cfg.model:
        command.extend(["--model", cfg.model])
    if cfg.theme_enabled and not opts.no_theme and THEME_PATH.is_file():
        command.extend(["--theme", str(THEME_PATH)])
    command.extend(opts.passthrough)
    return command


def resolve_pi_command(cfg: LauncherConfig) -> list[str]:
    if cfg.pi_command:
        return cfg.pi_command
    env_real = os.environ.get("CHEATER_REAL_PI_COMMAND")
    if env_real:
        return [env_real]

    for candidate in _pi_candidates():
        if not candidate:
            continue
        path = Path(candidate)
        if _is_stale_cheater_pi_shim(path):
            continue
        return [str(path)]
    return ["pi"]


def run_doctor(cfg: LauncherConfig, opts: LaunchOptions) -> int:
    checks: list[tuple[str, bool, str]] = []
    pi_cmd = resolve_pi_command(cfg)
    pi_path = pi_cmd[0]
    pi_ok = pi_path != "pi" or shutil.which("pi") is not None
    if pi_ok and Path(pi_path).exists() and _is_stale_cheater_pi_shim(Path(pi_path)):
        pi_ok = False
    checks.append(
        (
            "Pi is resolvable",
            pi_ok,
            pi_path if pi_ok else "set CHEATER_PI_COMMAND or install Pi",
        )
    )
    checks.append(
        ("Cheater Pi extension exists", EXTENSION_PATH.is_file(), str(EXTENSION_PATH))
    )
    checks.append(
        (
            "Cheater prompt exists",
            (PROMPTS_DIR / "cheater.md").is_file(),
            str(PROMPTS_DIR / "cheater.md"),
        )
    )
    checks.append(("Cheater skills exist", SKILLS_DIR.is_dir(), str(SKILLS_DIR)))
    checks.append(("Cheater theme exists", THEME_PATH.is_file(), str(THEME_PATH)))
    checks.append(
        ("Current folder readable", os.access(Path.cwd(), os.R_OK), str(Path.cwd()))
    )
    checks.append(
        ("Current folder writable", os.access(Path.cwd(), os.W_OK), str(Path.cwd()))
    )
    checks.append(
        ("Old Python TUI is not entrypoint", True, "cheater delegates to Pi wrapper")
    )
    checks.append(
        (
            "Legacy dual-mode command path disabled",
            True,
            "old subcommands are not primary commands",
        )
    )

    node = shutil.which("node")
    node_ok = False
    node_detail = "node not found"
    if node:
        try:
            r = subprocess.run(
                [node, "--version"], capture_output=True, text=True, timeout=5
            )
            node_detail = r.stdout.strip() or node
            node_ok = r.returncode == 0
        except (OSError, subprocess.SubprocessError):
            node_detail = node
    checks.append(("Node is available", node_ok, node_detail))

    print("Cheater doctor")
    print(f"repo: {Path.cwd()}")
    for name, ok, detail in checks:
        mark = "OK" if ok else "FAIL"
        print(f"[{mark}] {name}: {detail}")
    print()
    print("Pi command:")
    print(
        format_command(
            build_pi_command(cfg, LaunchOptions(no_theme=opts.no_theme, passthrough=()))
        )
    )
    return 0 if all(ok for _, ok, _ in checks) else 1


def print_help() -> None:
    print(
        """Cheater - Pi-based coding agent distribution

Usage:
  cheater [Pi options] [message]
  cheater --doctor
  cheater --version
  cheater --print-pi-command

Cheater opens Pi's TUI with Cheater's extension, prompt, skills, commands, and
theme preloaded. It does not start the old Python TUI or agent loop.

Cheater options:
  --doctor             Check Pi discovery and Cheater package wiring
  --version, -v        Print Cheater version
  --debug              Print the resolved Pi command before launching
  --no-theme           Launch with Cheater behavior but without Cheater theme
  --print-pi-command   Print the exact Pi command and exit
  --help, -h           Show this help

Useful Cheater slash commands inside Pi:
  /cheater  /mission  /fix  /orient  /repro  /evidence  /playbook  /verify  /learn  /delta-bench  /test  /map  /remember  /skills  /traces  /history  /settings  /doctor
"""
    )


def print_missing_pi_message() -> None:
    sys.stderr.write(
        "cheater: Pi was not found.\n"
        "Install Pi or set CHEATER_PI_COMMAND to the Pi executable, then run `cheater --doctor`.\n"
    )


def first_legacy_command(args: Iterable[str]) -> str | None:
    for arg in args:
        if not arg.startswith("-") and arg in LEGACY_COMMANDS:
            return arg
    return None


def format_command(command: Sequence[str]) -> str:
    return subprocess.list2cmdline([str(part) for part in command])


def _coerce_command(value: object) -> list[str] | None:
    if isinstance(value, str) and value.strip():
        return [value]
    if isinstance(value, list) and all(
        isinstance(item, str) and item for item in value
    ):
        return list(value)
    return None


def _coerce_str(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _pi_candidates() -> list[str]:
    candidates: list[str] = []
    seen: set[str] = set()
    for name in ("pi", "pi.cmd", "pi.exe", "pi.bat"):
        found = shutil.which(name)
        if found and found.lower() not in seen:
            seen.add(found.lower())
            candidates.append(found)
    npm_dir = Path(os.environ.get("APPDATA", "")) / "npm"
    for name in ("pi.cmd", "pi.exe", "pi.bat", "pi"):
        path = npm_dir / name
        key = str(path).lower()
        if path.exists() and key not in seen:
            seen.add(key)
            candidates.append(str(path))
    return candidates


def _is_stale_cheater_pi_shim(path: Path) -> bool:
    try:
        if not path.is_file():
            return False
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return False
    if "--wrap-pi" not in text:
        return False
    return True


def _resolve_external_cheater_binary() -> str | None:
    """Resolve a non-Python ``cheater`` binary on PATH, skipping this launcher.

    ``shutil.which("cheater")`` may return this same Python launcher (when
    pip-installed), which would cause ``cheater gym`` to recurse forever.
    We skip any candidate that resolves to the current ``sys.executable`` or
    whose content looks like the Python entry point.
    """
    current = Path(sys.executable).resolve()
    for name in ("cheater", "cheater.cmd", "cheater.exe", "cheater.bat"):
        found = shutil.which(name)
        if not found:
            continue
        resolved = Path(found).resolve()
        try:
            same = resolved == current or resolved.samefile(current)
        except OSError:
            same = str(resolved).lower() == str(current).lower()
        if same:
            continue
        try:
            text = resolved.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            return found
        if "from cheater.pi_launcher import main" in text or "cheater.__main__" in text:
            continue
        return found
    return None


if __name__ == "__main__":
    raise SystemExit(main())

"""Slash command parsing and execution.

Slash commands are entered in the composer. Typing ``/`` opens a
filterable list. Pressing Enter on a suggestion fills in the name;
pressing Enter on a complete command runs it.

The list of known commands lives in :data:`KNOWN_COMMANDS`. The
handler is in :func:`run_slash_command`; it does the actual work by
calling adapter functions and pushing notifications / screens.

Commands are intentionally **internal**: they call the Cheater modules
directly, not the CLI.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from cheater.tui import adapters


# --- public types ---


@dataclass
class SlashResult:
    """The result of running a slash command."""

    ok: bool
    message: str
    side_effect: str = ""  # "open_screen" | "switch_mode" | "" | "start_run"


# --- command registry ---


# A command has:
#   name        : primary name, no leading slash
#   aliases     : list of alternate names
#   description : human-friendly description (shown in /help and the menu)
#   needs_arg   : whether an argument is required
#   run(app, arg) -> SlashResult
@dataclass
class SlashCommand:
    name: str
    aliases: list[str]
    description: str
    needs_arg: bool
    run: Callable[[Any, str], SlashResult]


# Build the registry. We populate the ``run`` functions lazily so this
# module does not pull every backend module at import time.
def _help(app: Any, arg: str) -> SlashResult:
    lines = ["[bold]slash commands[/]"]
    for c in KNOWN_COMMANDS:
        lines.append(f"  [accent]/{c.name}[/]  {c.description}")
    if arg:
        # /help <cmd> -> show details for one
        for c in KNOWN_COMMANDS:
            if c.name == arg or arg in c.aliases:
                lines.append(f"\n[bold]/{c.name}[/] {c.description}")
                if c.aliases:
                    lines.append(f"  aliases: {', '.join('/' + a for a in c.aliases)}")
                lines.append(f"  needs_arg: {c.needs_arg}")
                break
    app.notify("\n".join(lines), timeout=8)
    return SlashResult(ok=True, message="help shown")


def _repair(app: Any, arg: str) -> SlashResult:
    app.action_open_repair()
    return SlashResult(
        ok=True, message="repair screen opened", side_effect="open_screen"
    )


def _map(app: Any, arg: str) -> SlashResult:
    # /map [query] -- build or search
    try:
        root = app.state.project_root
        if arg.strip():
            hits = adapters.search_repo_map(arg.strip(), root, top_k=8)
            msg = (
                "\n".join(
                    f"  {h.get('path')}  ({', '.join(h.get('why') or [])})"
                    for h in hits
                )
                or "(no hits)"
            )
            app.notify(f"repo map hits for {arg!r}:\n{msg}", timeout=8)
            return SlashResult(ok=True, message=f"repo map search: {len(hits)} hits")
        else:
            res = adapters.build_repo_map(root)
            n = len(res.get("files", []))
            app.notify(f"repo map built: {n} files", timeout=6)
            return SlashResult(ok=True, message=f"repo map built: {n} files")
    except Exception as e:
        app.notify(f"/map failed: {e}", severity="error")
        return SlashResult(ok=False, message=str(e))


def _localize(app: Any, arg: str) -> SlashResult:
    if not arg.strip():
        return SlashResult(ok=False, message="usage: /localize <task>")
    try:
        loc = adapters.localize_task(arg.strip(), app.state.project_root)
        if not loc.get("ok"):
            return SlashResult(ok=False, message=loc.get("error", "no result"))
        sus = loc.get("suspected", []) or []
        msg = "\n".join(
            f"  {s.get('path', '?') if isinstance(s, dict) else s}" for s in sus[:10]
        )
        app.notify(f"localized suspects:\n{msg or '(none)'}", timeout=8)
        return SlashResult(ok=True, message=f"{len(sus)} suspects")
    except Exception as e:
        return SlashResult(ok=False, message=str(e))


def _test(app: Any, arg: str) -> SlashResult:
    # /test [cmd] -- run focused tests
    try:
        root = app.state.project_root
        cmd = arg.strip() or adapters.detect_test_command(root)
        if not cmd:
            return SlashResult(ok=False, message="no test command detected")
        r = adapters.run_focused_tests(cmd, root, timeout=120.0)
        status = "PASS" if r.get("ok") else "FAIL"
        app.notify(f"test {status}  rc={r.get('returncode')}  cmd={cmd!r}", timeout=6)
        return SlashResult(ok=bool(r.get("ok")), message=f"test {status}")
    except Exception as e:
        return SlashResult(ok=False, message=str(e))


def _memory(app: Any, arg: str) -> SlashResult:
    app.action_open_memory()
    return SlashResult(
        ok=True, message="memory screen opened", side_effect="open_screen"
    )


def _skills(app: Any, arg: str) -> SlashResult:
    app.action_open_skills()
    return SlashResult(
        ok=True, message="skills screen opened", side_effect="open_screen"
    )


def _trace(app: Any, arg: str) -> SlashResult:
    app.action_open_traces()
    return SlashResult(
        ok=True, message="traces screen opened", side_effect="open_screen"
    )


def _arena(app: Any, arg: str) -> SlashResult:
    app.action_open_arena()
    return SlashResult(
        ok=True, message="arena screen opened", side_effect="open_screen"
    )


def _clear(app: Any, arg: str) -> SlashResult:
    app.action_clear_transcript()
    return SlashResult(ok=True, message="transcript cleared")


def _settings(app: Any, arg: str) -> SlashResult:
    app.action_open_settings()
    return SlashResult(ok=True, message="settings opened", side_effect="open_screen")


def _quit(app: Any, arg: str) -> SlashResult:
    if app.state.is_busy():
        return SlashResult(
            ok=False, message="a run is active; use Ctrl+C to stop it first"
        )
    app.exit()
    return SlashResult(ok=True, message="quit")


def _status(app: Any, arg: str) -> SlashResult:
    app.action_show_status()
    return SlashResult(ok=True, message="status shown")


def _diff(app: Any, arg: str) -> SlashResult:
    app.action_show_diff()
    return SlashResult(ok=True, message="diff shown")


def _chat(app: Any, arg: str) -> SlashResult:
    app.action_switch_mode("chat")
    return SlashResult(ok=True, message="switched to chat", side_effect="switch_mode")


# The full registry, in display order.
KNOWN_COMMANDS: list[SlashCommand] = [
    SlashCommand("help", ["?"], "Show this help", False, _help),
    SlashCommand("chat", [], "Switch to chat mode", False, _chat),
    SlashCommand("repair", ["fix"], "Open the repair screen", False, _repair),
    SlashCommand("map", [], "Build or search the repo map", False, _map),
    SlashCommand(
        "localize",
        [],
        "Localize a bug to suspect files (e.g. /localize <task>)",
        True,
        _localize,
    ),
    SlashCommand("test", [], "Run focused tests", False, _test),
    SlashCommand("memory", [], "Open the memory browser", False, _memory),
    SlashCommand("skills", [], "Open the skills browser", False, _skills),
    SlashCommand("trace", ["traces"], "Open the trace browser", False, _trace),
    SlashCommand("arena", [], "Open the arena dashboard", False, _arena),
    SlashCommand("diff", [], "Show current git diff", False, _diff),
    SlashCommand("status", [], "Show status (config + budget)", False, _status),
    SlashCommand("clear", ["cls"], "Clear the transcript", False, _clear),
    SlashCommand("settings", ["config"], "Open the settings screen", False, _settings),
    SlashCommand("quit", ["exit", "q"], "Exit the cockpit", False, _quit),
]


# --- parsing ---


@dataclass
class ParsedCommand:
    name: str
    arg: str
    raw: str  # original text (without the slash)


def parse_slash_command(text: str) -> ParsedCommand | None:
    """Parse ``/name arg`` into a :class:`ParsedCommand`.

    Returns ``None`` if the text is not a slash command.
    """
    if not text:
        return None
    s = text.strip()
    if not s.startswith("/"):
        return None
    body = s[1:].strip()
    if not body:
        # just "/"; show the menu
        return ParsedCommand(name="", arg="", raw=s)
    parts = body.split(None, 1)
    name = parts[0].lower()
    arg = parts[1] if len(parts) > 1 else ""
    return ParsedCommand(name=name, arg=arg, raw=s)


def find_command(name: str) -> SlashCommand | None:
    if not name:
        return None
    for c in KNOWN_COMMANDS:
        if c.name == name or name in c.aliases:
            return c
    return None


def run_slash_command(app: Any, parsed: ParsedCommand) -> SlashResult:
    """Run a parsed slash command against the app instance."""
    if not parsed.name:
        # bare "/": show a brief help
        return _help(app, "")
    cmd = find_command(parsed.name)
    if cmd is None:
        return SlashResult(ok=False, message=f"unknown command: /{parsed.name}")
    if cmd.needs_arg and not parsed.arg.strip():
        return SlashResult(ok=False, message=f"/{cmd.name} requires an argument")
    try:
        return cmd.run(app, parsed.arg)
    except Exception as e:
        return SlashResult(ok=False, message=f"/{cmd.name} failed: {e}")


# --- autocomplete ---


def slash_completions(prefix: str) -> list[SlashCommand]:
    """Return commands whose name starts with ``prefix`` (without slash)."""
    p = (prefix or "").lstrip("/").lower()
    if not p:
        return list(KNOWN_COMMANDS)
    out = []
    for c in KNOWN_COMMANDS:
        if c.name.startswith(p) or any(a.startswith(p) for a in c.aliases):
            out.append(c)
    return out

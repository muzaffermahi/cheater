"""Cheater Cockpit: the Cheater TUI.

A keyboard-first terminal UI that sits on top of the existing Cheater
backend. It is intentionally a thin layer:

* the agent loop, repair harness, localizer, repo map, context pack,
  failure compressor, trace recorder, memory store, skill store, arena
  loader, and trace distiller are all called directly;
* the TUI never shells out to ``cheater`` subcommands to do real work;
* the line-based REPL in ``cheater.tui`` is kept untouched as a fallback
  for environments without a TTY or without ``textual`` installed.

This package is structured so each file stays small. Public surface:

* :func:`run_cockpit`         -- entry point used by the CLI
* :class:`CheaterCockpit`     -- the main :class:`textual.app.App`
* :data:`MODES`               -- the list of top-level modes
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any

from cheater.tui.events import MODES
from cheater.tui.slash_commands import (
    KNOWN_COMMANDS,
    parse_slash_command,
    run_slash_command,
    SlashResult,
)

_COCKPIT_IMPORT_ERROR: ImportError | None = None

try:
    from cheater.tui.app import CheaterCockpit, run_cockpit
except ImportError as exc:
    _COCKPIT_IMPORT_ERROR = exc
    CheaterCockpit = None  # type: ignore[assignment]

    def run_cockpit(*args: Any, **kwargs: Any) -> int:
        raise ImportError("Cheater Cockpit requires textual") from _COCKPIT_IMPORT_ERROR


def run_tui(cards_path: Path | None = None) -> int:
    """Run the legacy line-based REPL.

    The new Textual package is named ``cheater.tui``, which shadows the
    historical ``cheater/tui.py`` module. Load that file explicitly so
    ``--no-tui`` and cockpit fallback keep working.
    """
    legacy_path = Path(__file__).resolve().parents[1] / "tui.py"
    spec = importlib.util.spec_from_file_location("cheater._legacy_tui", legacy_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"could not load legacy TUI from {legacy_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.run_tui(cards_path)


__all__ = [
    "CheaterCockpit",
    "run_cockpit",
    "run_tui",
    "MODES",
    "KNOWN_COMMANDS",
    "parse_slash_command",
    "run_slash_command",
    "SlashResult",
]

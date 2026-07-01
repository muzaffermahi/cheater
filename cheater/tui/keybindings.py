"""Global keybindings for the Cheater Cockpit.

This module is a single place where we declare bindings so that the
keymap is easy to audit. Bindings are added to the
:class:`~cheater.tui.app.CheaterCockpit` App via
:func:`global_bindings`.

We follow these conventions:

* Ctrl+P        -- command palette
* Ctrl+C        -- interrupt current run
* Ctrl+L        -- clear transcript
* Ctrl+R        -- start repair
* Ctrl+T        -- traces
* Ctrl+M        -- memory
* Ctrl+S        -- skills
* Ctrl+A        -- arena
* Ctrl+I        -- toggle inspector
* Ctrl+J        -- toggle tool stream
* ?             -- help overlay
* q             -- quit (only when not in an input)

The composer and inputs use Enter to submit and Shift+Enter / Alt+Enter
to insert a newline, where the underlying widget supports it.
"""

from __future__ import annotations

from textual.binding import Binding


# Global bindings, applied to the main screen.
GLOBAL_BINDINGS: list[Binding] = [
    Binding("ctrl+p", "palette", "Palette"),
    Binding("ctrl+c", "interrupt", "Interrupt"),
    Binding("ctrl+l", "clear_transcript", "Clear"),
    Binding("ctrl+r", "open_repair", "Repair"),
    Binding("ctrl+t", "open_traces", "Traces"),
    Binding("ctrl+m", "open_memory", "Memory"),
    Binding("ctrl+s", "open_skills", "Skills"),
    Binding("ctrl+a", "open_arena", "Arena"),
    Binding("ctrl+i", "toggle_inspector", "Inspector"),
    Binding("ctrl+j", "toggle_tool_stream", "Tools"),
    Binding("ctrl+k", "open_settings", "Settings"),
    Binding("question_mark", "show_help", "Help"),
    Binding("ctrl+slash", "open_settings", "Settings", show=False),
]


# A help / cheatsheet string, suitable for showing in a modal.
HELP_TEXT: str = """\
[bold]cheater cockpit — keybindings[/]

[accent]global[/]
  Ctrl+P          command palette
  Ctrl+C          interrupt current run
  Ctrl+L          clear transcript
  Ctrl+R          open repair screen
  Ctrl+T          open traces
  Ctrl+M          open memory
  Ctrl+S          open skills
  Ctrl+A          open arena
  Ctrl+I          toggle inspector
  Ctrl+J          toggle tool stream
  Ctrl+K          open settings
  ?               this help overlay
  q               quit (only when not in an input)

[accent]composer[/]
  Enter           submit
  Shift+Enter     newline (if supported by the terminal)
  Up/Down         recall previous / next message

[accent]sidebar[/]
  Click           switch mode
  j/k             next/prev mode

[accent]slash commands[/]
  /help, /chat, /repair, /map, /localize, /test,
  /memory, /skills, /trace, /arena, /diff, /status,
  /clear, /settings, /quit
"""

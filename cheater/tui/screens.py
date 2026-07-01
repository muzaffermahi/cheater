"""Modal screens used by the Cheater Cockpit.

The big, mode-specific screens (memory, traces, repair, etc.) live in
their own files. This module holds the small modals:

* :class:`HelpScreen`   -- the keybinding cheatsheet
* :class:`ConfirmScreen` -- generic yes/no confirmation
"""

from __future__ import annotations

from typing import Any, Callable

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Container, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Button, Static

from cheater.tui.keybindings import HELP_TEXT


class HelpScreen(ModalScreen):
    """Simple help / cheatsheet modal."""

    BINDINGS = [
        Binding("escape", "dismiss", "Close"),
        Binding("?", "dismiss", "Close"),
    ]

    DEFAULT_CSS = """
    HelpScreen { align: center middle; }
    HelpScreen > .modal {
        width: 70%;
        max-width: 100;
        height: auto;
        max-height: 80%;
        background: #1d2128;
        border: thick #61afef;
        padding: 1 2;
    }
    HelpScreen .title { color: #61afef; text-style: bold; padding: 0 0 1 0; }
    HelpScreen .body { padding: 0 0 1 0; }
    HelpScreen .footer { color: #9ba1ad; padding: 1 0 0 0; }
    """

    def compose(self) -> ComposeResult:
        with Container(classes="modal"):
            yield Static("help", classes="title")
            with VerticalScroll(classes="body"):
                yield Static(HELP_TEXT)
            yield Static("press Esc or ? to close", classes="footer")

    def action_dismiss(self) -> None:
        self.dismiss(None)


class ConfirmScreen(ModalScreen):
    """Yes / no confirmation. The chosen label is returned via dismiss()."""

    BINDINGS = [
        Binding("escape", "dismiss", "Cancel"),
        Binding("enter", "accept", "OK"),
    ]

    DEFAULT_CSS = """
    ConfirmScreen { align: center middle; }
    ConfirmScreen > .modal {
        width: 60%;
        max-width: 80;
        height: auto;
        background: #1d2128;
        border: thick #e6c07b;
        padding: 1 2;
    }
    ConfirmScreen .title { color: #e6c07b; text-style: bold; padding: 0 0 1 0; }
    ConfirmScreen .body { padding: 0 0 1 0; }
    ConfirmScreen #buttons { padding: 1 0 0 0; height: 3; }
    """

    def __init__(
        self,
        prompt: str,
        *,
        yes_label: str = "Yes",
        no_label: str = "Cancel",
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self.prompt = prompt
        self.yes_label = yes_label
        self.no_label = no_label
        self._on_yes: Callable[[], None] | None = None

    def compose(self) -> ComposeResult:
        with Container(classes="modal"):
            yield Static("confirm", classes="title")
            yield Static(self.prompt, classes="body")
            with Container(id="buttons"):
                yield Button(self.yes_label, id="yes", variant="warning")
                yield Button(self.no_label, id="no")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "yes":
            self.dismiss(True)
        else:
            self.dismiss(False)

    def action_dismiss(self) -> None:
        self.dismiss(False)

    def action_accept(self) -> None:
        self.dismiss(True)

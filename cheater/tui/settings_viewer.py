"""Settings screen for the Cheater Cockpit."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Container, VerticalScroll
from textual.screen import Screen
from textual.widgets import Input, Static

from cheater.tui import adapters


class SettingsScreen(Screen):
    """View and edit safe, non-secret Cheater settings."""

    BINDINGS = [
        Binding("escape", "back", "Back"),
        Binding("r", "reload", "Reload"),
        Binding("s", "save", "Save"),
    ]

    DEFAULT_CSS = """
    SettingsScreen { layout: vertical; padding: 0 1; background: #16191f; }
    SettingsScreen .header { color: #61afef; text-style: bold; padding: 1 0 0 0; }
    SettingsScreen .hint { color: #9ba1ad; padding: 0 0 1 0; }
    SettingsScreen .section { color: #c678dd; text-style: bold; padding: 1 0 0 0; }
    SettingsScreen .row { height: 3; }
    SettingsScreen .label { color: #9ba1ad; height: 1; }
    SettingsScreen Input { height: 1; }
    SettingsScreen #settings-message { color: #e6c07b; padding: 1 0 0 0; }
    """

    def __init__(self, project_root: str, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.project_root = project_root
        self._cfg: Any | None = None

    def compose(self) -> ComposeResult:
        yield Static("Settings", classes="header")
        yield Static(
            "Edit non-secret fields. Press s to save, r to reload, Esc to close.",
            classes="hint",
        )
        with VerticalScroll(id="settings-body"):
            yield Static("loading...", id="settings-message")
            yield Static("Runtime", classes="section")
            yield self._field("provider", "Provider")
            yield self._field("model", "Model")
            yield self._field("base_url", "Base URL")
            yield self._field("mode", "Mode")
            yield Static("Context and Tracing", classes="section")
            yield self._field("context_budget", "Context budget")
            yield self._field("trace_enabled", "Trace enabled")
            yield self._field("trace_full_prompts", "Full prompt tracing")
            yield self._field("tool_policy_enabled", "Tool policy enabled")
            yield Static("Memory", classes="section")
            yield self._field("memory_mode", "Memory mode")
            yield self._field("memory_top_k", "Memory top_k")
            yield Static("Project", classes="section")
            yield Static(f"[dim]Repo root[/]\n{self.project_root}", classes="row")
            yield self._field("default_test_command", "Default focused test command")

    def on_mount(self) -> None:
        self.refresh_settings()

    def action_back(self) -> None:
        self.app.pop_screen()

    def action_reload(self) -> None:
        self.refresh_settings()
        self._message("reloaded")

    def action_save(self) -> None:
        try:
            cfg = self._cfg or adapters.load_config_for_root(self.project_root)
            cfg.provider.provider = self._value("provider") or "none"
            cfg.provider.model = self._value("model")
            cfg.provider.base_url = self._value("base_url")
            cfg.mode = self._value("mode") or "ask"
            cfg.permissions.mode = cfg.mode
            cfg.arena.context_budget = self._value("context_budget") or "normal"
            cfg.arena.trace_enabled = _as_bool(self._value("trace_enabled"))
            cfg.arena.trace_full_prompts = _as_bool(self._value("trace_full_prompts"))
            cfg.arena.tool_policy_enabled = _as_bool(
                self._value("tool_policy_enabled")
            )
            cfg.memory.mode = self._value("memory_mode") or "balanced"
            cfg.memory.top_k = int(self._value("memory_top_k") or "5")
            cfg.project_root = str(Path(self.project_root).resolve())
            cfg.extra = dict(getattr(cfg, "extra", {}) or {})
            cfg.extra["default_focused_test_command"] = self._value(
                "default_test_command"
            )

            from cheater.config import save_config

            path = Path(self.project_root) / ".cheater" / "config.toml"
            save_config(cfg, path)
            self._cfg = cfg
            self._message(f"saved {path}")
        except Exception as e:
            self._message(f"save failed: {e}")

    def refresh_settings(self) -> None:
        cfg = adapters.load_config_for_root(self.project_root)
        self._cfg = cfg
        safe = adapters.config_to_safe_dict(cfg)
        provider = safe.get("provider", {})
        arena = safe.get("arena", {})
        memory = safe.get("memory", {})
        extra = safe.get("extra", {})

        self._set("provider", provider.get("provider", "none"))
        self._set("model", provider.get("model", ""))
        self._set("base_url", provider.get("base_url", ""))
        self._set("mode", safe.get("mode", "ask"))
        self._set("context_budget", arena.get("context_budget", "normal"))
        self._set("trace_enabled", arena.get("trace_enabled", True))
        self._set("trace_full_prompts", arena.get("trace_full_prompts", False))
        self._set("tool_policy_enabled", arena.get("tool_policy_enabled", True))
        self._set("memory_mode", memory.get("mode", "balanced"))
        self._set("memory_top_k", memory.get("top_k", 5))
        self._set(
            "default_test_command",
            extra.get("default_focused_test_command", ""),
        )
        self._message("API keys and token-like values are hidden and not saved here.")

    def _field(self, field_id: str, label: str) -> Container:
        return Container(
            Static(label, classes="label"),
            Input(id=f"setting-{field_id}"),
            classes="row",
        )

    def _value(self, field_id: str) -> str:
        return self.query_one(f"#setting-{field_id}", Input).value.strip()

    def _set(self, field_id: str, value: Any) -> None:
        self.query_one(f"#setting-{field_id}", Input).value = str(value)

    def _message(self, text: str) -> None:
        self.query_one("#settings-message", Static).update(text)


def _as_bool(value: str) -> bool:
    return str(value).strip().lower() in {"1", "true", "yes", "on", "enabled"}

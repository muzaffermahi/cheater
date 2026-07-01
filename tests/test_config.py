"""Tests for cheater.config (config loader + first-run wizard)."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from cheater.config import (
    CheaterConfig,
    MemoryConfig,
    PermissionsConfig,
    ProviderSettings,
    _toml_dump,
    _toml_load,
    first_run_wizard,
    load_config,
    project_config_path,
    save_config,
    user_config_path,
)


class TestToml(unittest.TestCase):
    def test_round_trip(self):
        d = {"mode": "ask", "memory": {"mode": "balanced", "top_k": "5"}}
        text = _toml_dump(d)
        d2 = _toml_load(text)
        # _toml_load returns top-level as flat dict, but with [section] it nests
        self.assertEqual(d2.get("mode"), "ask")


class TestArenaConfig(unittest.TestCase):
    def test_defaults(self):
        from cheater.config import ArenaDistillConfig

        a = ArenaDistillConfig()
        self.assertTrue(a.trace_enabled)
        self.assertFalse(a.trace_full_prompts)
        self.assertEqual(a.context_budget, "normal")
        self.assertEqual(a.arena_default_cases, ".cheater/eval_cases")
        self.assertTrue(a.distill_min_success_only)
        self.assertTrue(a.tool_policy_enabled)
        self.assertFalse(a.janitor_auto_apply)

    def test_cheater_config_has_arena(self):
        c = CheaterConfig()
        self.assertTrue(c.arena.trace_enabled)
        self.assertEqual(c.arena.context_budget, "normal")

    def test_arena_section_round_trip(self):
        from cheater.config import ArenaDistillConfig, _toml_load

        text = """[arena]
trace_enabled = false
context_budget = small
tool_policy_enabled = false
janitor_auto_apply = true
"""
        d = _toml_load(text)
        c = CheaterConfig.from_dict(d)
        self.assertFalse(c.arena.trace_enabled)
        self.assertEqual(c.arena.context_budget, "small")
        self.assertFalse(c.arena.tool_policy_enabled)
        self.assertTrue(c.arena.janitor_auto_apply)

    def test_int_float_string(self):
        d = _toml_load('a = 5\nb = 1.5\nc = "hi"\nd = true')
        self.assertEqual(d["a"], 5)
        self.assertEqual(d["b"], 1.5)
        self.assertEqual(d["c"], "hi")
        self.assertEqual(d["d"], True)


class TestConfigDataclass(unittest.TestCase):
    def test_defaults(self):
        c = CheaterConfig()
        self.assertEqual(c.mode, "ask")
        self.assertEqual(c.memory.mode, "balanced")
        self.assertEqual(c.provider.provider, "none")
        self.assertEqual(c.permissions.mode, "ask")

    def test_from_dict(self):
        d = {
            "mode": "build",
            "memory": {"mode": "aggressive", "top_k": 10},
            "provider": {"provider": "openai", "model": "x"},
            "permissions": {"allow_shell": True, "auto_yes": True},
        }
        c = CheaterConfig.from_dict(d)
        self.assertEqual(c.mode, "build")
        self.assertEqual(c.memory.mode, "aggressive")
        self.assertEqual(c.memory.top_k, 10)
        self.assertTrue(c.permissions.allow_shell)
        self.assertTrue(c.permissions.auto_yes)

    def test_to_dict_redacts(self):
        c = CheaterConfig()
        c.provider.api_key = "sk-secret-key-1234567890"
        d = c.to_dict()
        self.assertEqual(d["provider"]["api_key"], "***REDACTED***")


class TestSaveLoad(unittest.TestCase):
    def test_save_and_load(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "config.toml"
            c = CheaterConfig(mode="build")
            save_config(c, p)
            self.assertTrue(p.is_file())
            c2 = CheaterConfig.from_dict(_toml_load(p.read_text(encoding="utf-8")))
            self.assertEqual(c2.mode, "build")

    def test_load_missing_uses_defaults(self):
        with tempfile.TemporaryDirectory() as d:
            c = load_config(d)
            self.assertEqual(c.mode, "ask")

    def test_env_overrides(self):
        with tempfile.TemporaryDirectory() as d:
            old = {k: os.environ.get(k) for k in ("CHEATER_PROVIDER", "CHEATER_MODEL")}
            try:
                os.environ["CHEATER_PROVIDER"] = "openai"
                os.environ["CHEATER_MODEL"] = "env-model"
                c = load_config(d)
                self.assertEqual(c.provider.provider, "openai")
                self.assertEqual(c.provider.model, "env-model")
            finally:
                for k, v in old.items():
                    if v is None:
                        os.environ.pop(k, None)
                    else:
                        os.environ[k] = v


class TestFirstRunWizard(unittest.TestCase):
    def test_noninteractive(self):
        c = CheaterConfig()
        c = first_run_wizard(c, noninteractive=True)
        self.assertTrue(c.first_run_done)
        # Defaults are safe: ask mode, no model
        self.assertEqual(c.mode, "ask")
        self.assertEqual(c.provider.provider, "none")


if __name__ == "__main__":
    unittest.main()

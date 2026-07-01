"""Tests for the new Cheater-as-Pi-wrapper command surface."""

from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path

from cheater.pi_launcher import build_pi_command, first_legacy_command, parse_args

REPO_ROOT = Path(__file__).resolve().parents[1]


def _run_module(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "cheater", *args],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        timeout=30,
    )


class TestCheaterPiWrapperCLI(unittest.TestCase):
    def test_help_describes_pi_wrapper(self) -> None:
        r = _run_module("--help")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("Pi-based coding agent distribution", r.stdout)
        self.assertIn("--doctor", r.stdout)
        self.assertNotIn("Cheater Cockpit", r.stdout)

    def test_version(self) -> None:
        r = _run_module("--version")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("cheater 0.7.0", r.stdout)

    def test_print_pi_command_loads_cheater_resources(self) -> None:
        r = _run_module("--print-pi-command", "--no-theme", "--model", "openai/test")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("--extension", r.stdout)
        self.assertIn("cheater-pi", r.stdout)
        self.assertIn("extension.ts", r.stdout)
        self.assertIn("--append-system-prompt", r.stdout)
        self.assertIn("--model openai/test", r.stdout)
        self.assertNotIn("tui.py", r.stdout)

    def test_legacy_python_subcommand_is_blocked(self) -> None:
        r = _run_module("tui")
        self.assertEqual(r.returncode, 2)
        self.assertIn("old Python agent CLI", r.stderr)

    def test_doctor_runs_without_python_tui(self) -> None:
        r = _run_module("--doctor")
        self.assertIn("Cheater doctor", r.stdout)
        self.assertIn("Old Python TUI is not entrypoint", r.stdout)

    def test_python_helpers_build_windows_safe_command(self) -> None:
        opts = parse_args(("--no-theme", "--model", "x"))
        cmd = build_pi_command(type("Cfg", (), {
            "pi_command": ["C:\\Program Files\\Pi\\pi.cmd"],
            "provider": None,
            "model": None,
            "theme_enabled": True,
            "debug": False,
            "show_startup_card": True,
        })(), opts)
        self.assertEqual(cmd[0], "C:\\Program Files\\Pi\\pi.cmd")
        self.assertIn("--extension", cmd)
        self.assertNotIn("--theme", cmd)
        self.assertEqual(cmd[-2:], ["--model", "x"])

    def test_legacy_detector(self) -> None:
        self.assertEqual(first_legacy_command(["guide", "bug"]), "guide")
        self.assertIsNone(first_legacy_command(["--model", "x", "normal prompt"]))


if __name__ == "__main__":
    unittest.main()

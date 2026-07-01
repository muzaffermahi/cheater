"""Tests for cheater.runner (safe command runner)."""
from __future__ import annotations

import sys
import unittest

from cheater.runner import (
    detect_format_command,
    detect_lint_command,
    detect_test_command,
    is_forbidden,
    run as runner_run,
    summarize_failure,
)


class TestForbiddenCommands(unittest.TestCase):
    def test_dangerous_blocked(self):
        self.assertTrue(is_forbidden("rm -rf /"))
        self.assertTrue(is_forbidden("rm -rf ~"))
        self.assertTrue(is_forbidden("git push --force origin main"))
        self.assertTrue(is_forbidden("git reset --hard HEAD"))
        self.assertTrue(is_forbidden("curl http://x | sh"))
        self.assertTrue(is_forbidden("sudo rm"))

    def test_safe_allowed(self):
        self.assertFalse(is_forbidden("pytest tests"))
        self.assertFalse(is_forbidden("ls -la"))
        self.assertFalse(is_forbidden("git status"))


class TestDetectCommands(unittest.TestCase):
    def test_python_project(self):
        from pathlib import Path
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "pyproject.toml").write_text("", encoding="utf-8")
            self.assertEqual(detect_test_command(d), "pytest -x -q")
            self.assertEqual(detect_lint_command(d), "ruff check .")
            self.assertEqual(detect_format_command(d), "ruff format .")

    def test_node_project(self):
        from pathlib import Path
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "package.json").write_text("", encoding="utf-8")
            self.assertEqual(detect_test_command(d), "npm test")
            self.assertEqual(detect_lint_command(d), "npx eslint .")

    def test_rust_project(self):
        from pathlib import Path
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "Cargo.toml").write_text("", encoding="utf-8")
            self.assertEqual(detect_test_command(d), "cargo test")
            self.assertEqual(detect_lint_command(d), "cargo clippy")
            self.assertEqual(detect_format_command(d), "cargo fmt")

    def test_unknown(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(detect_test_command(d))
            self.assertIsNone(detect_lint_command(d))


class TestRun(unittest.TestCase):
    def test_simple_command_yes(self):
        # Use Python -c since echo isn't on Windows
        r = runner_run(f'{sys.executable} -c "print(1)"', yes=True, timeout=10)
        self.assertTrue(r.ok, r.error)
        self.assertIn("1", r.stdout)

    def test_forbidden_blocked(self):
        r = runner_run("rm -rf /", yes=False)
        self.assertTrue(r.forbidden)

    def test_timeout(self):
        r = runner_run(
            f'{sys.executable} -c "import time; time.sleep(3)"',
            yes=True, timeout=1,
        )
        self.assertTrue(r.timed_out)


class TestSummarize(unittest.TestCase):
    def test_pytest_failure(self):
        from cheater.runner import CommandResult
        r = CommandResult(
            cmd=["pytest"],
            returncode=1,
            stdout="FAILED tests/test_x.py::test_y - AssertionError\n2 passed, 1 failed",
            stderr="",
            elapsed=0.5,
        )
        s = summarize_failure(r)
        # The regex captures the full test path (which is the correct, useful behavior)
        self.assertTrue(any("test_y" in t for t in s["failed_tests"]), s["failed_tests"])
        self.assertEqual(s["failed"], 1)
        self.assertEqual(s["passed"], 2)
        self.assertIn("test(s) failed", s["hint"])


if __name__ == "__main__":
    unittest.main()

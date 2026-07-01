"""Tests for cheater.failure_compressor (v0.6)."""
from __future__ import annotations

import unittest

from cheater.failure_compressor import (
    FailureEntry,
    FailureSummary,
    compress_command_result,
    render_failure_for_model,
)


PYTEST_ASSERT_OUTPUT = """\
============================= test session starts ==============================
platform linux -- Python 3.11.4, pytest-7.4.0
collected 1 item
FAILED tests/test_x.py::test_hello - AssertionError: assert 2 == 3
=====
FAILED tests/test_x.py::test_hello - AssertionError: assert 2 == 3
_____________________ test_hello ____________________________________
    def test_hello():
>       assert hello(1) == 3
E       assert 2 == 3
E        +  where 2 = hello(1)
====== 1 failed in 0.05s =====
"""


PYTEST_TWO_FAILED_OUTPUT = """\
FAILED tests/test_a.py::test_one - assert 1 == 2
FAILED tests/test_b.py::test_two - assert 3 == 4
=====
FAILED tests/test_a.py::test_one - assert 1 == 2
_____________________ test_one ____________________________________
>       assert 1 == 2
E       assert 1 == 2
=====
FAILED tests/test_b.py::test_two - assert 3 == 4
_____________________ test_two ____________________________________
>       assert 3 == 4
E       assert 3 == 4
===== 2 failed in 0.10s =====
"""


IMPORT_ERROR_OUTPUT = """\
Traceback (most recent call last):
  File "cheater/foo.py", line 5, in <module>
    from missing_mod import x
ModuleNotFoundError: No module named 'missing_mod'
"""


SYNTAX_ERROR_OUTPUT = """\
  File "cheater/foo.py", line 12
    def hello(
              ^
SyntaxError: unexpected EOF while parsing
"""


GENERIC_RUNTIME_OUTPUT = """\
Traceback (most recent call last):
  File "cheater/foo.py", line 10, in do_thing
    raise ValueError("oh no")
ValueError: oh no
"""


class TestCompressPassing(unittest.TestCase):
    def test_passing_command(self):
        s = compress_command_result("pytest", "all good", "", 0)
        self.assertTrue(s.passed)
        self.assertEqual(s.exit_code, 0)
        self.assertEqual(s.failures, [])
        self.assertEqual(s.summary, "command exited 0")


class TestCompressPytestAssertion(unittest.TestCase):
    def test_basic_assertion(self):
        s = compress_command_result("pytest -x -q", PYTEST_ASSERT_OUTPUT, "", 1)
        self.assertFalse(s.passed)
        self.assertTrue(s.is_test_failure)
        self.assertFalse(s.is_syntax_error)
        self.assertFalse(s.is_import_error)
        self.assertEqual(len(s.failures), 1)
        f = s.failures[0]
        self.assertEqual(f.test, "tests/test_x.py::test_hello")
        self.assertEqual(f.error_type, "AssertionError")
        self.assertIn("2 == 3", f.message)
        self.assertEqual(f.got, "2")
        self.assertEqual(f.expected, "3")
        self.assertGreater(len(f.top_stack_files), 0)

    def test_two_failures(self):
        s = compress_command_result("pytest -x -q", PYTEST_TWO_FAILED_OUTPUT, "", 1)
        self.assertFalse(s.passed)
        self.assertEqual(len(s.failures), 2)
        names = {f.test for f in s.failures}
        self.assertIn("tests/test_a.py::test_one", names)
        self.assertIn("tests/test_b.py::test_two", names)


class TestCompressImportError(unittest.TestCase):
    def test_import_error(self):
        s = compress_command_result("pytest", IMPORT_ERROR_OUTPUT, "", 1)
        self.assertFalse(s.passed)
        self.assertTrue(s.is_import_error)
        self.assertFalse(s.is_syntax_error)
        self.assertFalse(s.is_test_failure)
        self.assertEqual(s.error_type, "ModuleNotFoundError")
        self.assertIn("missing_mod", s.summary)
        self.assertEqual(len(s.failures), 1)
        self.assertEqual(s.failures[0].error_type, "ModuleNotFoundError")
        self.assertIn("cheater/foo.py", s.failures[0].top_stack_files)


class TestCompressSyntaxError(unittest.TestCase):
    def test_syntax_error(self):
        s = compress_command_result("python -c 'import x'", SYNTAX_ERROR_OUTPUT, "", 1)
        self.assertFalse(s.passed)
        self.assertTrue(s.is_syntax_error)
        self.assertEqual(s.error_type, "SyntaxError")
        self.assertIn("cheater/foo.py", s.summary)
        self.assertIn("L12", s.summary)


class TestCompressGenericRuntime(unittest.TestCase):
    def test_value_error(self):
        s = compress_command_result("python -c 'x = 1'", GENERIC_RUNTIME_OUTPUT, "", 1)
        self.assertFalse(s.passed)
        self.assertFalse(s.is_test_failure)
        self.assertFalse(s.is_syntax_error)
        self.assertFalse(s.is_import_error)
        self.assertEqual(s.error_type, "ValueError")
        self.assertIn("oh no", s.summary)
        self.assertIn("cheater/foo.py", s.failures[0].top_stack_files)


class TestRenderFailure(unittest.TestCase):
    def test_render_includes_command(self):
        s = compress_command_result("my-cmd", PYTEST_ASSERT_OUTPUT, "", 1)
        out = render_failure_for_model(s, max_tokens=2000)
        self.assertIn("my-cmd", out)
        self.assertIn("AssertionError", out)
        self.assertIn("TEST_FAILURE", out)
        self.assertIn("HINTS", out)

    def test_render_caps_output(self):
        s = compress_command_result("pytest", PYTEST_ASSERT_OUTPUT, "", 1)
        out = render_failure_for_model(s, max_tokens=200)
        # ~800 chars cap, plus the headers
        self.assertLessEqual(len(out), 1000)

    def test_render_no_failure_is_compact(self):
        s = compress_command_result("pytest", "ok", "", 0)
        out = render_failure_for_model(s, max_tokens=500)
        self.assertIn("command exited 0", out)


class TestFailureEntryDataclass(unittest.TestCase):
    def test_to_dict(self):
        e = FailureEntry(
            test="x", error_type="E", message="m",
            expected="a", got="b",
            top_stack_files=["f.py"],
            likely_relevant_files=["f.py"],
        )
        d = e.to_dict()
        self.assertEqual(d["test"], "x")
        self.assertEqual(d["error_type"], "E")
        self.assertEqual(d["expected"], "a")
        self.assertEqual(d["got"], "b")
        self.assertEqual(d["top_stack_files"], ["f.py"])


class TestAnsiStripping(unittest.TestCase):
    def test_ansi_codes_removed(self):
        # pytest sometimes emits ANSI in failures
        s = compress_command_result("pytest", "FAILED \x1b[31mtests/x.py\x1b[0m\n", "", 1)
        # Just make sure no exception
        self.assertFalse(s.passed)


if __name__ == "__main__":
    unittest.main()

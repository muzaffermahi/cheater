"""Tests for cheater.localizer (v0.6)."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from cheater.localizer import (
    LocalizationResult,
    SuspectedFile,
    SuspectedSymbol,
    collect_localized_context,
    deterministic_localize,
    localize_with_model,
    repair_localization_json,
)
from cheater.repo_map import build_repo_map


class FakeModel:
    """Canned-response model for tests."""
    def __init__(self, responses: list[str]) -> None:
        self._responses = list(responses)
        self._calls: list[list[dict]] = []
        self.name = "fake"

    def chat(self, messages, **opts):
        self._calls.append(list(messages))
        if not self._responses:
            return "<<no more canned responses>>"
        return self._responses.pop(0)


def _make_fake_repo(root: Path) -> None:
    (root / "pkg").mkdir()
    (root / "pkg" / "__init__.py").write_text("", encoding="utf-8")
    (root / "pkg" / "calc.py").write_text(
        "def add(a, b):\n    return a + b\n"
        "def sub(a, b):\n    return a - b\n"
        "class Calculator:\n    def add(self, x, y):\n        return x + y\n",
        encoding="utf-8",
    )
    (root / "pkg" / "io.py").write_text(
        "def read_file(p):\n    return open(p).read()\n",
        encoding="utf-8",
    )
    (root / "tests").mkdir()
    (root / "tests" / "test_calc.py").write_text(
        "from pkg.calc import add\n\ndef test_add():\n    assert add(1, 2) == 3\n",
        encoding="utf-8",
    )


class TestDeterministicLocalize(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        _make_fake_repo(self.tmp)
        self.m = build_repo_map(self.tmp)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_basic(self):
        r = deterministic_localize("Fix add function", "", self.m)
        self.assertEqual(r.source, "deterministic")
        self.assertIsInstance(r.suspected_files, list)
        self.assertIsInstance(r.suspected_symbols, list)
        self.assertIsInstance(r.search_queries, list)
        self.assertIsInstance(r.needed_context, list)
        self.assertIsInstance(r.risk_notes, list)

    def test_traceback_files_ranked_first(self):
        tb = (
            'Traceback (most recent call last):\n'
            '  File "pkg/io.py", line 2, in read_file\n'
            '    return open(p).read()\n'
            'FileNotFoundError: [Errno 2] No such file or directory: \'x\'\n'
        )
        r = deterministic_localize("Fix the read_file error", tb, self.m)
        self.assertGreater(len(r.suspected_files), 0)
        # io.py should be top
        self.assertEqual(r.suspected_files[0].path, "pkg/io.py")
        # Confidence between 0 and 1
        self.assertGreaterEqual(r.suspected_files[0].confidence, 0.5)

    def test_pytest_failed_test_targets_source(self):
        tb = "FAILED tests/test_calc.py::test_add - assert 4 == 5"
        r = deterministic_localize("Fix the failing test", tb, self.m)
        # The test file itself + the source (calc.py) should be near the top
        paths = [sf.path for sf in r.suspected_files]
        self.assertIn("tests/test_calc.py", paths)
        self.assertTrue(any("calc.py" in p for p in paths))

    def test_symbol_name_match(self):
        # task mentions a class name
        r = deterministic_localize("Calculator is broken", "", self.m)
        syms = [(s.name, s.file) for s in r.suspected_symbols]
        self.assertTrue(any("Calculator" in n for n, _ in syms))

    def test_risk_note_for_test_hits(self):
        tb = (
            'Traceback (most recent call last):\n'
            '  File "tests/test_calc.py", line 5, in test_add\n'
            '    assert add(1, 2) == 4\n'
            'AssertionError\n'
        )
        r = deterministic_localize("fix it", tb, self.m)
        joined = " ".join(r.risk_notes).lower()
        self.assertIn("tests", joined)

    def test_search_queries_populated(self):
        r = deterministic_localize("Fix Calculator.add issue", "", self.m)
        self.assertGreater(len(r.search_queries), 0)
        # Tokens from the task should be in search queries
        joined = " ".join(r.search_queries)
        self.assertIn("calculator", joined)

    def test_confidence_in_range(self):
        r = deterministic_localize("Add two numbers using calc", "", self.m)
        for sf in r.suspected_files:
            self.assertGreaterEqual(sf.confidence, 0.0)
            self.assertLessEqual(sf.confidence, 1.0)
        for sym in r.suspected_symbols:
            self.assertGreaterEqual(sym.confidence, 0.0)
            self.assertLessEqual(sym.confidence, 1.0)


class TestRepairJSON(unittest.TestCase):
    def test_plain_json(self):
        self.assertEqual(repair_localization_json('{"a": 1}'), {"a": 1})

    def test_fenced_json(self):
        text = "```json\n{\"a\": 1}\n```"
        self.assertEqual(repair_localization_json(text), {"a": 1})

    def test_prose_around(self):
        text = "Sure! Here is the JSON: {\"a\": 1} done."
        self.assertEqual(repair_localization_json(text), {"a": 1})

    def test_trailing_comma_repair(self):
        text = '{"a": 1, "b": 2,}'
        self.assertEqual(repair_localization_json(text), {"a": 1, "b": 2})

    def test_unrecoverable(self):
        self.assertIsNone(repair_localization_json("not json at all"))
        self.assertIsNone(repair_localization_json(""))


class TestLocalizationResultFromDict(unittest.TestCase):
    def test_validates_correct_json(self):
        d = {
            "suspected_files": [
                {"path": "x.py", "confidence": 0.9, "reason": "because"},
            ],
            "suspected_symbols": [
                {"name": "foo", "file": "x.py", "confidence": 0.7, "reason": "match"},
            ],
            "search_queries": ["foo"],
            "needed_context": ["x.py"],
            "risk_notes": ["do not edit tests"],
        }
        r = LocalizationResult.from_dict(d)
        self.assertEqual(r.suspected_files[0].path, "x.py")
        self.assertEqual(r.suspected_symbols[0].name, "foo")
        self.assertEqual(r.search_queries, ["foo"])

    def test_drops_invalid_files(self):
        d = {
            "suspected_files": [
                {"path": "", "confidence": 0.9},  # empty path
                {"confidence": 0.5},               # missing path
                {"path": "x.py"},                  # missing confidence -> 0.0
            ],
            "suspected_symbols": [],
        }
        r = LocalizationResult.from_dict(d)
        # The first two are dropped (no usable path); only "x.py" remains.
        self.assertEqual(len(r.suspected_files), 1)
        self.assertEqual(r.suspected_files[0].path, "x.py")
        self.assertEqual(r.suspected_files[0].confidence, 0.0)

    def test_clamps_confidence(self):
        d = {
            "suspected_files": [
                {"path": "x.py", "confidence": 5.0},
                {"path": "y.py", "confidence": -1.0},
            ],
        }
        r = LocalizationResult.from_dict(d)
        for sf in r.suspected_files:
            self.assertLessEqual(sf.confidence, 1.0)
            self.assertGreaterEqual(sf.confidence, 0.0)

    def test_rejects_non_dict(self):
        with self.assertRaises(ValueError):
            LocalizationResult.from_dict([])
        with self.assertRaises(ValueError):
            LocalizationResult.from_dict("not a dict")

    def test_empty_payload(self):
        r = LocalizationResult.from_dict({})
        self.assertEqual(r.suspected_files, [])
        self.assertEqual(r.suspected_symbols, [])


class TestLocalizeWithModel(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        _make_fake_repo(self.tmp)
        self.m = build_repo_map(self.tmp)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_valid_json_first_try(self):
        model = FakeModel([
            json.dumps({
                "suspected_files": [
                    {"path": "pkg/calc.py", "confidence": 0.9, "reason": "defines add"},
                ],
                "suspected_symbols": [
                    {"name": "add", "file": "pkg/calc.py", "confidence": 0.85, "reason": "match"},
                ],
                "search_queries": ["def add"],
                "needed_context": ["pkg/calc.py"],
                "risk_notes": [],
            })
        ])
        from cheater.context_pack import build_context_pack
        pack = build_context_pack(task="Fix add", repo_root=self.tmp, include_repo_map=True)
        r = localize_with_model(model, "Fix add", pack)
        self.assertEqual(r.source, "model")
        self.assertEqual(r.suspected_files[0].path, "pkg/calc.py")

    def test_repair_path(self):
        # First call returns invalid; second returns valid
        model = FakeModel([
            '```json\n{"suspected_files": [{"path": "pkg/calc.py", "confidence": 0.7}]}\n```',
        ])
        from cheater.context_pack import build_context_pack
        pack = build_context_pack(task="Fix add", repo_root=self.tmp, include_repo_map=True)
        r = localize_with_model(model, "Fix add", pack)
        # The single response is valid (fenced JSON) so source = "model"
        self.assertEqual(r.source, "model")
        self.assertEqual(r.suspected_files[0].path, "pkg/calc.py")

    def test_fallback_to_deterministic_on_persistent_failure(self):
        # Two totally invalid responses
        model = FakeModel(["not json at all", "still not json"])
        from cheater.context_pack import build_context_pack
        pack = build_context_pack(task="Fix add", repo_root=self.tmp, include_repo_map=True)
        r = localize_with_model(model, "Fix add", pack)
        # Falls back to deterministic
        self.assertEqual(r.source, "deterministic")

    def test_no_model_returns_deterministic(self):
        from cheater.context_pack import build_context_pack
        pack = build_context_pack(task="Fix add", repo_root=self.tmp, include_repo_map=True)
        # Pass None as the model client -> should fall back to deterministic
        r = localize_with_model(None, "Fix add", pack)
        self.assertEqual(r.source, "deterministic")


class TestCollectContext(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        _make_fake_repo(self.tmp)
        self.m = build_repo_map(self.tmp)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_loads_snippets(self):
        r = deterministic_localize("Fix add", "", self.m)
        ctx = collect_localized_context(r, self.tmp, max_chars_per_file=100)
        self.assertIn("pkg/calc.py", ctx)
        self.assertIn("def add", ctx["pkg/calc.py"])

    def test_caps_per_file(self):
        r = deterministic_localize("Fix add", "", self.m)
        ctx = collect_localized_context(r, self.tmp, max_chars_per_file=20)
        for path, content in ctx.items():
            if not content.startswith("("):
                self.assertLessEqual(len(content), 50)  # 20 + truncation suffix

    def test_handles_missing_files(self):
        r = LocalizationResult(suspected_files=[
            SuspectedFile(path="does/not/exist.py", confidence=0.5, reason=""),
        ])
        ctx = collect_localized_context(r, self.tmp)
        self.assertIn("does/not/exist.py", ctx)
        self.assertEqual(ctx["does/not/exist.py"], "(file not found)")


if __name__ == "__main__":
    unittest.main()

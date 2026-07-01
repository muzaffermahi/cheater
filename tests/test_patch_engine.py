"""Tests for cheater.patch_engine (safe patch engine)."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from cheater.patch_engine import (
    apply,
    is_forbidden,
    list_snapshots,
    make_create,
    make_replace,
    preview,
    undo,
)


class TestForbidden(unittest.TestCase):
    def test_forbidden(self):
        self.assertTrue(is_forbidden(".git/x"))
        self.assertTrue(is_forbidden("data/cards/x"))
        self.assertTrue(is_forbidden("_archive/x"))
        self.assertFalse(is_forbidden("cheater/x.py"))


class TestReplace(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.f = self.tmp / "f.txt"
        self.f.write_text("hello world\nfoo bar\n", encoding="utf-8")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_preview(self):
        p = make_replace(str(self.f), "hello", "goodbye")
        diff = preview(p)
        self.assertIn("hello", diff)
        self.assertIn("goodbye", diff)

    def test_apply(self):
        p = make_replace(str(self.f), "hello", "goodbye")
        snap = apply(p)
        self.assertTrue(snap)
        self.assertEqual(self.f.read_text(encoding="utf-8"), "goodbye world\nfoo bar\n")

    def test_undo(self):
        p = make_replace(str(self.f), "hello", "goodbye")
        apply(p)
        ok = undo()
        self.assertTrue(ok)
        self.assertEqual(self.f.read_text(encoding="utf-8"), "hello world\nfoo bar\n")

    def test_old_not_unique(self):
        f = self.tmp / "f2.txt"
        f.write_text("foo\nfoo\n", encoding="utf-8")
        p = make_replace(str(f), "foo", "bar")
        with self.assertRaises(ValueError):
            apply(p)

    def test_old_not_found(self):
        p = make_replace(str(self.f), "missing", "x")
        with self.assertRaises(ValueError):
            apply(p)


class TestCreate(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_create_new(self):
        new = self.tmp / "new.txt"
        p = make_create(str(new), "hello\nworld\n")
        apply(p)
        self.assertTrue(new.is_file())
        self.assertEqual(new.read_text(encoding="utf-8"), "hello\nworld\n")


class TestForbiddenPath(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.bad = self.tmp / "data" / "cards" / "x.jsonl"
        self.bad.parent.mkdir(parents=True)
        self.bad.write_text("forbidden\n", encoding="utf-8")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_refuses_forbidden(self):
        p = make_replace(str(self.bad), "forbidden", "ok")
        with self.assertRaises(PermissionError):
            apply(p)


class TestSnapshots(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.f = self.tmp / "f.txt"
        self.f.write_text("hello\n", encoding="utf-8")
        # Clear the in-memory snapshot list so other tests' state doesn't leak
        from cheater.patch_engine import _SNAPSHOTS
        _SNAPSHOTS.clear()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)
        from cheater.patch_engine import _SNAPSHOTS
        _SNAPSHOTS.clear()

    def test_list_snapshots(self):
        p = make_replace(str(self.f), "hello", "world")
        apply(p)
        snaps = list_snapshots()
        self.assertEqual(len(snaps), 1)
        self.assertEqual(snaps[0]["path"], str(self.f))


if __name__ == "__main__":
    unittest.main()

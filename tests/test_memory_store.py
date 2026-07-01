"""Tests for cheater.memory_store (v0.5 agent-curated memory)."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from cheater.memory_store import MemoryEntry, MemoryStore, _tokenize


class TestTokenize(unittest.TestCase):
    def test_basic(self):
        toks = _tokenize("hello world hello")
        self.assertEqual(toks, ["hello", "world", "hello"])

    def test_drops_stopwords(self):
        toks = _tokenize("the quick brown fox")
        # "the" is a stopword
        self.assertNotIn("the", toks)
        self.assertIn("quick", toks)

    def test_drops_short(self):
        toks = _tokenize("a I be")
        # Single chars dropped (a, I are 1 char)
        self.assertEqual(toks, [])

    def test_empty(self):
        self.assertEqual(_tokenize(""), [])
        self.assertEqual(_tokenize(None), [])

    def test_keeps_numbers(self):
        toks = _tokenize("pydantic 2 v2")
        # "2" and "v2" are both valid tokens
        self.assertIn("pydantic", toks)
        self.assertIn("v2", toks)


class TestMemoryStoreCRUD(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.store = MemoryStore(self.tmp)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_add_returns_id(self):
        mem_id = self.store.add("test memory")
        self.assertTrue(mem_id)
        self.assertEqual(len(self.store), 1)

    def test_add_with_tags(self):
        mem_id = self.store.add("pydantic v2", tags=["python", "pydantic"])
        entry = self.store.get(mem_id)
        self.assertIn("python", entry.tags)
        self.assertIn("pydantic", entry.tags)

    def test_add_empty_text_raises(self):
        with self.assertRaises(ValueError):
            self.store.add("")
        with self.assertRaises(ValueError):
            self.store.add("   ")

    def test_dedup_same_text(self):
        id1 = self.store.add("the same text")
        id2 = self.store.add("the same text")
        self.assertEqual(id1, id2)  # dedup: same id
        self.assertEqual(len(self.store), 1)
        # But use_count was bumped
        entry = self.store.get(id1)
        self.assertGreaterEqual(entry.use_count, 1)

    def test_get_returns_none_for_missing(self):
        self.assertIsNone(self.store.get("nonexistent"))

    def test_remove_by_id(self):
        mem_id = self.store.add("to be removed")
        count = self.store.remove(memory_id=mem_id)
        self.assertEqual(count, 1)
        self.assertEqual(len(self.store), 0)
        self.assertIsNone(self.store.get(mem_id))

    def test_remove_by_id_missing(self):
        count = self.store.remove(memory_id="nonexistent")
        self.assertEqual(count, 0)

    def test_remove_by_query(self):
        self.store.add("django migration fails on python 3.12")
        count = self.store.remove(query="django migration")
        self.assertEqual(count, 1)
        self.assertEqual(len(self.store), 0)

    def test_remove_no_args(self):
        self.store.add("test")
        count = self.store.remove()
        self.assertEqual(count, 0)

    def test_touch_bumps_use_count(self):
        mem_id = self.store.add("touched often")
        for _ in range(3):
            self.store.touch(mem_id)
        entry = self.store.get(mem_id)
        self.assertEqual(entry.use_count, 3)

    def test_contains(self):
        mem_id = self.store.add("test")
        self.assertIn(mem_id, self.store)
        self.assertNotIn("nope", self.store)


class TestMemoryStoreSearch(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.store = MemoryStore(self.tmp)
        self.store.add("django migration fails on python 3.12", tags=["python", "django"])
        self.store.add("pytest fixture with module scope is faster", tags=["pytest"])
        self.store.add("pydantic v2 uses field_validator", tags=["python", "pydantic"])
        self.store.add("the user prefers concise answers", tags=["user"])

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_search_by_keyword(self):
        hits = self.store.search("django", top_k=5)
        self.assertEqual(len(hits), 1)
        self.assertIn("django", hits[0]["text"])

    def test_search_ranking(self):
        hits = self.store.search("python", top_k=5)
        # Multiple hits possible; "python" should be in the top entries
        self.assertGreater(len(hits), 1)
        # The hit text should contain python-related terms
        texts = " ".join(h["text"] for h in hits)
        self.assertIn("python", texts)

    def test_search_no_match(self):
        hits = self.store.search("nonexistent_keyword_xyz", top_k=5)
        self.assertEqual(hits, [])

    def test_search_empty_query(self):
        hits = self.store.search("", top_k=5)
        self.assertEqual(hits, [])
        # Stopword-only queries also return []
        hits = self.store.search("the is a", top_k=5)
        self.assertEqual(hits, [])

    def test_search_top_k(self):
        hits = self.store.search("python", top_k=1)
        self.assertEqual(len(hits), 1)

    def test_search_includes_score(self):
        hits = self.store.search("django", top_k=5)
        self.assertIn("_score", hits[0])
        self.assertGreater(hits[0]["_score"], 0)

    def test_search_uses_use_count(self):
        mem_id = "django migration fails on python 3.12"
        # Bump use_count
        entry = None
        for e in self.store.all():
            if e.text == mem_id:
                entry = e
                break
        for _ in range(5):
            self.store.touch(entry.id)
        # Now search for "django" — the bumped entry should rank high
        hits = self.store.search("django", top_k=5)
        self.assertEqual(hits[0]["text"], mem_id)


class TestMemoryStoreForPrompt(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.store = MemoryStore(self.tmp)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_empty_returns_empty_string(self):
        self.assertEqual(self.store.for_prompt(), "")

    def test_returns_formatted_block(self):
        self.store.add("a memory", tags=["test"])
        block = self.store.for_prompt()
        self.assertIn("CURATED MEMORIES", block)
        self.assertIn("a memory", block)
        self.assertIn("test", block)

    def test_query_filter(self):
        self.store.add("django migration fix")
        self.store.add("pytest speed")
        block = self.store.for_prompt(query="django", top_k=1)
        self.assertIn("django", block)
        self.assertNotIn("pytest", block)


class TestMemoryStorePersistence(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_persistence_across_instances(self):
        s1 = MemoryStore(self.tmp)
        s1.add("persisted memory", tags=["test"])
        mem_id = list(s1._entries.keys())[0]
        # New instance, same path
        s2 = MemoryStore(self.tmp)
        self.assertEqual(len(s2), 1)
        entry = s2.get(mem_id)
        self.assertIsNotNone(entry)
        self.assertEqual(entry.text, "persisted memory")

    def test_persists_use_count(self):
        s1 = MemoryStore(self.tmp)
        mem_id = s1.add("touched")
        for _ in range(3):
            s1.touch(mem_id)
        s2 = MemoryStore(self.tmp)
        entry = s2.get(mem_id)
        self.assertEqual(entry.use_count, 3)


class TestMemoryStoreStats(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.store = MemoryStore(self.tmp)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def test_stats_empty(self):
        s = self.store.stats()
        self.assertEqual(s["count"], 0)
        self.assertEqual(s["total_uses"], 0)

    def test_stats_with_entries(self):
        self.store.add("a", source="manual")
        self.store.add("b", source="session")
        self.store.add("c", source="manual")
        s = self.store.stats()
        self.assertEqual(s["count"], 3)
        self.assertEqual(s["top_sources"]["manual"], 2)
        self.assertEqual(s["top_sources"]["session"], 1)


if __name__ == "__main__":
    unittest.main()

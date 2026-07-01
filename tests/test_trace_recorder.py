"""Tests for cheater.trace_recorder (v0.7)."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from cheater.trace_recorder import (
    TraceRecorder,
    load_trace,
    redact_trace,
    summarize_trace,
)


class TestTraceRecorder(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.rec = TraceRecorder(run_id="test01", root_dir=self.tmp)

    def tearDown(self):
        try:
            self.rec.close()
        except Exception:
            pass
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_records_events(self):
        self.rec.record("run_start", {"task": "fix bug"})
        self.rec.record("model_output", {"parsed_action": {"action": "finish"}})
        self.rec.close()
        events = load_trace(self.rec.path)
        self.assertEqual(len(events), 2)
        self.assertEqual(events[0]["event"], "run_start")
        self.assertEqual(events[1]["event"], "model_output")
        self.assertEqual(events[0]["payload"]["task"], "fix bug")

    def test_prompt_excerpt_only_by_default(self):
        long = "x" * 1000
        self.rec.record("model_prompt", {"prompt": long})
        self.rec.close()
        events = load_trace(self.rec.path)
        payload = events[0]["payload"]
        # Default: store excerpt, not full prompt
        self.assertIn("prompt_excerpt", payload)
        self.assertNotIn("prompt", payload)
        # Hash is always present
        self.assertIn("prompt_hash", payload)
        self.assertEqual(len(payload["prompt_hash"]), 16)

    def test_full_prompt_when_enabled(self):
        rec2 = TraceRecorder(
            run_id="full",
            root_dir=self.tmp,
            store_prompts=True,
            overwrite=True,
        )
        rec2.record("model_prompt", {"prompt": "hi"})
        rec2.close()
        events = load_trace(rec2.path)
        self.assertIn("prompt", events[0]["payload"])

    def test_load_tolerates_partial(self):
        self.rec.record("a", {"x": 1})
        self.rec.close()
        # Corrupt the last line
        with self.rec.path.open("a", encoding="utf-8") as f:
            f.write("{not valid json\n")
        events = load_trace(self.rec.path)
        # At least the first event must be loaded; corruption tolerated
        self.assertGreaterEqual(len(events), 1)
        self.assertEqual(events[0]["event"], "a")

    def test_redact_safe(self):
        trace = [
            {
                "event": "model_prompt",
                "payload": {
                    "prompt": "Use api_key=sk-abcdef1234567890 and Bearer abcdefghijkl"
                },
            },
        ]
        out = redact_trace(trace, mode="safe")
        self.assertNotIn("sk-abcdef1234567890", json.dumps(out))
        self.assertNotIn("abcdefghijkl", json.dumps(out))
        self.assertIn("REDACTED", json.dumps(out))

    def test_redact_strict_drops_excerpts(self):
        trace = [
            {
                "event": "model_prompt",
                "payload": {"prompt_excerpt": "hello", "prompt_hash": "abc"},
            },
        ]
        out = redact_trace(trace, mode="strict")
        self.assertNotIn("prompt_excerpt", out[0]["payload"])

    def test_summarize(self):
        self.rec.record("run_start", {"task": "x"})
        self.rec.record(
            "model_output",
            {
                "parsed_action": {"action": "read_file"},
                "tokens_est": 10,
            },
        )
        self.rec.record("run_finished", {"success": True, "finished_by": "finish"})
        self.rec.close()
        events = load_trace(self.rec.path)
        s = summarize_trace(events)
        self.assertEqual(s["event_count"], 3)
        self.assertEqual(s["actions"], ["read_file"])
        self.assertEqual(s["model_call_count"], 0)  # 0 because no model_prompt
        self.assertEqual(s["finished_by"], "finish")
        self.assertTrue(s["success"])

    def test_close_creates_latest_copy(self):
        self.rec.record("run_start", {})
        self.rec.close()
        latest = self.tmp / ".cheater" / "traces" / "latest.jsonl"
        # On Windows we copy; on POSIX we symlink. Either way, file exists.
        self.assertTrue(latest.exists())


if __name__ == "__main__":
    unittest.main()

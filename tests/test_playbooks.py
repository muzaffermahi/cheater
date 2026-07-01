"""Tests for cheater.playbooks. NO network, no real processes."""

from __future__ import annotations

import unittest

from cheater.playbooks import (
    Playbook,
    PlaybookKind,
    default_playbooks,
    playbook_for_kind,
    select_playbook,
    worker_brief_for,
)


class TestDefaultPlaybooks(unittest.TestCase):
    def test_all_concrete_kinds_have_playbooks(self):
        pbs = default_playbooks()
        # GENERIC is a sentinel used as a fallback; it does not need
        # its own playbook. Every concrete kind must be present.
        for kind in PlaybookKind:
            if kind == PlaybookKind.GENERIC:
                continue
            self.assertIn(kind, pbs)
            self.assertIsInstance(pbs[kind], Playbook)

    def test_playbook_for_kind_falls_back_to_cli(self):
        # Construct a playbook library missing the WEBAPP kind.
        pbs = default_playbooks()
        pbs.pop(PlaybookKind.WEBAPP, None)
        pb = playbook_for_kind(PlaybookKind.WEBAPP, playbooks=pbs)
        self.assertIsNotNone(pb)
        # Falls back to a known kind.
        self.assertIn(pb.kind, pbs)


class TestSelectPlaybook(unittest.TestCase):
    def test_selects_webapp_for_playwright(self):
        pb = select_playbook("Run a Playwright test against the dev server")
        self.assertEqual(pb.kind, PlaybookKind.WEBAPP)

    def test_selects_frontend_for_npm_test(self):
        pb = select_playbook("Run npm test on the frontend")
        self.assertEqual(pb.kind, PlaybookKind.FRONTEND_BUILD)

    def test_selects_backend_for_fastapi(self):
        pb = select_playbook("Add a FastAPI endpoint and test it")
        self.assertEqual(pb.kind, PlaybookKind.BACKEND_API)

    def test_selects_cli_for_pypi_publish(self):
        pb = select_playbook("Update the CLI and publish to pypi")
        # The 'cli' tag should win.
        self.assertEqual(pb.kind, PlaybookKind.CLI_PACKAGE)

    def test_selects_visual_for_screenshot(self):
        pb = select_playbook("Add a screenshot snapshot test")
        self.assertEqual(pb.kind, PlaybookKind.VISUAL_SNAPSHOT)

    def test_selects_fullstack_for_monorepo(self):
        pb = select_playbook("Update the monorepo: frontend and backend")
        self.assertEqual(pb.kind, PlaybookKind.FULLSTACK_DEV)

    def test_selects_migration_for_deprecation(self):
        pb = select_playbook("Fix the deprecation warning from the API migration")
        self.assertEqual(pb.kind, PlaybookKind.DOCS_OR_API_MIGRATION)

    def test_empty_falls_back_to_cli(self):
        pb = select_playbook("")
        self.assertEqual(pb.kind, PlaybookKind.CLI_PACKAGE)

    def test_unrelated_text_falls_back_to_cli(self):
        pb = select_playbook("hello world")
        self.assertEqual(pb.kind, PlaybookKind.CLI_PACKAGE)


class TestWorkerBrief(unittest.TestCase):
    def test_brief_contains_invariants(self):
        pb = select_playbook("Run a Playwright test")
        brief = worker_brief_for(pb)
        self.assertIn("PLAYBOOK", brief)
        self.assertIn("INVARIANTS", brief)
        self.assertIn("FOCUS PATHS", brief)
        # Webapp invariant: "Do not start or stop the dev server"
        self.assertIn("dev server", brief.lower())

    def test_brief_lists_focus_paths(self):
        pb = default_playbooks()[PlaybookKind.WEBAPP]
        brief = worker_brief_for(pb)
        # focus_paths should be embedded
        self.assertTrue(any(p in brief for p in pb.focus_paths))


if __name__ == "__main__":
    unittest.main()

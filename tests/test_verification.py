"""Tests for cheater.verification. NO network, no real processes."""

from __future__ import annotations

import time
import unittest
from typing import Any

from cheater.lifecycle import (
    FailureClass,
    OwnedProcess,
    ProcessRegistry,
    ProcessStatus,
)
from cheater.verification import (
    RunOutcome,
    StageResult,
    StageSpec,
    VerificationContext,
    VerificationMachine,
    VerificationStage,
    VerificationStatus,
    default_backend_api_plan,
    default_cli_plan,
    default_webapp_plan,
    is_terminal_verified,
    make_collect_artifacts_handler,
    make_run_command_handler,
    make_stop_services_handler,
    make_summarize_handler,
    make_workspace_identity_handler,
    required_stages_for,
    workspace_identity_check,
)


class TestWorkspaceIdentityCheck(unittest.TestCase):
    def test_match_passes(self):
        ok, mismatch = workspace_identity_check("sig-1", "sig-1")
        self.assertTrue(ok)
        self.assertIsNone(mismatch)

    def test_mismatch_fails(self):
        ok, mismatch = workspace_identity_check("sig-A", "sig-B")
        self.assertFalse(ok)
        self.assertIsNotNone(mismatch)
        self.assertEqual(mismatch.observed, "sig-A")
        self.assertEqual(mismatch.expected, "sig-B")
        self.assertIn("different", mismatch.evidence.lower())

    def test_no_probe_passes_softly(self):
        ok, mismatch = workspace_identity_check(None, "sig")
        self.assertTrue(ok)
        self.assertIsNone(mismatch)


class TestDefaultPlans(unittest.TestCase):
    def test_webapp_plan_required_stages(self):
        plan = default_webapp_plan()
        req = required_stages_for(plan)
        # Required stages for a webapp.
        for must_have in (
            VerificationStage.PREPARE_ENV,
            VerificationStage.START_SERVICES,
            VerificationStage.WORKSPACE_IDENTITY,
            VerificationStage.STOP_SERVICES,
            VerificationStage.SUMMARIZE,
        ):
            self.assertIn(must_have, req)

    def test_cli_plan_includes_focused_and_full_tests(self):
        plan = default_cli_plan()
        req = required_stages_for(plan)
        self.assertIn(VerificationStage.FOCUSED_TESTS, req)
        self.assertIn(VerificationStage.FULL_TESTS, req)
        # CLI does not need a dev server.
        self.assertNotIn(VerificationStage.START_SERVICES, req)

    def test_backend_api_plan_has_workspace_identity(self):
        plan = default_backend_api_plan()
        req = required_stages_for(plan)
        self.assertIn(VerificationStage.WORKSPACE_IDENTITY, req)
        self.assertIn(VerificationStage.STOP_SERVICES, req)


class TestVerificationContext(unittest.TestCase):
    def test_construction_with_registry(self):
        registry = ProcessRegistry()
        ctx = VerificationContext(
            repo_root="/tmp",
            workspace_sig="sig",
            registry=registry,
        )
        self.assertIs(ctx.registry, registry)


class TestHandlers(unittest.TestCase):
    def test_run_command_handler_marks_skipped_without_command(self):
        ctx = VerificationContext(
            repo_root="/tmp", workspace_sig="sig", registry=ProcessRegistry()
        )
        handler = make_run_command_handler(runner=lambda *a, **k: None)
        result = handler(ctx, StageSpec(stage=VerificationStage.FOCUSED_TESTS))
        self.assertEqual(result.status, VerificationStatus.SKIPPED)

    def test_run_command_handler_ok(self):
        ctx = VerificationContext(
            repo_root="/tmp", workspace_sig="sig", registry=ProcessRegistry()
        )
        ctx.stage_outputs[VerificationStage.START_SERVICES] = StageResult(
            stage=VerificationStage.START_SERVICES,
            status=VerificationStatus.OK,
            signals={"next_cmd": "pytest tests/test_x.py"},
        )
        runner = lambda cmd, **k: RunOutcome(
            cmd=cmd, returncode=0, stdout="1 passed", stderr="", elapsed=0.1
        )
        handler = make_run_command_handler(runner=runner)
        result = handler(ctx, StageSpec(stage=VerificationStage.FOCUSED_TESTS))
        self.assertEqual(result.status, VerificationStatus.OK)
        self.assertEqual(result.signals["exit_code"], 0)

    def test_run_command_handler_classifies_failure(self):
        ctx = VerificationContext(
            repo_root="/tmp", workspace_sig="sig", registry=ProcessRegistry()
        )
        ctx.stage_outputs[VerificationStage.START_SERVICES] = StageResult(
            stage=VerificationStage.START_SERVICES,
            status=VerificationStatus.OK,
            signals={"next_cmd": "pytest"},
        )
        runner = lambda cmd, **k: RunOutcome(
            cmd=cmd,
            returncode=1,
            stdout="AssertionError: expected 1 to equal 2",
            stderr="",
            elapsed=0.1,
        )
        handler = make_run_command_handler(runner=runner)
        result = handler(ctx, StageSpec(stage=VerificationStage.FOCUSED_TESTS))
        self.assertEqual(result.status, VerificationStatus.FAILED)
        self.assertEqual(result.failure_class, FailureClass.APP_BUG)

    def test_run_command_handler_timeout(self):
        ctx = VerificationContext(
            repo_root="/tmp", workspace_sig="sig", registry=ProcessRegistry()
        )
        ctx.stage_outputs[VerificationStage.START_SERVICES] = StageResult(
            stage=VerificationStage.START_SERVICES,
            status=VerificationStatus.OK,
            signals={"next_cmd": "pytest"},
        )
        runner = lambda cmd, **k: RunOutcome(
            cmd=cmd,
            returncode=-1,
            stdout="",
            stderr="",
            elapsed=99.0,
            timed_out=True,
        )
        handler = make_run_command_handler(runner=runner)
        result = handler(ctx, StageSpec(stage=VerificationStage.FOCUSED_TESTS))
        self.assertEqual(result.status, VerificationStatus.TIMED_OUT)
        self.assertEqual(result.failure_class, FailureClass.SERVER_RUNTIME)

    def test_workspace_identity_handler_pass(self):
        registry = ProcessRegistry()
        ctx = VerificationContext(
            repo_root="/tmp",
            workspace_sig="current",
            registry=registry,
            served_workspace_probe=lambda: "current",
        )
        handler = make_workspace_identity_handler()
        result = handler(ctx, StageSpec(stage=VerificationStage.WORKSPACE_IDENTITY))
        self.assertEqual(result.status, VerificationStatus.OK)

    def test_workspace_identity_handler_detects_mismatch(self):
        registry = ProcessRegistry()
        ctx = VerificationContext(
            repo_root="/tmp",
            workspace_sig="current",
            registry=registry,
            served_workspace_probe=lambda: "stale-checkout",
        )
        handler = make_workspace_identity_handler()
        result = handler(ctx, StageSpec(stage=VerificationStage.WORKSPACE_IDENTITY))
        self.assertEqual(result.status, VerificationStatus.FAILED)
        self.assertEqual(result.failure_class, FailureClass.STALE_WORKSPACE)
        self.assertEqual(len(ctx.mismatches), 1)

    def test_workspace_identity_handler_skipped_without_probe(self):
        ctx = VerificationContext(
            repo_root="/tmp", workspace_sig="x", registry=ProcessRegistry()
        )
        handler = make_workspace_identity_handler()
        result = handler(ctx, StageSpec(stage=VerificationStage.WORKSPACE_IDENTITY))
        self.assertEqual(result.status, VerificationStatus.SKIPPED)

    def test_stop_services_handler(self):
        registry = ProcessRegistry()
        stopped: list[str] = []
        registry.register_process(
            OwnedProcess(
                process_id="p",
                label="vite",
                cmd="vite",
                kind=__import__(
                    "cheater.lifecycle", fromlist=["CommandKind"]
                ).CommandKind.DEV_SERVER,
                started_at=0.0,
                stop=lambda: stopped.append("p"),
            )
        )
        ctx = VerificationContext(
            repo_root="/tmp", workspace_sig="x", registry=registry
        )
        result = make_stop_services_handler()(
            ctx, StageSpec(stage=VerificationStage.STOP_SERVICES)
        )
        self.assertEqual(result.status, VerificationStatus.OK)
        self.assertIn("vite", result.signals["stopped"])

    def test_collect_artifacts_handler(self):
        ctx = VerificationContext(
            repo_root="/tmp", workspace_sig="x", registry=ProcessRegistry()
        )
        ctx.artifacts = ["verification.log", "test-output.txt"]
        result = make_collect_artifacts_handler()(
            ctx, StageSpec(stage=VerificationStage.COLLECT_ARTIFACTS)
        )
        self.assertEqual(result.status, VerificationStatus.OK)
        self.assertEqual(len(result.artifacts), 2)

    def test_summarize_handler_counts(self):
        ctx = VerificationContext(
            repo_root="/tmp", workspace_sig="x", registry=ProcessRegistry()
        )
        ctx.stage_outputs[VerificationStage.SMOKE] = StageResult(
            stage=VerificationStage.SMOKE, status=VerificationStatus.OK, summary="ok"
        )
        ctx.stage_outputs[VerificationStage.FOCUSED_TESTS] = StageResult(
            stage=VerificationStage.FOCUSED_TESTS,
            status=VerificationStatus.FAILED,
            summary="bad",
        )
        result = make_summarize_handler()(
            ctx, StageSpec(stage=VerificationStage.SUMMARIZE)
        )
        self.assertEqual(result.signals["ok"], 1)
        self.assertEqual(result.signals["fail"], 1)


class TestVerificationMachine(unittest.TestCase):
    def _ctx(self) -> VerificationContext:
        return VerificationContext(
            repo_root="/tmp",
            workspace_sig="sig",
            registry=ProcessRegistry(),
        )

    def test_missing_required_handler_marks_failed(self):
        plan = [StageSpec(stage=VerificationStage.PREPARE_ENV, required=True)]
        results = VerificationMachine(plan, {}, self._ctx()).run()
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].status, VerificationStatus.FAILED)

    def test_optional_missing_handler_marks_skipped(self):
        plan = [StageSpec(stage=VerificationStage.SCORING, required=False)]
        results = VerificationMachine(plan, {}, self._ctx()).run()
        self.assertEqual(results[0].status, VerificationStatus.SKIPPED)

    def test_required_failure_short_circuits_remaining(self):
        plan = [
            StageSpec(stage=VerificationStage.PREPARE_ENV, required=True),
            StageSpec(stage=VerificationStage.SMOKE, required=True),
        ]
        handlers = {
            VerificationStage.PREPARE_ENV: lambda ctx, spec: StageResult(
                stage=spec.stage,
                status=VerificationStatus.FAILED,
                summary="bad",
            ),
        }
        results = VerificationMachine(plan, handlers, self._ctx()).run()
        # The first one is the failed required, the second is skipped.
        self.assertEqual(results[0].status, VerificationStatus.FAILED)
        self.assertEqual(results[1].status, VerificationStatus.SKIPPED)
        self.assertEqual(len(results), 2)

    def test_full_run_with_all_ok(self):
        plan = [
            StageSpec(stage=VerificationStage.SMOKE, required=True),
            StageSpec(stage=VerificationStage.SUMMARIZE, required=True),
        ]
        handlers = {
            VerificationStage.SMOKE: lambda ctx, spec: StageResult(
                stage=spec.stage, status=VerificationStatus.OK, summary="ok"
            ),
            VerificationStage.SUMMARIZE: lambda ctx, spec: StageResult(
                stage=spec.stage, status=VerificationStatus.OK, summary="ok"
            ),
        }
        results = VerificationMachine(plan, handlers, self._ctx()).run()
        self.assertEqual(len(results), 2)
        self.assertTrue(all(r.status == VerificationStatus.OK for r in results))

    def test_required_failure_forces_terminal_decision(self):
        ctx = self._ctx()
        # Build a webapp-like plan, fail a required stage in the middle.
        plan = default_webapp_plan()

        def ok_handler(ctx, spec):
            return StageResult(
                stage=spec.stage, status=VerificationStatus.OK, summary="ok"
            )

        def fail_handler(ctx, spec):
            return StageResult(
                stage=spec.stage,
                status=VerificationStatus.FAILED,
                summary="bad",
                failure_class=FailureClass.APP_BUG,
            )

        handlers = {}
        for stage in plan:
            handlers[stage.stage] = (
                fail_handler if stage.stage == VerificationStage.SMOKE else ok_handler
            )
        results = VerificationMachine(plan, handlers, ctx).run()
        # SMOKE comes after PREPARE_ENV / START_SERVICES / WORKSPACE_IDENTITY
        # in the webapp plan. So stages before SMOKE run normally and
        # stages after SMOKE must be short-circuited to SKIPPED.
        smoke_idx = next(
            i for i, r in enumerate(results) if r.stage == VerificationStage.SMOKE
        )
        for i, r in enumerate(results):
            if i <= smoke_idx:
                continue
            self.assertEqual(
                r.status,
                VerificationStatus.SKIPPED,
                f"expected short-circuit after SMOKE, got {r.stage}={r.status}",
            )
        # And terminal verification should be False.
        self.assertFalse(is_terminal_verified(results))


class TestTerminalVerified(unittest.TestCase):
    def test_empty_results_not_verified(self):
        self.assertFalse(is_terminal_verified([]))

    def test_all_required_ok_is_verified(self):
        results = [
            StageResult(stage=VerificationStage.SMOKE, status=VerificationStatus.OK),
            StageResult(
                stage=VerificationStage.SUMMARIZE, status=VerificationStatus.OK
            ),
        ]
        self.assertTrue(is_terminal_verified(results))

    def test_one_failed_is_not_verified(self):
        results = [
            StageResult(stage=VerificationStage.SMOKE, status=VerificationStatus.OK),
            StageResult(
                stage=VerificationStage.SUMMARIZE, status=VerificationStatus.FAILED
            ),
        ]
        self.assertFalse(is_terminal_verified(results))


if __name__ == "__main__":
    unittest.main()

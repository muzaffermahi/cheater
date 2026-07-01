"""Internal playbooks for the Cheater harness.

A playbook is an execution policy, not a prompt. It tells the harness:

  * how to prepare
  * how to verify
  * what artifacts matter
  * what failures usually mean
  * what recovery steps are allowed
  * what completion evidence is required

The agent loop selects a playbook for the task, and the playbook
drives the lifecycle. The model sees a small, bounded description of
the playbook (which files to look at, which invariants to keep) and
stays out of the orchestration details.

Public API:

  PlaybookKind            -- the high-level task class
  Playbook                -- the execution policy
  select_playbook(task)   -- pick a playbook from a task description
  default_playbooks()     -- the built-in playbook library
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from cheater.verification import (
    StageSpec,
    VerificationStage,
    default_backend_api_plan,
    default_cli_plan,
    default_webapp_plan,
)


class PlaybookKind(str, Enum):
    WEBAPP = "webapp"
    FRONTEND_BUILD = "frontend_build"
    BACKEND_API = "backend_api"
    CLI_PACKAGE = "cli_package"
    VISUAL_SNAPSHOT = "visual_snapshot"
    FULLSTACK_DEV = "fullstack_dev"
    DOCS_OR_API_MIGRATION = "docs_or_api_migration"
    GENERIC = "generic"


# ---------- playbook dataclass ----------


@dataclass
class Playbook:
    """An execution policy for a class of tasks.

    The model receives:
      * ``worker_brief``  -- a short prompt for the bounded worker
      * ``invariants``    -- rules the model must not violate
      * ``focus_paths``   -- path globs the model is allowed to edit

    The harness receives:
      * ``plan``           -- the verification plan
      * ``artifacts``      -- what counts as evidence
      * ``failure_hints``  -- failure class -> human hint
      * ``recoveries``     -- failure class -> allowed recovery names
      * ``expect_scoring`` -- whether a scoring command is required
      * ``scoring_command``-- optional default scoring command
    """

    kind: PlaybookKind
    title: str
    description: str
    worker_brief: str
    invariants: list[str] = field(default_factory=list)
    focus_paths: list[str] = field(default_factory=list)
    plan: list[StageSpec] = field(default_factory=list)
    artifacts: list[str] = field(default_factory=list)
    failure_hints: dict[str, str] = field(default_factory=dict)
    recoveries: dict[str, list[str]] = field(default_factory=dict)
    expect_scoring: bool = False
    scoring_command: str | None = None
    # Tags used by the router. The router picks the playbook whose
    # tags overlap most with the task description.
    tags: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        d = self.__dict__.copy()
        d["kind"] = self.kind.value
        d["plan"] = [
            {
                "stage": s.stage.value,
                "required": s.required,
                "timeout": s.timeout,
                "description": s.description,
            }
            for s in self.plan
        ]
        return d


# ---------- built-in playbooks ----------


def _webapp_playbook() -> Playbook:
    return Playbook(
        kind=PlaybookKind.WEBAPP,
        title="Webapp with Playwright / dev server",
        description=(
            "A web application with a dev server and headless tests. "
            "The harness owns the dev server, verifies the served workspace, "
            "and runs Playwright / e2e checks against it."
        ),
        worker_brief=(
            "You are a small-model worker for a webapp task. Stay bounded:\n"
            "  * Edit only files matching the focus_paths.\n"
            "  * Do not start, stop, or restart the dev server yourself; "
            "the harness owns it.\n"
            "  * Do not curl/wget the local server to verify; the harness "
            "runs a workspace-identity check.\n"
            "  * When you think the task is done, output a single JSON "
            "action. Do not narrate."
        ),
        invariants=[
            "Do not start or stop the dev server.",
            "Do not invoke curl/wget against localhost; the harness runs a smoke check.",
            "Do not modify snapshot baselines unless the user has approved.",
            "Do not change files outside focus_paths.",
        ],
        focus_paths=["src/**", "app/**", "pages/**", "components/**", "public/**"],
        plan=default_webapp_plan(),
        artifacts=[
            "verification.log",
            "test-output.txt",
            "playwright-report/",
        ],
        failure_hints={
            "app_bug": "Inspect the assertion that failed; reproduce in a focused test.",
            "server_runtime": "The dev server may need to be restarted. The harness handles it.",
            "stale_workspace": "The dev server is serving a different checkout. The harness will restart it.",
            "snapshot_baseline": "Snapshot diff is expected to be a deliberate UI change. Do not auto-update.",
        },
        recoveries={
            "app_bug": ["replan_with_focus_on_failure"],
            "server_runtime": ["stop_owned_servers_and_retry"],
            "stale_workspace": ["restart_server_against_current_workspace"],
            "snapshot_baseline": ["review_snapshot_diff_with_user"],
        },
        expect_scoring=False,
        scoring_command=None,
        tags=[
            "web",
            "webapp",
            "playwright",
            "next",
            "vite",
            "react",
            "frontend",
            "browser",
            "e2e",
            "ui",
        ],
    )


def _frontend_build_playbook() -> Playbook:
    return Playbook(
        kind=PlaybookKind.FRONTEND_BUILD,
        title="Frontend build / test",
        description=(
            "A frontend project that builds and runs unit tests, but does "
            "not necessarily need a long-running dev server during "
            "verification."
        ),
        worker_brief=(
            "You are a small-model worker for a frontend build/test task. "
            "Stay bounded: edit only the focus_paths; do not start a dev "
            "server unless the harness asks you to."
        ),
        invariants=[
            "Do not start a dev server unless the harness asks.",
            "Run only the project's declared test/lint command.",
            "Do not change the lockfile unless dependency is missing.",
        ],
        focus_paths=["src/**", "components/**", "pages/**", "app/**"],
        plan=[
            StageSpec(
                stage=VerificationStage.PREPARE_ENV,
                required=True,
                timeout=120.0,
                description="npm/pnpm install (or cache hit)",
            ),
            StageSpec(
                stage=VerificationStage.FOCUSED_TESTS,
                required=True,
                timeout=120.0,
                description="run targeted tests for the changed files",
            ),
            StageSpec(
                stage=VerificationStage.FULL_TESTS,
                required=False,
                timeout=240.0,
                description="run the full test suite",
            ),
            StageSpec(
                stage=VerificationStage.COLLECT_ARTIFACTS, required=True, timeout=5.0
            ),
            StageSpec(stage=VerificationStage.SUMMARIZE, required=True, timeout=5.0),
        ],
        artifacts=["test-output.txt", "coverage/"],
        failure_hints={
            "app_bug": "Read the assertion and the recent change.",
            "dependency": "A package is missing or out of date; install once and retry.",
        },
        recoveries={
            "app_bug": ["replan_with_focus_on_failure"],
            "dependency": ["install_or_pin_dependencies"],
            "test_bug": ["replan_with_focus_on_test"],
        },
        expect_scoring=False,
        tags=["frontend", "build", "test", "npm", "pnpm", "yarn", "vitest", "jest"],
    )


def _backend_api_playbook() -> Playbook:
    return Playbook(
        kind=PlaybookKind.BACKEND_API,
        title="Backend API test",
        description=(
            "A backend service with a test suite. The harness starts the "
            "service in a controlled way, verifies the workspace identity, "
            "and runs the integration tests."
        ),
        worker_brief=(
            "You are a small-model worker for a backend API task. "
            "Stay bounded: edit only the focus_paths; do not start the "
            "API server yourself; the harness owns it."
        ),
        invariants=[
            "Do not start the API server; the harness owns it.",
            "Do not run integration tests with the production database.",
            "Do not change migrations unless the task explicitly requires it.",
        ],
        focus_paths=["api/**", "src/**", "app/**", "service/**", "tests/**"],
        plan=default_backend_api_plan(),
        artifacts=["test-output.txt", "server.log"],
        failure_hints={
            "server_runtime": "Check port collision or stale process; the harness will restart.",
            "app_bug": "Read the assertion and the recent change.",
        },
        recoveries={
            "server_runtime": ["stop_owned_servers_and_retry"],
            "app_bug": ["replan_with_focus_on_failure"],
        },
        expect_scoring=False,
        tags=[
            "api",
            "backend",
            "fastapi",
            "flask",
            "express",
            "django",
            "service",
            "integration",
        ],
    )


def _cli_package_playbook() -> Playbook:
    return Playbook(
        kind=PlaybookKind.CLI_PACKAGE,
        title="CLI / package test",
        description="A CLI tool or library package with a unit-test suite.",
        worker_brief=(
            "You are a small-model worker for a CLI / package task. "
            "Stay bounded: edit only the focus_paths; run only the "
            "project's test command."
        ),
        invariants=[
            "Run only the project's declared test command.",
            "Do not change the public CLI interface unless the task requires it.",
        ],
        focus_paths=["src/**", "lib/**", "cli/**", "tests/**", "test/**"],
        plan=default_cli_plan(),
        artifacts=["test-output.txt"],
        failure_hints={
            "app_bug": "Read the assertion and the recent change.",
            "test_bug": "Look at the test setup, not the implementation.",
        },
        recoveries={
            "app_bug": ["replan_with_focus_on_failure"],
            "test_bug": ["replan_with_focus_on_test"],
        },
        expect_scoring=False,
        tags=["cli", "package", "library", "lib", "tool", "command"],
    )


def _visual_snapshot_playbook() -> Playbook:
    return Playbook(
        kind=PlaybookKind.VISUAL_SNAPSHOT,
        title="Visual snapshot test",
        description=(
            "A visual regression test run. Snapshot updates are a "
            "deliberate decision, not an automatic recovery."
        ),
        worker_brief=(
            "You are a small-model worker for a visual snapshot task. "
            "Do NOT auto-update baselines. If a snapshot diff is the "
            "expected change, the user must approve it explicitly."
        ),
        invariants=[
            "Do not auto-update snapshot baselines.",
            "If the snapshot diff is the expected outcome, surface it to the user and stop.",
        ],
        focus_paths=["src/**", "components/**", "screens/**", "snapshots/**"],
        plan=default_webapp_plan(),
        artifacts=["playwright-report/", "snapshots/"],
        failure_hints={
            "snapshot_baseline": "A snapshot diff is expected to be a deliberate UI change. Do not auto-update.",
        },
        recoveries={
            "snapshot_baseline": ["review_snapshot_diff_with_user"],
        },
        expect_scoring=False,
        tags=["visual", "snapshot", "screenshot", "playwright", "image-diff"],
    )


def _fullstack_playbook() -> Playbook:
    return Playbook(
        kind=PlaybookKind.FULLSTACK_DEV,
        title="Full-stack app with dev server",
        description=(
            "A full-stack application with both a frontend dev server and "
            "a backend API. The harness owns both processes, verifies the "
            "served workspaces, and runs e2e checks."
        ),
        worker_brief=(
            "You are a small-model worker for a full-stack task. Stay "
            "bounded: edit only the focus_paths; do not start the dev "
            "server or the API yourself; the harness owns them."
        ),
        invariants=[
            "Do not start the dev server or the API; the harness owns them.",
            "Do not invoke curl/wget against localhost; the harness runs a workspace-identity check.",
        ],
        focus_paths=["frontend/src/**", "backend/src/**", "api/**", "web/**", "app/**"],
        plan=default_webapp_plan(),
        artifacts=["verification.log", "test-output.txt"],
        failure_hints={
            "server_runtime": "A port is in use or a server crashed. The harness will restart.",
            "stale_workspace": "The dev server or API is serving a different checkout. The harness will restart.",
        },
        recoveries={
            "server_runtime": ["stop_owned_servers_and_retry"],
            "stale_workspace": ["restart_server_against_current_workspace"],
            "app_bug": ["replan_with_focus_on_failure"],
        },
        expect_scoring=False,
        tags=[
            "fullstack",
            "full-stack",
            "monorepo",
            "next",
            "fastapi",
            "express",
            "django",
        ],
    )


def _docs_or_api_migration_playbook() -> Playbook:
    return Playbook(
        kind=PlaybookKind.DOCS_OR_API_MIGRATION,
        title="Docs / API migration bug",
        description=(
            "A bug caused by an API or docs change in a dependency. "
            "The fix usually lives in a focused call site."
        ),
        worker_brief=(
            "You are a small-model worker for an API migration bug. "
            "Stay bounded: edit only the focus_paths; do not modify the "
            "dependency version unless that is the fix."
        ),
        invariants=[
            "Do not bump dependency majors unless the task requires it.",
            "Do not rewrite large portions of the codebase for a migration.",
        ],
        focus_paths=["src/**", "app/**", "lib/**", "tests/**"],
        plan=default_cli_plan(),
        artifacts=["test-output.txt"],
        failure_hints={
            "app_bug": "The migration is at a specific call site. Read the deprecation message and patch that call.",
        },
        recoveries={
            "app_bug": ["replan_with_focus_on_failure"],
        },
        expect_scoring=False,
        tags=["docs", "migration", "api", "deprecation", "upgrade"],
    )


def default_playbooks() -> dict[PlaybookKind, Playbook]:
    return {
        PlaybookKind.WEBAPP: _webapp_playbook(),
        PlaybookKind.FRONTEND_BUILD: _frontend_build_playbook(),
        PlaybookKind.BACKEND_API: _backend_api_playbook(),
        PlaybookKind.CLI_PACKAGE: _cli_package_playbook(),
        PlaybookKind.VISUAL_SNAPSHOT: _visual_snapshot_playbook(),
        PlaybookKind.FULLSTACK_DEV: _fullstack_playbook(),
        PlaybookKind.DOCS_OR_API_MIGRATION: _docs_or_api_migration_playbook(),
    }


# ---------- selection ----------


# Heuristic scoring: each tag in the task description contributes a
# point to the matching playbook. Tie-breaks go to more specific
# playbooks first. The router never invents a new playbook kind.
_TAG_WEIGHTS: dict[PlaybookKind, dict[str, int]] = {
    PlaybookKind.WEBAPP: {
        "playwright": 3,
        "e2e": 2,
        "browser": 2,
        "ui": 1,
        "webapp": 3,
        "web app": 3,
        "next": 2,
        "vite": 2,
        "react": 1,
        "spa": 2,
    },
    PlaybookKind.FRONTEND_BUILD: {
        "npm test": 3,
        "vitest": 3,
        "jest": 3,
        "pnpm": 2,
        "yarn": 1,
        "build": 1,
        "frontend": 2,
        "webpack": 2,
        "vite": 1,
    },
    PlaybookKind.BACKEND_API: {
        "fastapi": 3,
        "flask": 3,
        "django": 3,
        "express": 2,
        "service": 1,
        "api": 2,
        "backend": 3,
        "endpoint": 1,
        "uvicorn": 3,
        "gunicorn": 3,
    },
    PlaybookKind.CLI_PACKAGE: {
        "cli": 3,
        "command line": 2,
        "package": 1,
        "library": 2,
        "lib": 1,
        "pypi": 2,
        "npm publish": 2,
        "binary": 1,
        "tool": 1,
    },
    PlaybookKind.VISUAL_SNAPSHOT: {
        "screenshot": 3,
        "snapshot": 2,
        "visual": 3,
        "image diff": 3,
        "tomatchsnapshot": 3,
        "playwright": 1,
    },
    PlaybookKind.FULLSTACK_DEV: {
        "monorepo": 5,
        "full-stack": 5,
        "fullstack": 5,
        "frontend and backend": 5,
        "next": 1,
        "fastapi": 1,
        "django": 1,
        "express": 1,
    },
    PlaybookKind.DOCS_OR_API_MIGRATION: {
        "deprecat": 3,
        "migration": 3,
        "upgrade": 2,
        "docs": 2,
        "api change": 2,
        "changelog": 2,
        "breaking": 2,
        "v2": 1,
        "v3": 1,
    },
}


_GENERIC_FALLBACK = PlaybookKind.CLI_PACKAGE


def select_playbook(
    task: str, *, playbooks: dict[PlaybookKind, Playbook] | None = None
) -> Playbook:
    """Pick a playbook for a task description.

    Scoring is intentionally simple: a tag dictionary and a small
    keyword set. The router never invents kinds it does not know.
    """
    pbs = playbooks or default_playbooks()
    text = (task or "").lower()
    if not text.strip():
        return pbs[_GENERIC_FALLBACK]
    scores: dict[PlaybookKind, int] = {k: 0 for k in pbs}
    for kind, weights in _TAG_WEIGHTS.items():
        if kind not in pbs:
            continue
        for needle, w in weights.items():
            if needle in text:
                scores[kind] += w
    best = max(scores.items(), key=lambda kv: kv[1])
    if best[1] <= 0:
        return pbs[_GENERIC_FALLBACK]
    return pbs[best[0]]


def playbook_for_kind(
    kind: PlaybookKind, *, playbooks: dict[PlaybookKind, Playbook] | None = None
) -> Playbook:
    """Return the playbook for a specific kind, falling back to the generic one."""
    pbs = playbooks or default_playbooks()
    return pbs.get(kind) or pbs[_GENERIC_FALLBACK]


def worker_brief_for(playbook: Playbook) -> str:
    """Return the worker brief the model sees in the system prompt.

    The brief is bounded: it tells the model what to do and what
    not to do. It does not include prompts that drift toward
    "reason about the architecture".
    """
    invariant_text = "\n".join(f"  - {i}" for i in playbook.invariants) or "  (none)"
    focus_text = ", ".join(playbook.focus_paths) or "(all)"
    return (
        f"PLAYBOOK: {playbook.title}\n"
        f"{playbook.description}\n\n"
        f"WORKER BRIEF:\n{playbook.worker_brief}\n\n"
        f"INVARIANTS (must not violate):\n{invariant_text}\n\n"
        f"FOCUS PATHS (only edit files in these): {focus_text}\n"
    )

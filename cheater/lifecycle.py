"""Execution ownership model for the Cheater harness.

A coding harness that wants weak/local models to be reliable must own the
lifecycle of every command and process it touches. The model is not
allowed to improvise process management, because that is exactly where
harnesses fall apart: dev servers left running on stale ports, tests
that talk to a foreign workspace, half-stopped services, orphan scoring
scripts.

This module models execution resources as first-class objects and
classifies them. The model receives a short, deterministic
representation of what the harness owns and can ask the harness to
operate on it. The harness is the only thing that actually launches,
inspects, stops, or restarts things.

Public API:

  CommandKind              -- one_shot | dev_server | test | verify | scoring | shell
  ProcessStatus            -- pending | running | succeeded | failed | timed_out | stopped | unknown
  OwnedCommand             -- a record of a single launched command
  OwnedProcess             -- a record of a long-running process
  ProcessRegistry          -- tracks commands and processes
  classify_command(cmd)    -- best-effort kind detection
  workspace_signature(...) -- stable signature of the current workspace
  safe_cleanup_targets()   -- things the harness is allowed to clean up

The lifecycle is intentionally side-effect free at the import level.
Process launching and stopping is funnelled through explicit hooks so
tests can inject fakes.
"""

from __future__ import annotations

import os
import re
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Callable


class CommandKind(str, Enum):
    """How the harness should treat a command.

    - one_shot   : runs to completion and exits
    - dev_server : long-running HTTP/RPC service the harness may need to stop
    - test       : test runner (pytest, npm test, cargo test, go test, ...)
    - verify     : smoke / contract / health check
    - scoring    : graded scoring / report command
    - shell      : anything else the model explicitly asked for
    """

    ONE_SHOT = "one_shot"
    DEV_SERVER = "dev_server"
    TEST = "test"
    VERIFY = "verify"
    SCORING = "scoring"
    SHELL = "shell"


class ProcessStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    TIMED_OUT = "timed_out"
    STOPPED = "stopped"
    UNKNOWN = "unknown"


# Patterns used to classify a command. Order matters: the first match wins.
_CLASSIFY_PATTERNS: tuple[tuple[CommandKind, re.Pattern[str]], ...] = (
    # Tests beat dev servers because "npm test" must not be classified as dev.
    (
        CommandKind.TEST,
        re.compile(
            r"\bpytest\b|\bunittest\b|\bmocha\b|\bjest\b|\bcargo\s+test\b|\bgo\s+test\b|\bmvn\s+test\b|\bvitest\b|\bplaywright\s+test\b|\bcypress\b|\brspec\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(make|cmake)\s+test\b"
        ),
    ),
    (
        CommandKind.SCORING,
        re.compile(
            r"\bscore\b|\bgrading?\b|\bevaluate\b|\bbenchmark\b|\bjudge\b|\bgrade\b",
            re.IGNORECASE,
        ),
    ),
    (
        CommandKind.VERIFY,
        re.compile(r"\bcurl\b|\bwget\b|\bhealth[-_]?check\b|\bsmoke\b|\bpayload\b"),
    ),
    (
        CommandKind.DEV_SERVER,
        re.compile(
            r"\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|preview)\b|\bnext\s+dev\b|\bnext\s+start\b|\bflask\s+run\b|\buvicorn\b|\bgunicorn\b|\bdjango-admin\s+runserver\b|\bmanage\.py\s+runserver\b|\bhttp\.server\b|\bserve\b|\bnode\s+.*\bserver\.js\b|\bdeno\s+run\b.*-A\b|\bstreamlit\s+run\b|\bgradio\b|\bfastapi\b|\bexpress\b.*listen|\bvite\b|\bwebpack-dev-server\b|\bng\s+serve\b"
        ),
    ),
    (
        CommandKind.ONE_SHOT,
        re.compile(
            r"^\s*(ls|cat|echo|pwd|true|false|head|tail|wc|cp|mv|mkdir|rmdir|chmod|chown|find|grep|rg|ag|sort|uniq|cut|tr|tee|diff|tar|zip|unzip|git\s+(status|log|diff|show|rev-parse|ls-files|branch))\b"
        ),
    ),
)


def classify_command(cmd: str) -> CommandKind:
    """Classify a command string into a CommandKind.

    The classifier is best-effort: ambiguous commands fall back to
    CommandKind.SHELL, which means "model explicitly asked, treat with
    care". It is intentionally conservative: it does not invent kinds
    for commands it does not recognise.
    """
    if not isinstance(cmd, str) or not cmd.strip():
        return CommandKind.SHELL
    for kind, pat in _CLASSIFY_PATTERNS:
        if pat.search(cmd):
            return kind
    return CommandKind.SHELL


def is_long_running(kind: CommandKind) -> bool:
    """Whether this kind of command is expected to outlive a single step."""
    return kind in (CommandKind.DEV_SERVER,)


# ---------- records ----------


@dataclass
class OwnedCommand:
    """Record of a single command the harness launched."""

    cmd_id: str
    cmd: str
    kind: CommandKind
    cwd: str
    started_at: float
    finished_at: float = 0.0
    exit_code: int | None = None
    status: ProcessStatus = ProcessStatus.PENDING
    elapsed: float = 0.0
    stdout: str = ""
    stderr: str = ""
    timed_out: bool = False
    pid: int | None = None
    parent_id: str | None = None  # process that owns this command (e.g. a server)
    workspace_sig: str = ""
    classification_source: str = "static"  # static | declared
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        d = self.__dict__.copy()
        d["kind"] = self.kind.value
        d["status"] = self.status.value
        return d


@dataclass
class OwnedProcess:
    """Record of a long-running process the harness owns.

    Long-running services (dev servers, watchers, scoring daemons) need
    stable handles so the harness can stop or restart them without
    confusing them with random user processes. We do not assume we can
    always get a real OS pid; tests pass in a fake.
    """

    process_id: str
    label: str
    cmd: str
    kind: CommandKind
    started_at: float
    pid: int | None = None
    status: ProcessStatus = ProcessStatus.RUNNING
    workspace_sig: str = ""
    health_endpoint: str | None = None
    # Optional handle the harness can use to stop the process. Tests
    # inject a fake. Real runs are not implemented in this slice --
    # the registry only models the lifecycle.
    stop: Callable[[], None] | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        d = self.__dict__.copy()
        d["kind"] = self.kind.value
        d["status"] = self.status.value
        d["stop"] = None  # never serialise the callable
        return d


@dataclass
class WorkspaceMismatch:
    """A signal that something is serving the wrong workspace."""

    observed: str  # the signature the verifier saw
    expected: str
    evidence: str
    at: float = field(default_factory=time.time)


# ---------- workspace signature ----------


def workspace_signature(repo_root: str | Path | None) -> str:
    """Return a stable signature of the current workspace.

    Used by the verifier to confirm "the running server is serving THIS
    repo, not a stale one". A signature is a short hash of a few
    deterministic facts:

      - absolute path of repo_root
      - count of tracked files
      - highest mtime among tracked files
      - size of the working tree (best-effort)

    Deliberately cheap and stdlib-only. We don't reach for git here
    because the verifier should not depend on .git being clean.
    """
    root = Path(repo_root or os.getcwd()).resolve()
    if not root.exists():
        return f"missing:{root}"
    file_count = 0
    highest_mtime = 0.0
    total_size = 0
    # Avoid scanning the whole tree; cap the walk to keep this O(1) for huge repos.
    for dirpath, dirnames, filenames in os.walk(root):
        # Skip noisy directories that do not affect what an app would serve.
        dirnames[:] = [
            d
            for d in dirnames
            if d
            not in {
                "__pycache__",
                ".git",
                ".hg",
                ".svn",
                "node_modules",
                ".venv",
                "venv",
                "env",
                ".pytest_cache",
                ".ruff_cache",
                ".mypy_cache",
                ".idea",
                ".vscode",
                "dist",
                "build",
                "target",
                ".next",
                ".cache",
                "_archive",
            }
        ]
        for name in filenames:
            file_count += 1
            if file_count > 2000:
                break
            try:
                p = Path(dirpath) / name
                st = p.stat()
                total_size += int(st.st_size)
                if st.st_mtime > highest_mtime:
                    highest_mtime = float(st.st_mtime)
            except OSError:
                continue
        if file_count > 2000:
            break
    sig = f"{root}|n={file_count}|mtime={int(highest_mtime)}|size={total_size}"
    return sig


# ---------- registry ----------


class ProcessRegistry:
    """Tracks every command and long-running process the harness owns.

    The registry is the single source of truth for "what did we launch,
    what's still running, what is safe to clean up". Cleanup operations
    refuse to touch anything that the harness did not launch, which
    prevents the most common infrastructure failure mode: a model
    killing a process it doesn't own.
    """

    def __init__(self) -> None:
        self._commands: dict[str, OwnedCommand] = {}
        self._processes: dict[str, OwnedProcess] = {}
        # ordered history; command ids are unique.
        self._order: list[str] = []

    # ---- command bookkeeping ----

    def record_command(self, cmd: OwnedCommand) -> None:
        self._commands[cmd.cmd_id] = cmd
        self._order.append(cmd.cmd_id)

    def get_command(self, cmd_id: str) -> OwnedCommand | None:
        return self._commands.get(cmd_id)

    def all_commands(self) -> list[OwnedCommand]:
        return [self._commands[i] for i in self._order if i in self._commands]

    def commands_by_kind(self, kind: CommandKind) -> list[OwnedCommand]:
        return [c for c in self.all_commands() if c.kind == kind]

    # ---- process bookkeeping ----

    def register_process(self, proc: OwnedProcess) -> None:
        self._processes[proc.process_id] = proc

    def deregister_process(self, process_id: str) -> None:
        self._processes.pop(process_id, None)

    def get_process(self, process_id: str) -> OwnedProcess | None:
        return self._processes.get(process_id)

    def all_processes(self) -> list[OwnedProcess]:
        return list(self._processes.values())

    def running_processes(self) -> list[OwnedProcess]:
        return [
            p for p in self._processes.values() if p.status == ProcessStatus.RUNNING
        ]

    # ---- cleanup / safety ----

    def is_owned_process(self, process_id: str) -> bool:
        return process_id in self._processes

    def stop_all_running(self) -> list[str]:
        """Stop every running process the harness owns.

        Returns the labels of the processes that were stopped. Refuses
        to touch anything that is not in the registry. This is what
        protects the harness from the model doing "pkill -f node".
        """
        stopped: list[str] = []
        for proc in list(self._processes.values()):
            if proc.status != ProcessStatus.RUNNING:
                continue
            try:
                if proc.stop is not None:
                    proc.stop()
                proc.status = ProcessStatus.STOPPED
                stopped.append(proc.label or proc.process_id)
            except Exception:
                # We never want cleanup to crash the loop.
                proc.status = ProcessStatus.UNKNOWN
        return stopped

    def safe_cleanup_targets(self) -> list[dict[str, Any]]:
        """Return a list of resources the harness is allowed to clean up.

        The model only ever sees this list. The model is never handed
        a generic "kill anything matching this name" primitive, so it
        cannot accidentally terminate the user's editor, IDE, or
        another agent's work.
        """
        out: list[dict[str, Any]] = []
        for proc in self._processes.values():
            out.append(
                {
                    "kind": "process",
                    "id": proc.process_id,
                    "label": proc.label,
                    "status": proc.status.value,
                    "workspace_sig": proc.workspace_sig,
                }
            )
        for cmd in self._commands.values():
            if cmd.status == ProcessStatus.RUNNING:
                out.append(
                    {
                        "kind": "command",
                        "id": cmd.cmd_id,
                        "label": cmd.cmd[:80],
                        "status": cmd.status.value,
                    }
                )
        return out

    # ---- diagnostics ----

    def summary(self) -> dict[str, Any]:
        return {
            "commands": len(self._commands),
            "commands_by_kind": {
                k.value: sum(1 for c in self._commands.values() if c.kind == k)
                for k in CommandKind
            },
            "processes": len(self._processes),
            "running_processes": len(self.running_processes()),
        }


# ---------- failure classification ----------


class FailureClass(str, Enum):
    """A coarse failure taxonomy used by the recovery layer.

    These are intentionally small. A more nuanced taxonomy belongs in
    the playbook layer, which knows what failure modes matter for a
    given task class.
    """

    APP_BUG = "app_bug"
    TEST_BUG = "test_bug"
    SERVER_RUNTIME = "server_runtime"
    DEPENDENCY = "dependency"
    SNAPSHOT_BASELINE = "snapshot_baseline"
    STALE_WORKSPACE = "stale_workspace"
    COMMAND_INVOCATION = "command_invocation"
    UNKNOWN = "unknown"


# Patterns used to map a (stdout/stderr/exit_code) signal to a FailureClass.
# First match wins. Be conservative: false positives are worse than
# unknowns, because they steer recovery wrong.
_FAILURE_PATTERNS: tuple[tuple[FailureClass, re.Pattern[str]], ...] = (
    (
        FailureClass.SNAPSHOT_BASELINE,
        re.compile(
            r"\b(snapshot|baseline|visual[_\- ]diff|tomatchsnapshot|expected.*to (be|equal).*but received)\b",
            re.IGNORECASE,
        ),
    ),
    (
        FailureClass.DEPENDENCY,
        re.compile(
            r"\b(module not found|no module named|cannot find module|no such file or directory|enoent.*node_modules|pep 668|externally[- ]managed|lockfile out of date|importerror|cannot find a package)\b",
            re.IGNORECASE,
        ),
    ),
    (
        FailureClass.SERVER_RUNTIME,
        re.compile(
            r"\b(eaddrinuse|address already in use|port \d+ is (already )?in use|listening on port|server (crashed|killed|stopped)|unhandled rejection|uncaughtexception|segfault)\b",
            re.IGNORECASE,
        ),
    ),
    (
        FailureClass.STALE_WORKSPACE,
        re.compile(
            r"\b(stale|workspace (mismatch|mismatch)|serving.*different (workspace|dir|directory)|not the current (workspace|repo))\b",
            re.IGNORECASE,
        ),
    ),
    (
        FailureClass.TEST_BUG,
        re.compile(
            r"\b(conftest|fixture|setup failed|teardown failed|error: cannot find|error during collection|test file not found|importerror.*test|unrecognized arguments)\b",
            re.IGNORECASE,
        ),
    ),
    (
        FailureClass.APP_BUG,
        re.compile(
            r"\b(assertionerror|assert .*==|expected .* to (be|equal)|typeerror|valueerror|keyerror|attributeerror|noneType.*has no attribute|indexerror)\b",
            re.IGNORECASE,
        ),
    ),
    (
        FailureClass.COMMAND_INVOCATION,
        re.compile(
            r"\b(command not found|usage:|usage error|unknown option|invalid argument|bad flag|unrecognized arguments|no such option|errno\s*=\s*enoent)\b",
            re.IGNORECASE,
        ),
    ),
)


def classify_failure(
    *,
    exit_code: int | None,
    stdout: str,
    stderr: str,
    timed_out: bool = False,
) -> FailureClass:
    """Best-effort classification of a failed command.

    The classifier is biased toward UNKNOWN on noise. The recovery
    layer can always ask for a more specific class from the playbook.
    """
    if timed_out:
        # Timeouts are usually a server/runtime symptom or a hung
        # process; either way they are not an "app bug".
        return FailureClass.SERVER_RUNTIME
    if exit_code == 0:
        return FailureClass.UNKNOWN
    blob = (stdout or "") + "\n" + (stderr or "")
    if not blob.strip():
        return FailureClass.UNKNOWN
    for cls, pat in _FAILURE_PATTERNS:
        if pat.search(blob):
            return cls
    return FailureClass.UNKNOWN


# ---------- recovery policy ----------


@dataclass
class RecoveryAction:
    """A smallest possible recovery step the harness can take.

    Recoveries are explicit, not magic. The harness will not "just try
    again"; it will pick one of these and report which one it took.
    """

    name: str
    failure_class: FailureClass
    description: str
    cost: str = "cheap"  # cheap | moderate | expensive
    requires_user: bool = False
    allowed_attempts: int = 1


# A small library of recoveries. Playbooks can extend this.
DEFAULT_RECOVERIES: dict[FailureClass, list[RecoveryAction]] = {
    FailureClass.APP_BUG: [
        RecoveryAction(
            name="replan_with_focus_on_failure",
            failure_class=FailureClass.APP_BUG,
            description="Re-plan with the failing assertion/exception quoted as the new focus.",
            cost="cheap",
        ),
    ],
    FailureClass.TEST_BUG: [
        RecoveryAction(
            name="replan_with_focus_on_test",
            failure_class=FailureClass.TEST_BUG,
            description="Inspect the test setup before re-running; tests must not be silently rewritten.",
            cost="moderate",
        ),
    ],
    FailureClass.SERVER_RUNTIME: [
        RecoveryAction(
            name="stop_owned_servers_and_retry",
            failure_class=FailureClass.SERVER_RUNTIME,
            description="Stop owned dev servers, free the port, restart from a clean state.",
            cost="moderate",
        ),
    ],
    FailureClass.DEPENDENCY: [
        RecoveryAction(
            name="install_or_pin_dependencies",
            failure_class=FailureClass.DEPENDENCY,
            description="Install / re-pin the missing dependency in the current env, then retry.",
            cost="moderate",
        ),
    ],
    FailureClass.SNAPSHOT_BASELINE: [
        RecoveryAction(
            name="review_snapshot_diff_with_user",
            failure_class=FailureClass.SNAPSHOT_BASELINE,
            description="Treat baseline change as a deliberate change; do not auto-update snapshots without user confirmation.",
            cost="moderate",
            requires_user=True,
        ),
    ],
    FailureClass.STALE_WORKSPACE: [
        RecoveryAction(
            name="restart_server_against_current_workspace",
            failure_class=FailureClass.STALE_WORKSPACE,
            description="Stop owned dev server, restart it pointed at the current workspace, re-verify.",
            cost="moderate",
        ),
    ],
    FailureClass.COMMAND_INVOCATION: [
        RecoveryAction(
            name="fix_invocation_and_retry",
            failure_class=FailureClass.COMMAND_INVOCATION,
            description="Fix the command line (typo, missing arg) and retry exactly once.",
            cost="cheap",
        ),
    ],
    FailureClass.UNKNOWN: [
        RecoveryAction(
            name="collect_diagnostics_and_ask",
            failure_class=FailureClass.UNKNOWN,
            description="Collect tail, working memory, and ledger, then surface to the user; do not loop.",
            cost="cheap",
        ),
    ],
}


def pick_recovery(cls: FailureClass) -> RecoveryAction:
    """Pick the smallest applicable recovery for a failure class.

    Returns the first registered action. If nothing is registered, the
    caller is the unknown path: collect diagnostics and surface the
    failure rather than spinning.
    """
    actions = DEFAULT_RECOVERIES.get(cls) or DEFAULT_RECOVERIES[FailureClass.UNKNOWN]
    return actions[0]


# ---------- id helpers ----------


def new_id(prefix: str = "cmd") -> str:
    """Generate a short opaque id for a command or process.

    Centralised so tests can monkey-patch it.
    """
    return f"{prefix}-{uuid.uuid4().hex[:10]}"

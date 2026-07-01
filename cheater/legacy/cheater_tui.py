from __future__ import annotations

import cmd
import shlex
import subprocess
from pathlib import Path

from .benchmark_harness import BenchmarkError, BenchmarkHarness
from .cheater_core import CheaterSession


COMMAND_HELP = """Available commands:
  /help                 Show this command list.
  /status               Show repository, task, memory, Pi, and run status.
  /repo <path>          Change the target repository.
  /task <text>          Set the coding task.
  /error <text>         Set observed error or failing output.
  /query <text>         Override the memory retrieval query.
  /test <command>       Configure a test command, such as pytest.
  /topk <n>             Set the number of retrieved memories.
  /patch on|off         Include or exclude patch snippets.
  /memory               Retrieve and preview memories.
  /prompt               Generate prompt and artifacts without launching Pi.
  /pi                   Launch Pi using the latest prompt.
  /run                  Retrieve, generate, launch, and auto-send.
  /clip                 Copy the latest prompt to the clipboard.
  /logs                 Show paths for the latest run artifacts.
  /open                 Open the latest run folder in Explorer.
  /tests                Run the configured test command.
  /retry                Retrieve from failure logs and launch a retry.
  /diff                 Show and save the current Git diff.
  /bench <subcommand>   Benchmark list/load/sample/run/status/export/eval.
  /exit                 Exit Cheater.
"""


class CheaterTUI(cmd.Cmd):
    prompt = "cheater> "

    def __init__(self, session: CheaterSession, project_root: Path) -> None:
        super().__init__()
        self.session = session
        self.project_root = project_root
        self.bench = BenchmarkHarness(project_root)

    def parseline(self, line: str):  # type: ignore[override]
        line = line.strip()
        if line.startswith("/"):
            line = line[1:]
        return super().parseline(line)

    def preloop(self) -> None:
        print("=" * 72)
        print("CHEATER: Bug Memory Agent Harness")
        print("=" * 72)
        self.do_status("")
        print("Type /help for commands. Plain text sets the task and offers to run it.")

    def emptyline(self) -> None:
        return

    def default(self, line: str) -> None:
        self.session.task = line.strip()
        self.session.query = ""
        print("Task updated:", self.session.task)
        answer = input("Run it now? y/n: ").strip().lower()
        if answer in {"y", "yes"}:
            self.do_run("")

    def do_help(self, arg: str) -> None:
        """Show available slash commands."""
        print(COMMAND_HELP)

    def do_status(self, arg: str) -> None:
        """Show current Cheater state."""
        pi_command = self.session.pi_command()
        cards_status = "available" if self.session.cards_path.exists() else "missing"
        if self.session._cards is not None:
            cards_status += f" ({len(self.session._cards)} loaded)"
        print("Repo:", self.session.repo)
        print("Task:", self.session.task or "(exploratory)")
        print("Error:", self.session.error or "(none)")
        print("Query:", self.session.query or "(task + error)")
        print("Test command:", self.session.test_command or "(none)")
        print("Memory DB:", self.session.cards_path, f"[{cards_status}]")
        print(
            "Pi command:",
            subprocess.list2cmdline(pi_command) if pi_command else "not detected",
        )
        print("Top-k / min score:", self.session.top_k, "/", self.session.min_score)
        print("Include patches:", "on" if self.session.include_patch else "off")
        print(
            "Current mode:",
            "native Pi + initial message"
            if self.session.auto_send
            else "native Pi without initial message",
        )
        print("Last run:", self.session.last_run_dir or "(none)")

    def do_repo(self, arg: str) -> None:
        """Change target repository."""
        if not arg.strip():
            print("Usage: /repo <path>")
            return
        repo = Path(arg.strip().strip('"')).expanduser().resolve()
        if not repo.is_dir():
            print("Repository directory not found:", repo)
            return
        self.session.repo = repo
        self.session.runs_root = repo / ".cheater" / "sessions"
        self.session.last_run_dir = None
        self.session.last_prompt_file = None
        print("Repo set to:", repo)

    def do_task(self, arg: str) -> None:
        """Set current task."""
        self.session.task = arg.strip()
        self.session.query = ""
        print("Task:", self.session.task or "(exploratory)")

    def do_error(self, arg: str) -> None:
        """Set observed error/failure."""
        self.session.error = arg.strip()
        print("Error updated." if self.session.error else "Error cleared.")

    def do_query(self, arg: str) -> None:
        """Set custom retrieval query."""
        self.session.query = arg.strip()
        print("Query:", self.session.query or "(task + error)")

    def do_test(self, arg: str) -> None:
        """Set configured test command."""
        self.session.test_command = arg.strip()
        print("Test command:", self.session.test_command or "(none)")

    def do_topk(self, arg: str) -> None:
        """Set number of retrieved memories."""
        try:
            value = int(arg.strip())
        except ValueError:
            print("Usage: /topk <positive integer>")
            return
        if value < 1:
            print("Top-k must be at least 1.")
            return
        self.session.top_k = value
        print("Top-k:", value)

    def do_patch(self, arg: str) -> None:
        """Toggle memory patch snippets."""
        value = arg.strip().lower()
        if value not in {"on", "off"}:
            print("Usage: /patch on|off")
            return
        self.session.include_patch = value == "on"
        print("Patch snippets:", value)

    def do_memory(self, arg: str) -> None:
        """Retrieve and preview memories."""
        self.session.retrieve(interactive=True)

    def do_prompt(self, arg: str) -> None:
        """Generate prompt and artifacts without launching Pi."""
        self.session.generate_prompt(interactive_memory=True)

    def do_pi(self, arg: str) -> None:
        """Launch Pi with the latest prompt."""
        self.session.launch_latest()

    def do_run(self, arg: str) -> None:
        """Generate a fresh prompt and run Pi."""
        self.session.run(interactive_memory=True)

    def do_clip(self, arg: str) -> None:
        """Copy latest prompt to clipboard."""
        self.session.copy_latest_prompt()

    def do_logs(self, arg: str) -> None:
        """Show latest artifact paths."""
        self.session.show_logs()

    def do_open(self, arg: str) -> None:
        """Open latest run folder in Explorer."""
        self.session.open_run_folder()

    def do_tests(self, arg: str) -> None:
        """Run configured tests."""
        self.session.run_configured_tests()

    def do_retry(self, arg: str) -> None:
        """Retry using latest failure logs as retrieval context."""
        self.session.retry()

    def do_diff(self, arg: str) -> None:
        """Show and save the current Git diff."""
        from .cheater_core import collect_git_diff, write_text

        diff = collect_git_diff(self.session.repo)
        if not diff:
            print("No tracked Git diff found.")
            return
        print(diff)
        if self.session.last_run_dir:
            path = self.session.last_run_dir / "git_diff.patch"
            write_text(path, diff)
            print("Saved:", path)

    def do_bench(self, arg: str) -> None:
        """Run benchmark subcommands."""
        try:
            parts = shlex.split(arg, posix=False)
        except ValueError as exc:
            print("Invalid benchmark command:", exc)
            return
        if not parts:
            print(self.bench.help_text())
            return
        action = parts.pop(0).lower()
        try:
            if action == "list":
                self.bench.print_profiles()
            elif action == "load":
                if not parts:
                    print("Usage: /bench load <profile>")
                    return
                allow_download = input(
                    "Allow dataset download if it is not cached? y/n: "
                ).strip().lower() in {"y", "yes"}
                instances = self.bench.load_instances(parts[0], allow_download=allow_download)
                print(f"Loaded {len(instances)} instances from {parts[0]}.")
            elif action == "sample":
                if not parts:
                    print("Usage: /bench sample <profile> [count]")
                    return
                count = int(parts[1]) if len(parts) > 1 else 5
                self.bench.print_sample(parts[0], count, allow_download=False)
            elif action == "run":
                profile, limit, ids = self.bench.parse_run_args(parts)
                self.bench.run_profile(
                    profile,
                    limit=limit,
                    ids=ids,
                    repo=self.session.repo,
                    dry_run=False,
                    auto_send=self.session.auto_send,
                    cards_path=self.session.cards_path,
                    top_k=self.session.top_k,
                    min_score=self.session.min_score,
                    include_patch=self.session.include_patch,
                )
            elif action == "status":
                self.bench.print_status()
            elif action == "export":
                self.bench.export_latest()
            elif action == "eval":
                command = " ".join(parts)
                if not command:
                    print("Usage: /bench eval <official evaluator command>")
                    return
                self.bench.run_official_evaluator(command)
            else:
                print(self.bench.help_text())
        except (BenchmarkError, ValueError) as exc:
            print("Benchmark:", exc)

    def do_exit(self, arg: str) -> bool:
        """Exit Cheater."""
        print("Goodbye.")
        return True

    def do_quit(self, arg: str) -> bool:
        return self.do_exit(arg)

    def do_EOF(self, arg: str) -> bool:
        print()
        return self.do_exit(arg)


def run_tui(session: CheaterSession, project_root: Path) -> None:
    CheaterTUI(session, project_root).cmdloop()

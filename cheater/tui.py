"""Cheater TUI: a clean interactive shell for the bug-memory sidecar.

Built from the ground up to depend ONLY on the clean core package
(cheater.schema, cheater.cards, cheater.retrieval, cheater.benchmark, cheater.audit).
No Pi, no Qwen, no agent harness, no external APIs.

Commands:
  help                 Show this help.
  status               Show current TUI state (cards file, top-k, etc.).
  cards <path>         Set the card JSONL file to search.
  search <query>       Retrieve cards for a query (BM25F).
  topk <n>             Set number of results (default 5).
  audit [path]         Audit the current or given card file.
  bench <path>         Run the retrieval benchmark.
  bench-cards <path>   Set the benchmark card corpus (default: same as cards).
  view <id>            Show full details of a card by id.
  guide <query>        Retrieve and format repair guidance from cards.
  smoke                Run the one-command smoke test.
  doctor               Report what can run locally.
  clear                Clear the screen.
  quit / exit          Exit the TUI.

Plain text (no command) is treated as a search query.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from cheater import __version__
from cheater.audit import audit_file, format_report
from cheater.benchmark import evaluate, format_summary, read_benchmark
from cheater.cards import read_jsonl
from cheater.retrieval import BM25FIndex, format_result, load_index_cards
from cheater.schema import normalize_and_validate

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CARDS = REPO_ROOT / "data" / "cards" / "cards.v1.jsonl"
SAMPLE_CARDS = REPO_ROOT / "data" / "samples" / "sample_cards.v1.jsonl"
SAMPLE_BENCH = REPO_ROOT / "data" / "benchmarks" / "sample_benchmark.jsonl"

HELP_TEXT = """\
Cheater TUI commands:
  help                 Show this help.
  status               Show current state.
  cards <path>         Set card JSONL file to search.
  search <query>       Retrieve cards (BM25F).
  topk <n>             Set number of results (default 5).
  audit [path]         Audit current or given card file.
  bench <path>         Run retrieval benchmark.
  bench-cards <path>   Set benchmark card corpus.
  view <id>            Show full card details by id.
  guide <query>        Retrieve repair guidance.
  smoke                Run one-command smoke test.
  doctor               Report what can run locally.
  clear                Clear screen.
  quit / exit          Exit.

Plain text is treated as a search query.
"""


class CheaterTUI:
    """Interactive shell for Cheater. Pure Python, no external deps."""

    def __init__(self, cards_path: Path | None = None) -> None:
        self.cards_path: Path = cards_path or (DEFAULT_CARDS if DEFAULT_CARDS.is_file() else SAMPLE_CARDS)
        self.bench_cards_path: Path = self.cards_path
        self.top_k: int = 5
        self._cards: list[dict[str, Any]] | None = None
        self._index: BM25FIndex | None = None
        self._running: bool = True

    @property
    def cards(self) -> list[dict[str, Any]]:
        if self._cards is None:
            self._reload()
        return self._cards or []

    @property
    def index(self) -> BM25FIndex:
        if self._index is None:
            self._reload()
        return self._index or BM25FIndex([])

    def _reload(self) -> None:
        if not self.cards_path.is_file():
            self._cards = []
            self._index = BM25FIndex([])
            return
        self._cards = load_index_cards(self.cards_path)
        self._index = BM25FIndex(self._cards)

    def _print(self, *args: Any) -> None:
        print(*args)

    def _err(self, *args: Any) -> None:
        print(*args, file=sys.stderr)

    def run(self) -> int:
        self._print(f"Cheater v{__version__} — bug-memory TUI")
        self._print(f"Cards: {self.cards_path} ({len(self.cards)} usable)")
        self._print("Type 'help' for commands. Plain text searches.")
        self._print()
        while self._running:
            try:
                line = input("cheater> ").strip()
            except (EOFError, KeyboardInterrupt):
                self._print()
                break
            if not line:
                continue
            self._dispatch(line)
        return 0

    def _dispatch(self, line: str) -> None:
        parts = line.split(None, 1)
        cmd = parts[0].lower()
        arg = parts[1].strip() if len(parts) > 1 else ""

        handler = getattr(self, f"_cmd_{cmd}", None)
        if handler is not None:
            handler(arg)
        else:
            self._cmd_search(line)

    def _cmd_help(self, arg: str) -> None:
        self._print(HELP_TEXT)

    def _cmd_status(self, arg: str) -> None:
        self._print(f"Cards file:    {self.cards_path}")
        self._print(f"Usable cards:  {len(self.cards)}")
        self._print(f"Top-k:         {self.top_k}")
        self._print(f"Bench cards:   {self.bench_cards_path}")

    def _cmd_cards(self, arg: str) -> None:
        if not arg:
            self._print(f"Current: {self.cards_path}")
            return
        p = Path(arg).expanduser()
        if not p.is_file():
            self._err(f"File not found: {p}")
            return
        self.cards_path = p
        self._cards = None
        self._index = None
        self._print(f"Cards set to: {p} ({len(self.cards)} usable)")

    def _cmd_topk(self, arg: str) -> None:
        try:
            self.top_k = max(1, int(arg))
            self._print(f"Top-k: {self.top_k}")
        except ValueError:
            self._err("Usage: topk <integer>")

    def _cmd_search(self, arg: str) -> None:
        if not arg:
            self._err("Usage: search <query>  (or just type your query)")
            return
        results = self.index.search(arg, top_k=self.top_k)
        if not results:
            self._print("No matches.")
            return
        self._print(f"Top {len(results)} results for: {arg}")
        for rank, (score, card) in enumerate(results, start=1):
            self._print(format_result(card, rank, score))

    def _cmd_view(self, arg: str) -> None:
        if not arg:
            self._err("Usage: view <card-id>")
            return
        for card in self.cards:
            if card.get("id") == arg:
                self._print(json.dumps(card, ensure_ascii=False, indent=2))
                return
        self._err(f"No card with id: {arg}")

    def _cmd_audit(self, arg: str) -> None:
        path = Path(arg) if arg else self.cards_path
        report = audit_file(path)
        self._err(format_report(report))

    def _cmd_bench(self, arg: str) -> None:
        path = Path(arg) if arg else SAMPLE_BENCH
        if not path.is_file():
            self._err(f"Benchmark file not found: {path}")
            return
        self.bench_cards_path = self.cards_path
        cases = read_benchmark(path)
        summary = evaluate(cases, self.index, top_k=self.top_k)
        self._err(format_summary(summary) + "\n")

    def _cmd_bench_cards(self, arg: str) -> None:
        if not arg:
            self._print(f"Current: {self.bench_cards_path}")
            return
        p = Path(arg).expanduser()
        if not p.is_file():
            self._err(f"File not found: {p}")
            return
        self.bench_cards_path = p
        self._print(f"Bench cards set to: {p}")

    def _cmd_guide(self, arg: str) -> None:
        if not arg:
            self._err("Usage: guide <query>")
            return
        results = self.index.search(arg, top_k=self.top_k)
        if not results:
            self._print("No matching memories found for repair guidance.")
            return
        self._print("=== Repair guidance from memory cards ===")
        self._print("(Treat retrieved bugs as analogies only.)")
        self._print()
        for rank, (score, card) in enumerate(results, start=1):
            self._print(f"## Memory {rank}: {card.get('id')} (score {score:.2f})")
            self._print(f"  Repo:     {card.get('repo') or '(unknown)'}")
            self._print(f"  Language: {card.get('language') or '(unknown)'}")
            self._print(f"  Bug type: {card.get('bug_type') or '(unknown)'}")
            self._print(f"  Symptom:  {card.get('symptom') or '(none)'}")
            self._print(f"  Root cause: {card.get('root_cause') or '(none)'}")
            self._print(f"  Fix:      {card.get('fix_pattern') or '(none)'}")
            fails = card.get("failed_approaches") or []
            if fails:
                self._print(f"  Avoid:    {'; '.join(fails)}")
            kws = card.get("search_keywords") or []
            if kws:
                self._print(f"  Keywords: {', '.join(kws)}")
            self._print()

    def _cmd_smoke(self, arg: str) -> None:
        from cheater.smoke_cli import run as smoke_run
        ns = argparse.Namespace()
        rc = smoke_run(ns)
        self._print(f"Smoke: {'PASS' if rc == 0 else 'FAIL'}")

    def _cmd_doctor(self, arg: str) -> None:
        from cheater.doctor_cli import run as doctor_run
        ns = argparse.Namespace()
        doctor_run(ns)

    def _cmd_clear(self, arg: str) -> None:
        os.system("cls" if os.name == "nt" else "clear")

    def _cmd_quit(self, arg: str) -> None:
        self._running = False

    _cmd_exit = _cmd_quit
    _cmd_q = _cmd_quit


def run_tui(cards_path: Path | None = None) -> int:
    return CheaterTUI(cards_path).run()

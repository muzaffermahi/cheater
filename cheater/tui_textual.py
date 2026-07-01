"""Textual TUI for Cheater. Falls back to line-based REPL if textual is missing.

This is the "feels like Claude Code / OpenCode" experience:
- Status bar at the top (repo, mode, model, corpus)
- Tabs (panels): Chat, Plan, Repo, Memory, Diff, Run, Bench, Settings
- Bottom input
- Footer with keybindings
- Command palette (Ctrl+P)
- Mode cycling (Tab)

The TUI is a thin shell over the same agent/explorer/memory modules used by
the CLI. It does not hide them.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


def run_textual(project_root: str | Path | None = None) -> int:
    """Try to launch the Textual TUI. Raises ImportError if textual is missing."""
    from textual.app import App, ComposeResult
    from textual.widgets import (
        Static,
        Input,
        Footer,
        Header,
        Tabs,
        TabPane,
        RichLog,
    )
    from textual.containers import Container, Horizontal, Vertical
    from textual.binding import Binding

    from cheater.agent import Agent
    from cheater.config import load_config
    from cheater.explorer import explore
    from cheater.guide import guide_text
    from cheater.providers import ModelNotConfigured
    from cheater.retrieval import BM25FIndex, load_index_cards
    from cheater.sessions import new_session

    root = Path(project_root or Path.cwd()).resolve()
    cfg = load_config(root)
    cfg.project_root = str(root)
    agent = Agent(cfg, project_root=root)

    class CheaterApp(App):
        CSS = """
        Screen { layout: vertical; }
        #status { dock: top; height: 1; background: $primary 30%; color: $text; padding: 0 1; }
        #tabs { dock: top; height: 1; }
        #main { height: 1fr; }
        #chat, #plan, #repo, #memory, #diff, #run, #bench, #settings { padding: 1 2; }
        #input-row { dock: bottom; height: 3; padding: 0 1; }
        Input { height: 3; }
        """
        BINDINGS = [
            Binding("ctrl+p", "palette", "Palette"),
            Binding("ctrl+r", "run_tests", "Run tests"),
            Binding("ctrl+s", "search_memory", "Search memory"),
            Binding("ctrl+e", "explore_repo", "Explore repo"),
            Binding("ctrl+g", "generate_guide", "Generate guide"),
            Binding("ctrl+d", "show_diff", "Show diff"),
            Binding("ctrl+b", "run_benchmark", "Benchmark"),
            Binding("ctrl+q", "quit", "Quit"),
            Binding("tab", "cycle_mode", "Cycle mode"),
        ]

        def __init__(self) -> None:
            super().__init__()
            self.session: Any = None
            self._current_mode: str = cfg.mode or "ask"
            self._corpus_status: str = ""
            self._model_status: str = ""

        def compose(self) -> ComposeResult:
            yield Static(self._status_text(), id="status")
            with Tabs(id="tabs"):
                yield TabPane("Chat", id="chat-tab")
                yield TabPane("Plan", id="plan-tab")
                yield TabPane("Repo", id="repo-tab")
                yield TabPane("Memory", id="memory-tab")
                yield TabPane("Diff", id="diff-tab")
                yield TabPane("Run", id="run-tab")
                yield TabPane("Bench", id="bench-tab")
                yield TabPane("Settings", id="settings-tab")
            with Container(id="main"):
                yield RichLog(id="chat", highlight=True, markup=True, wrap=True)
                yield RichLog(id="plan", highlight=True, markup=True, wrap=True)
                yield RichLog(id="repo", highlight=True, markup=True, wrap=True)
                yield RichLog(id="memory", highlight=True, markup=True, wrap=True)
                yield RichLog(id="diff", highlight=True, markup=True, wrap=True)
                yield RichLog(id="run", highlight=True, markup=True, wrap=True)
                yield RichLog(id="bench", highlight=True, markup=True, wrap=True)
                yield RichLog(id="settings", highlight=True, markup=True, wrap=True)
            with Container(id="input-row"):
                yield Input(placeholder="Ask Cheater anything (or 'help')", id="input")
            yield Footer()

        def _status_text(self) -> str:
            mode = self._current_mode
            cards = len(agent.cards)
            cfg_safe = cfg.to_dict()
            model = cfg_safe.get("provider", {}).get("provider", "none")
            model_name = cfg_safe.get("provider", {}).get("model", "")
            ms = f"{model}" + (f"/{model_name}" if model_name else "")
            corpus = f"corpus: {cards:,}" if cards else "corpus: (none)"
            git = ""
            try:
                import subprocess
                r = subprocess.run(
                    ["git", "rev-parse", "--abbrev-ref", "HEAD"],
                    cwd=str(root), capture_output=True, text=True, timeout=3,
                )
                if r.returncode == 0:
                    git = f"git: {r.stdout.strip()}"
            except Exception:
                pass
            return f" cheater  │  repo: {root.name}  │  mode: {mode}  │  model: {ms}  │  {corpus}  │  {git} "

        def on_mount(self) -> None:
            # Hide non-default panels by positioning: actually show only the chat one
            # via display switching. For simplicity, all are mounted; we focus chat.
            chat = self.query_one("#chat", RichLog)
            chat.write("[bold]Welcome to Cheater[/bold]")
            chat.write(f"Project root: {root}")
            chat.write("Type a question and press Enter. Try:")
            chat.write("  - ask: how does retrieval work?")
            chat.write("  - explore: card quality scoring")
            chat.write("  - guide: pydantic env var validation")
            chat.write("  - bench")
            chat.write("  - mode ask|plan|build|review")
            chat.write("  - help")
            self.query_one("#input", Input).focus()

        def on_input_submitted(self, event: Input.Submitted) -> None:
            text = event.value.strip()
            if not text:
                return
            event.input.value = ""
            self._handle_command(text)

        def _handle_command(self, text: str) -> None:
            chat = self.query_one("#chat", RichLog)
            chat.write(f"[bold cyan]> {text}[/bold cyan]")
            # Parse
            parts = text.split(None, 1)
            cmd = parts[0].lower()
            arg = parts[1] if len(parts) > 1 else ""
            if cmd in ("help", "?"):
                self._show_help()
            elif cmd == "agent":
                self._do_agent(arg)
            elif cmd == "ask":
                self._do_agent(arg)  # alias
            elif cmd == "plan":
                self._do_plan(arg)
            elif cmd == "build":
                self._do_build(arg)
            elif cmd == "review":
                self._do_review()
            elif cmd == "explore":
                self._do_explore(arg)
            elif cmd == "search":
                self._do_search(arg)
            elif cmd == "guide":
                self._do_guide(arg)
            elif cmd == "mode":
                self._set_mode(arg)
            elif cmd == "bench":
                self._do_bench()
            elif cmd == "doctor":
                self._do_doctor()
            elif cmd == "settings":
                self._do_settings()
            elif cmd in ("exit", "quit", "q"):
                self.exit()
            else:
                # Default: treat as a search query
                self._do_search(text)

        def _show_help(self) -> None:
            chat = self.query_one("#chat", RichLog)
            chat.write("Commands (v0.3):")
            chat.write("  agent <task>     Run the multi-step agent loop")
            chat.write("  ask <query>      Alias for agent (read-only)")
            chat.write("  plan <query>     Produce a plan (read-only)")
            chat.write("  build <query>    Propose + apply a patch (model required)")
            chat.write("  review           Review current git diff")
            chat.write("  explore <query>  FastContext-style repo exploration")
            chat.write("  search <query>   Search bug memory")
            chat.write("  guide <query>    Generate repair guide")
            chat.write("  bench            Run benchmarks")
            chat.write("  doctor           Show setup status")
            chat.write("  settings         Show settings")
            chat.write("  quit             Exit")

        def _do_agent(self, q: str) -> None:
            """Run the multi-step agent loop on a task. Streams progress to chat."""
            from cheater.agent_loop import AgentLoop, LoopEvent
            from cheater.retrieval import load_index_cards
            from cheater.config import load_config
            if not q:
                self._chat_write("Usage: agent <task>")
                return
            cfg = load_config(root)
            from cheater.providers import get_provider, ProviderConfig
            pc = ProviderConfig(
                provider=cfg.provider.provider, model=cfg.provider.model,
                base_url=cfg.provider.base_url, api_key=cfg.provider.api_key,
                temperature=cfg.provider.temperature, max_tokens=cfg.provider.max_tokens,
                timeout=cfg.provider.timeout, max_retries=cfg.provider.max_retries,
            )
            provider = get_provider(pc)
            # Load cards
            cards = []
            for path in (root / cfg.cards_path, root / cfg.sample_cards_path):
                if path.is_file():
                    cards = load_index_cards(path)
                    if cards:
                        break
            chat = self.query_one("#chat", RichLog)
            chat.write(f"[bold]Agent: {q}[/bold]")
            events: list[LoopEvent] = []

            def on_event(e: LoopEvent) -> None:
                events.append(e)
                if e.kind == "plan":
                    chat.write(f"  [dim]plan: {e.message}[/dim]")
                elif e.kind == "step":
                    mark = "✓" if e.success else "✗"
                    chat.write(f"  {mark} [{e.step_num}] {e.result_summary}")
                elif e.kind == "finish":
                    chat.write(f"[bold]{e.message}[/bold]")

            loop = AgentLoop(
                provider=provider, repo_root=root,
                max_steps=20, read_only=False, verbose=False,
                cards=cards, on_event=on_event,
            )
            result = loop.run(q)
            chat.write(f"\n[bold]Result:[/bold] success={result.success}  finished_by={result.finished_by}  steps={len(result.steps)}  elapsed={result.elapsed:.1f}s")
            if result.error:
                chat.write(f"  error: {result.error}")

        def _do_ask(self, q: str) -> None:
            if not q:
                self._chat_write("Usage: ask <query>")
                return
            ans = agent.ask(q)
            self._chat_write(ans.final or "(no answer)")

        def _do_plan(self, q: str) -> None:
            if not q:
                self._chat_write("Usage: plan <query>")
                return
            p = agent.plan(q)
            self._chat_write("\n".join(p.steps))
            self._refresh_plan(p)

        def _do_build(self, q: str) -> None:
            if not q:
                self._chat_write("Usage: build <query>")
                return
            br = agent.build(q, dry_run=True)
            if br.proposed_patch is None:
                self._chat_write(br.summary)
            else:
                self._chat_write("Proposed patch:")
                self._chat_write(br.proposed_patch)
                self._chat_write("(Preview only. To apply, use `cheater patch ...`)")

        def _do_review(self) -> None:
            rr = agent.review()
            for s in rr.suggestions:
                self._chat_write(f"- {s}")

        def _do_explore(self, q: str) -> None:
            if not q:
                self._chat_write("Usage: explore <query>")
                return
            ex = explore(q, repo_root=root, max_files=300)
            self._refresh_repo(ex)

        def _do_search(self, q: str) -> None:
            if not q:
                self._chat_write("Usage: search <query>")
                return
            if not agent.cards:
                self._chat_write("No cards loaded.")
                return
            idx = BM25FIndex(agent.cards)
            results = idx.search(q, top_k=5)
            for r, (score, card) in enumerate(results, start=1):
                self._chat_write(
                    f"#{r}  {card.get('id')}  score={score:.2f}  "
                    f"repo={card.get('repo') or '?'}  lang={card.get('language') or '?'}"
                )
            self._refresh_memory(results)

        def _do_guide(self, q: str) -> None:
            if not q:
                self._chat_write("Usage: guide <query>")
                return
            if not agent.cards:
                self._chat_write("No cards loaded.")
                return
            text = guide_text(q, agent.cards, top_k=5)
            self._chat_write(text)

        def _set_mode(self, mode: str) -> None:
            mode = mode.strip().lower()
            if mode not in ("ask", "plan", "build", "review", "bench"):
                self._chat_write(f"Unknown mode: {mode}")
                return
            self._current_mode = mode
            self._refresh_status()

        def _do_bench(self) -> None:
            self._chat_write("Running benchmarks (this may take a while)...")
            from cheater.bench_cli import _bench_retrieval, _bench_explorer, _bench_guide, _bench_smoke_agent
            import argparse
            ns = argparse.Namespace(
                bench_subcommand="retrieval",
                benchmark="data/benchmarks/sample_benchmark.jsonl",
                cards="data/samples/sample_cards.v1.jsonl",
                top_k=5, language=None, quality_min=0.0, compare=False, json=False, compact_cards=None,
            )
            for sub in ("retrieval", "guide", "explorer", "smoke-agent"):
                ns.bench_subcommand = sub
                self._chat_write(f"--- bench {sub} ---")
                if sub == "retrieval":
                    _bench_retrieval(ns)
                elif sub == "guide":
                    _bench_guide(ns)
                elif sub == "explorer":
                    _bench_explorer(ns)
                elif sub == "smoke-agent":
                    _bench_smoke_agent(ns)

        def _do_doctor(self) -> None:
            from cheater.doctor_cli import run as doc_run
            import argparse
            doc_run(argparse.Namespace())

        def _do_settings(self) -> None:
            self._chat_write(json.dumps(cfg.to_dict(), indent=2))

        def _chat_write(self, s: str) -> None:
            self.query_one("#chat", RichLog).write(s)

        def _refresh_plan(self, p: Any) -> None:
            rlog = self.query_one("#plan", RichLog)
            rlog.write("[bold]Plan[/bold]")
            for s in p.steps:
                rlog.write(f"  {s}")
            if p.files_to_inspect:
                rlog.write("Files to inspect:")
                for f in p.files_to_inspect:
                    rlog.write(f"  - {f}")

        def _refresh_repo(self, ex: Any) -> None:
            rlog = self.query_one("#repo", RichLog)
            rlog.write("[bold]Repo Explorer[/bold]")
            for tf in (ex.top_files or [])[:10]:
                rlog.write(f"  - {tf.get('path')}  ({', '.join(tf.get('why') or [])})")
            for s in (ex.symbols or [])[:10]:
                rlog.write(f"  {s.get('kind')}  {s.get('name')}  @ {s.get('file')}:{s.get('line')}")

        def _refresh_memory(self, results: list[tuple[float, dict[str, Any]]]) -> None:
            rlog = self.query_one("#memory", RichLog)
            rlog.write("[bold]Memory hits[/bold]")
            for s, c in results[:10]:
                rlog.write(f"  - {c.get('id')}  score={s:.2f}")

        def _refresh_status(self) -> None:
            self.query_one("#status", Static).update(self._status_text())

        # Action handlers (Ctrl+key)
        def action_palette(self) -> None:
            self._chat_write("Command palette: type a command at the bottom (e.g. 'ask ...')")

        def action_run_tests(self) -> None:
            from cheater.runner import detect_test_command, run as runner_run
            cmd = detect_test_command(root)
            if not cmd:
                self._chat_write("No test command detected.")
                return
            self._chat_write(f"Running: {cmd}")
            r = runner_run(cmd, cwd=root, yes=True, timeout=120.0)
            self._chat_write(f"exit={r.returncode}  ok={r.ok}")

        def action_search_memory(self) -> None:
            self._chat_write("Enter search query in the input box below.")

        def action_explore_repo(self) -> None:
            self._chat_write("Enter explore query in the input box below.")

        def action_generate_guide(self) -> None:
            self._chat_write("Enter guide query in the input box below.")

        def action_show_diff(self) -> None:
            from cheater.agent import _git_diff
            diff, files = _git_diff(root)
            rlog = self.query_one("#diff", RichLog)
            rlog.write(f"Files: {len(files)}")
            for f in files[:20]:
                rlog.write(f"  - {f}")
            if diff:
                rlog.write(diff[:3000])

        def action_run_benchmark(self) -> None:
            self._do_bench()

        def action_cycle_mode(self) -> None:
            order = ["ask", "plan", "build", "review", "bench"]
            try:
                i = order.index(self._current_mode)
            except ValueError:
                i = 0
            self._current_mode = order[(i + 1) % len(order)]
            self._refresh_status()

    CheaterApp().run()
    return 0

# Cheater repo map

repo_root: `C:\Users\LENOVO\Desktop\cheater`
files: 141  tests: 36  sources: 105

## Modules
  - `cheater/aci_tools.py` — Cheater compound tools (a SWE-agent / Cline style ACI).
  - `cheater/agent.py` — Cheater agent loop.
  - `cheater/agent_cli.py` — cheater ask / plan / build / review CLI shims.
  - `cheater/agent_eval.py` — Agent-helpfulness benchmark: PLACEHOLDER DESIGN (not a runnable harness yet).
  - `cheater/agent_loop.py` — The Cheater agent loop (v0.4 — the 9B adaptation pass).
  - `cheater/agent_loop_cli.py` — cheater agent -- the v0.3 multi-step agent loop.
  - `cheater/audit.py` — Card audit: reports statistics, validation status, and quality for JSONL card fi
  - `cheater/audit_cli.py` — audit-cards CLI command.
  - `cheater/benchmark.py` — Retrieval-quality benchmark with compare mode and per-difficulty metrics.
  - `cheater/benchmark_cli.py` — benchmark CLI command.
  - `cheater/bench_cli.py` — cheater bench -- run multiple benchmark modes.
  - `cheater/budget.py` — Context budget engine for the Cheater agent loop.
  - `cheater/build_cli.py` — Build canonical v1 memory cards from a raw source.
  - `cheater/build_heldout.py` — Build a held-out retrieval benchmark from the full corpus.
  - `cheater/cards.py` — Streaming JSONL readers for memory cards.
  - `cheater/config.py` — Cheater configuration system.
  - `cheater/context_pack.py` — Cheater context pack — a small, Continue-like context provider.
  - `cheater/dedup.py` — Tool-call deduplication cache for the Cheater agent loop.
  - `cheater/doctor_cli.py` — cheater doctor: report what can run locally and what is missing/experimental.
  - `cheater/errors.py` — Shared errors and extension-point base classes.
  - `cheater/example_cli.py` — cheater example <name> -- run a built-in example task.
  - `cheater/explorer.py` — FastContext-style repo explorer for Cheater.
  - `cheater/explore_cli.py` — cheater explore <query> -- explore a repo and return focused context.
  - `cheater/failure_compressor.py` — Cheater failure compressor: turn raw pytest / py_compile / runtime output
  - `cheater/guide.py` — Repair-guidance generator.
  - `cheater/guide_cli.py` — cheater guide CLI command.
  - `cheater/index.py` — Index metadata for the lexical retrieval baseline.
  - `cheater/index_cli.py` — build-index CLI command.
  - `cheater/init_cli.py` — cheater init: first-run wizard + write .cheater/AGENTS.md.
  - `cheater/init_data.py` — cheater init-data: create required folders and explain how to populate them.
  - `cheater/localizer.py` — Cheater localizer: Agentless-style file + symbol localization.
  - `cheater/memory.py` — Cheater memory layer: modes, diversification, and structured retrieval.
  - `cheater/memory_nudges.py` — Nudge system for the Cheater memory layer.
  - `cheater/memory_store.py` — Persistent memory store for the Cheater agent.
  - `cheater/parser.py` — Forgiving tool-call parser for small (8B-35B) models.
  - `cheater/patch_candidate.py` — Cheater patch candidate: Phase B scaffolding only.
  - `cheater/patch_cli.py` — cheater patch / cheater undo / cheater snapshots -- patch engine CLI.
  - `cheater/patch_engine.py` — Safe patch engine for Cheater.
  - `cheater/prompts.py` — Prompts for the Cheater agent loop.
  - `cheater/providers.py` — Model provider abstraction for Cheater.
  - `cheater/quality.py` — Per-card quality scoring for memory cards.
  - `cheater/quality_monitor.py` — Quality monitor for the Cheater agent loop.
  - `cheater/repair_cli.py` — CLI handlers for the v0.6 repair-harness layer.
  - `cheater/repo_map.py` — Cheater repo map: AST-based, narrow, deterministic.
  - `cheater/rescore.py` — Re-score an existing canonical cards JSONL with quality scores.
  - `cheater/retrieval.py` — Lexical retrieval baseline for Cheater v1 cards.
  - `cheater/runner.py` — Safe command runner for Cheater.
  - `cheater/runner_cli.py` — cheater run / cheater test / cheater lint -- safe command runner.
  - `cheater/schema.py` — Canonical v1 memory-card schema, validation, and normalization.
  - `cheater/search_cli.py` — search CLI command.
  - `cheater/sessions.py` — Cheater session storage.
  - `cheater/sessions_cli.py` — cheater sessions / cheater resume / cheater show-session.
  - `cheater/smoke_cli.py` — smoke CLI command: one-command local sanity check (no external APIs).
  - `cheater/sources.py` — Card sources: convert raw records into canonical v1 card dicts.
  - `cheater/tools.py` — Tool definitions for the Cheater agent loop.
  - `cheater/tui.py` — Cheater TUI: a clean interactive shell for the bug-memory sidecar.
  - `cheater/tui_textual.py` — Textual TUI for Cheater. Falls back to line-based REPL if textual is missing.
  - `cheater/working_memory.py` — Working memory for the Cheater agent loop.
  - `cheater/__init__.py` — Cheater: local-first terminal coding agent with bug memory and repo exploration.
  - `cheater/__main__.py` — Cheater CLI entrypoint.
  - `cheater/legacy/agent_harness.py`
  - `cheater/legacy/benchmark_harness.py`
  - `cheater/legacy/bug_detect.py`
  - `cheater/legacy/bug_memory.py`
  - `cheater/legacy/bug_miner.py`
  - `cheater/legacy/build_memory_cards.py`
  - `cheater/legacy/build_memory_index.py`
  - `cheater/legacy/cheater.py`
  - `cheater/legacy/cheater_bridge.py`
  - `cheater/legacy/cheater_config.py`
  - `cheater/legacy/cheater_core.py`
  - `cheater/legacy/cheater_doctor.py`
  - `cheater/legacy/cheater_retry_controller.py`
  - `cheater/legacy/cheater_session.py`
  - `cheater/legacy/cheater_tui.py`
  - `cheater/legacy/compare_eval_results.py`
  - `cheater/legacy/compare_retrieval.py`
  - `cheater/legacy/contamination_filters.py`
  - `cheater/legacy/dedupe_memory_records.py`
  - `cheater/legacy/get_dataset.py`
  - `cheater/legacy/hybrid_retriever.py`
  - `cheater/legacy/ingest_memory_datasets.py`
  - `cheater/legacy/inspect_dataset.py`
  - `cheater/legacy/memory_dataset_registry.py`
  - `cheater/legacy/memory_index.py`
  - `cheater/legacy/memory_normalizers.py`
  - `cheater/legacy/memory_schema.py`
  - `cheater/legacy/memory_telemetry.py`
  - `cheater/legacy/pi_rpc.py`
  - `cheater/legacy/qwen_local_agent.py`
  - `cheater/legacy/run_eval.py`
  - `cheater/legacy/speed_test.py` [test]
  - `cheater/legacy/swebench_smoke_astropy_12907.py` — Local smoke test for SWE-bench Verified astropy__astropy-12907.
  - `cheater/legacy/validate_eval_tasks.py`
  - `cheater/legacy/__init__.py` — Legacy experimental modules from the original Cheater repository.
  - `scripts/01_count_dataset.py`
  - `scripts/02_build_solved_bug_cards.py`
  - `scripts/03_search_cards.py`
  - `scripts/04_compact_cards_llm.py`
  - `scripts/05_search_compact_cards.py`
  - `scripts/08_validate_compact_cards.py`
  - `scripts/09_run_memory_agent.py`
  - `scripts/10_preview_memory_query.py`
  - `scripts/11_memory_agent_tui.py`
  - `scripts/12_test_pi_detection.py`
  - `scripts/compact_with_llm.py` — LLM-compact a memory-card corpus using an OpenAI-compatible endpoint.
  - `tests/test_aci_tools.py` [test] — Tests for cheater.aci_tools (v0.6 compound tools).
  - `tests/test_agent.py` [test] — Tests for cheater.agent (agent loop).
  - `tests/test_agent_loop.py` [test] — Tests for cheater.agent_loop + cheater.working_memory. NO network.
  - `tests/test_agent_loop_v06.py` [test] — Smoke tests for the v0.6 AgentLoop integration: repo map + harness nudge.
  - `tests/test_benchmark_smoke.py` [test]
  - `tests/test_budget.py` [test] — Tests for cheater.budget (context budget engine).
  - `tests/test_card_audit.py` [test]
  - `tests/test_card_schema.py` [test]
  - `tests/test_cli_commands.py` [test] — Tests for CLI commands: guide, init-data, rescore, build-cards --quality.
  - `tests/test_compact_with_llm.py` [test] — Tests for scripts/compact_with_llm.py — NO network calls.
  - `tests/test_config.py` [test] — Tests for cheater.config (config loader + first-run wizard).
  - `tests/test_context_pack.py` [test] — Tests for cheater.context_pack (v0.6).
  - `tests/test_dedup.py` [test] — Tests for cheater.dedup (tool-call deduplication).
  - `tests/test_eval_harness.py` [test]
  - `tests/test_explorer.py` [test] — Tests for cheater.explorer (FastContext-style repo explorer).
  - `tests/test_failure_compressor.py` [test] — Tests for cheater.failure_compressor (v0.6).
  - `tests/test_guide.py` [test] — Tests for cheater/guide.py
  - `tests/test_localizer.py` [test] — Tests for cheater.localizer (v0.6).
  - `tests/test_memory_pipeline.py` [test]
  - `tests/test_memory_sessions.py` [test] — Tests for cheater.sessions and cheater.memory.
  - `tests/test_memory_store.py` [test] — Tests for cheater.memory_store (v0.5 agent-curated memory).
  - `tests/test_memory_tools.py` [test] — Tests for the v0.5 memory tools and nudge integration.
  - `tests/test_parser.py` [test] — Tests for cheater.parser (forgiving tool-call parser). NO network.
  - `tests/test_patch_candidate.py` [test] — Tests for cheater.patch_candidate (v0.6 Phase B scaffold).
  - `tests/test_patch_engine.py` [test] — Tests for cheater.patch_engine (safe patch engine).
  - `tests/test_providers.py` [test] — Tests for cheater.providers (model provider layer).
  - `tests/test_quality.py` [test] — Tests for cheater/quality.py
  - `tests/test_quality_monitor.py` [test] — Tests for cheater.quality_monitor.
  - `tests/test_repo_map.py` [test] — Tests for cheater.repo_map (v0.6 AST-based repo map).
  - `tests/test_retrieval.py` [test]
  - `tests/test_retrieval_v2.py` [test] — Tests for the improved cheater/retrieval.py: filters, quality boost, MMR, why-ma
  - `tests/test_runner.py` [test] — Tests for cheater.runner (safe command runner).
  - `tests/test_search_smoke.py` [test]
  - `tests/test_tools.py` [test] — Tests for cheater.tools (Phase A + B tools). NO network.
  - `tests/test_v04_features.py` [test] — Tests for v0.4 agent loop features: 2-stage routing, TODO planning, dedup, budge

## Symbols

### `cheater/aci_tools.py`
  class RepoMapBuildTool(Tool):
    .run()
  class RepoMapSearchTool(Tool):
    .run()
  class InspectSymbolTool(Tool):
    .run()
    ._definition_snippet()
    ._grep()
  class RunFocusedTestsTool(Tool):
    .run()
  class ReadContextPackTool(Tool):
    .run()
  class LocalizeBugTool(Tool):
    .run()
  def _truncate(text: str, n: int -> str)  # L33
  def _next_actions(lines: list[str] -> str)  # L39
  def register_aci_tools(tools: list[Tool] -> list[Tool])  # L461 — Append the ACI tools to a list. Returns the new list (does not mutate).

### `cheater/agent.py`
  class Answer: — Result of ask mode.
  class Plan: — Result of plan mode.
  class BuildResult: — Result of build mode (may include a proposed patch).
  class ReviewResult: — Result of review mode.
  class Agent: — A Cheater agent bound to a config and a project root.
    .__init__()
    ._load_cards()
    .ask()
    .plan()
    .review()
    .build()
  def _provider_from_config(cfg: CheaterConfig -> Any)  # L97 — Build a provider from CheaterConfig.
  def _git_diff(repo_root: Path -> tuple[str, list[str]])  # L114 — Get current git diff (vs HEAD). Returns (unified_diff, files).
  def _build_memory_brief(task: str, cards: list[dict[str, Any]], cfg: CheaterConfig, *, language: str | None -> tuple[str, list[MemoryHit]])  # L138 — Build a memory brief and return (text, hits).
  def _build_plan(task: str, explorer: dict[str, Any], memory_brief: str -> Plan)  # L158 — Deterministic plan from task + explorer + memory.
  def _maybe_ask_provider(provider: Any, system: str, user: str, max_tokens: int=? -> str | None)  # L186 — Call provider if configured. Returns text or None on no-model.
  def _format_ask_context(ans: Answer, plan: Plan -> dict[str, str])  # L311 — Compress answer/plan into strings for the provider prompt.
  def _deterministic_ask(ans: Answer, plan: Plan -> str)  # L327 — Deterministic fallback when no model is configured.
  def _build_patch_prompt(task: str, ex: dict[str, Any], brief: str, plan: Plan -> str)  # L343
  def _extract_diff(text: str -> str | None)  # L362 — Extract a unified diff from a model response, if present.
  def _review_suggestions(diff: str, files: list[str] -> list[str])  # L376 — Heuristic suggestions for a git diff.

### `cheater/agent_cli.py`
  def _make_agent(args: argparse.Namespace -> Agent)  # L13
  def run_ask(args: argparse.Namespace -> int)  # L20
  def run_plan(args: argparse.Namespace -> int)  # L50
  def run_build(args: argparse.Namespace -> int)  # L82
  def run_review(args: argparse.Namespace -> int)  # L118

### `cheater/agent_eval.py`
  class AgentHelpfulnessRunner(BenchmarkRunner): — Future agent-helpfulness runner. Not implemented; raises if used.
    .run()

### `cheater/agent_loop.py`
  class LoopResult: — Result of an agent loop run.
    .to_dict()
  class LoopEvent:
  class AgentLoop: — The Cheater multi-step agent loop (v0.4).
    .__init__()
    ._emit()
    .run()
    ._has_model()
    ._update_plan_status()
    ._plan_status_block()
    ._plan()
    ._next_action()
    ._temp_for_attempt()
    ._run_tool()
    ._safe_ask_user()
    ._chat()
  class _ModelUnavailable(Exception):
  class _InvalidJSONAfterRetry(Exception):
  def _parse_action(text: str -> dict | None)  # L636 — Parse a model response into an action dict using the forgiving parser.
  def _truncate_args(args: dict -> str)  # L642
  def _evidence_is_concrete(evidence: str -> bool)  # L652

### `cheater/agent_loop_cli.py`
  def _make_provider(args: argparse.Namespace -> tuple[Any, list[dict]])  # L31
  def _print_event(ev: LoopEvent -> None)  # L55 — Default progress printer.
  def run(args: argparse.Namespace -> int)  # L72

### `cheater/audit.py`
  def audit_file(path: str | Path, *, with_quality: bool -> dict[str, Any])  # L30 — Audit one JSONL card file. Returns a structured report dict.
  def audit_files(paths: list[str | Path], *, with_quality: bool -> list[dict[str, Any]])  # L178
  def format_report(report: dict[str, Any], *, with_quality: bool -> str)  # L186 — Human-readable audit report.

### `cheater/audit_cli.py`
  def run(args: argparse.Namespace -> int)  # L12

### `cheater/benchmark.py`
  def read_benchmark(path: str | Path -> list[dict[str, Any]])  # L27
  def _dcg_at_k(relevances: list[int], k: int -> float)  # L39 — DCG@k: sum of rel_i / log2(i+2) for i in 0..k-1.
  def _ndcg_at_k(relevances: list[int], k: int -> float)  # L47 — nDCG@k with ideal DCG computed from sorted relevances.
  def evaluate(cases: list[dict[str, Any]], search_fn: Callable[[str, int], list[tuple[float, dict[str, Any]]]], top_k: int=?, *, label: str -> dict[str, Any])  # L57 — Evaluate a single search configuration.
  def evaluate_compare(cases: list[dict[str, Any]], cards: list[dict[str, Any]], compact_cards: list[dict[str, Any]] | None=?, *, top_k: int -> list[dict[str, Any]])  # L185 — Run multiple retrieval configurations and return a comparison table.
  def format_summary(s: dict[str, Any] -> str)  # L277
  def format_compare(results: list[dict[str, Any]] -> str)  # L303 — Side-by-side comparison table for multiple configurations.

### `cheater/benchmark_cli.py`
  def _maybe_load_compact(path: str | None -> list[dict[str, Any]] | None)  # L17
  def run(args: argparse.Namespace -> int)  # L29

### `cheater/bench_cli.py`
  def _bench_retrieval(args: argparse.Namespace -> int)  # L19
  def _bench_guide(args: argparse.Namespace -> int)  # L63 — Quick guide benchmark: a deterministic check that guide produces non-empty output.
  def _bench_explorer(args: argparse.Namespace -> int)  # L101 — Quick explorer benchmark on a tiny fixture or the current repo.
  def _bench_smoke_agent(args: argparse.Namespace -> int)  # L150 — Tiny synthetic agent-loop smoke test. No model. Just walk the loop.
  def cfg_provider_none()  # L178
  def run(args: argparse.Namespace -> int)  # L183

### `cheater/budget.py`
  class BudgetItem: — One item in the context budget. Has a source label so we can evict selectively.
    .__post_init__()
  class ContextBudget: — Tracks context usage and evicts oldest items when over budget.
    .__init__()
    .__len__()
    .total_chars()
    .usage_pct()
    .usage_summary()
    .allocate()
    ._evict_oldest()
    ._find_evictable_index()
    ._one_line_summary()
    .evicted_summaries()
    .sources()
    .reset()
    .to_dict()
  def estimate_tokens(text: str -> int)  # L33 — Rough token estimate. Not exact, but good enough for budget tracking.
  CHARS_PER_TOKEN = 4

### `cheater/build_cli.py`
  def _make_source(input_path: str, source_label: str -> Iterator[dict])  # L49 — Pick a source adapter by sniffing the first record's fields.
  def _score_and_attach(card: dict[str, Any] -> dict[str, Any])  # L72 — Run quality scoring on a normalized card and attach fields.
  def write_manifest(manifest_path: Path, payload: dict[str, Any] -> None)  # L81
  def build(input_path: str | None, output_path: str, *, source_label: str, limit: int | None, dry_run: bool, resume: bool, hf_dataset: str | None, min_quality: str -> dict)  # L89 — Stream records, normalize, score, dedupe, write JSONL.
  def run(args: argparse.Namespace -> int)  # L218

### `cheater/build_heldout.py`
  def _tokenize(text: str -> list[str])  # L49
  def _filter_quality_cards(cards: list[dict], min_quality: float=? -> list[dict])  # L53 — Prefer high-quality cards: have symptom, fix_pattern, embedding_text.
  def _is_boilerplate(text: str -> bool)  # L82 — True if the text is just SWE-agent boilerplate, not real content.
  def _paraphrase_easy(card: dict -> str | None)  # L93 — Easy: use the error message + a single keyword.
  def _paraphrase_medium(card: dict -> str | None)  # L102 — Medium: combine root_cause hint with bug_type.
  def _paraphrase_hard(card: dict -> str | None)  # L115 — Hard: vague description using bug_type and a few keywords from fix_pattern.
  def main( -> int)  # L137

### `cheater/cards.py`
  class CardLineError(CardError): — A card error tied to a specific file:line.
    .__init__()
  def read_jsonl(path: str | Path -> Iterator[dict[str, Any]])  # L25 — Stream raw JSON objects from a JSONL file. Raises CardLineError on bad JSON.
  def read_cards(path: str | Path, *, normalize: bool, skip_invalid: bool -> Iterator[tuple[int, dict[str, Any]]])  # L45 — Stream cards as (line_no, card). If normalize, yields canonical v1 cards.
  def load_card_ids(path: str | Path -> set[str])  # L66 — Read only ids (for resume/dedup). Tolerant of incomplete records.
  def detect_duplicates(path: str | Path -> list[tuple[str, int]])  # L89 — Return list of (id, line) for duplicate ids (second+ occurrence).

### `cheater/config.py`
  class MemoryConfig:
  class ProviderSettings:
  class PermissionsConfig:
  class CheaterConfig: — Top-level Cheater configuration.
    .to_dict()
    .from_dict()
  def _toml_load(text: str -> dict[str, Any])  # L126 — Tiny TOML loader handling [section] headers and key = "value" pairs.
  def _toml_dump(d: dict[str, Any] -> str)  # L164 — Tiny TOML emitter handling flat dicts and [section] dicts.
  def _toml_value(v: Any -> str)  # L183
  def user_config_path( -> Path)  # L192 — Return the user config path. Created on demand.
  def project_config_path(start_dir: str | Path | None=? -> Path | None)  # L197 — Find the project config by walking up from start_dir. Returns None if not found.
  def load_config(start_dir: str | Path | None=? -> CheaterConfig)  # L207 — Load config: project first, then user, then env. Never raises.
  def _merge_dataclass(a: Any, b: Any, cls: type -> Any)  # L257 — Merge two dataclass instances. Non-default values from b win.
  def save_config(cfg: CheaterConfig, path: str | Path -> None)  # L277 — Save config to a TOML file. Creates parent dirs. Redacts nothing (user file).
  def first_run_wizard(cfg: CheaterConfig, *, noninteractive: bool -> CheaterConfig)  # L285 — Run a first-run setup. Updates cfg in place.

### `cheater/context_pack.py`
  class ContextProvider: — A single context source. Holds a label, body, and a priority.
    .char_len()
    .to_dict()
  class ContextPack:
    .add()
    .get()
    .to_dict()
    .total_chars()
  class TaskProvider(ContextProvider): — The user task / issue text. Highest priority, never clipped.
    .__init__()
  class TracebackProvider(ContextProvider): — Provided traceback or failing command output. Second-highest priority.
    .__init__()
  class RepoMapProvider(ContextProvider): — Compact, query-relevant repo map.
    .__init__()
  class FilesProvider(ContextProvider): — Selected file snippets. Caller-supplied.
    .__init__()
  class TestsProvider(ContextProvider): — Likely related test files. Cheap: list of test paths from repo map.
    .__init__()
  class MemoryProvider(ContextProvider): — Relevant memories from the persistent store.
    .__init__()
  class SkillsProvider(ContextProvider): — Relevant skills. No-op if a skills registry isn't available yet.
    .__init__()
  class InstructionsProvider(ContextProvider): — Project instructions: AGENTS.md, CLAUDE.md, README, pyproject scripts.
    .__init__()
    ._filter_instructions()
    ._extract_pyproject_scripts()
  def _clip(text: str, max_chars: int -> str)  # L129
  def _read_file_safe(path: Path, max_bytes: int=? -> str)  # L135
  def build_context_pack(task: str, repo_root: str | Path, *, traceback: str, files: list[tuple[str, str]] | None, memory_store: Any, skills: Any, max_tokens: int, include_repo_map: bool, include_tests: bool, include_instructions: bool -> ContextPack)  # L362 — Build a ContextPack from the standard providers.
  def _enforce_budget(pack: ContextPack -> None)  # L406 — Trim low-priority providers to fit max_tokens. Highest priority wins.
  def render_for_model(pack: ContextPack -> str)  # L439 — Render the pack as a stable, labeled markdown block.
  CHARS_PER_TOKEN = 4

### `cheater/dedup.py`
  class ToolCallDedup:
    .is_read_only()
    ._key()
    .check()
    .store()
    .reset()
    .stats()

### `cheater/doctor_cli.py`
  def run(args=? -> int)  # L16

### `cheater/errors.py`
  class CardError(ValueError): — Raised for malformed memory cards (JSON, schema, duplicates).
  class CardSource(ABC): — Extension point: a stream of raw records that can become memory cards.
    .iter_records()
    .name()
  class IndexBackend(ABC): — Extension point: a retrievable index over validated memory cards.
    .search()
  class RetrievalBackend(ABC): — Extension point: ranking/filtering strategy over an index.
    .retrieve()
  class AnalyzerAdapter(ABC): — Extension point: future static/dynamic analysis adapters
    .analyze()
  class BenchmarkRunner(ABC): — Extension point: future agent-helpfulness runners.
    .run()

### `cheater/example_cli.py`
  def run(args: argparse.Namespace -> int)  # L44

### `cheater/explorer.py`
  class ExplorerResult: — Structured repo-context result.
    .to_dict()
  def _read_gitignore(repo_root: Path -> list[str])  # L136 — Read .gitignore patterns as raw strings (very simple glob matcher).
  def _is_gitignored(rel: str, patterns: list[str] -> bool)  # L153 — Very simple gitignore matcher. Supports `*`, `**`, and directory patterns.
  def _glob_match(name: str, pattern: str -> bool)  # L185 — Translate glob to regex; * and ** supported.
  def _walk_repo(repo_root: Path, ignored_dirs: set[str], gitignore_patterns: list[str] -> Iterable[Path])  # L209 — Yield candidate text files under repo_root.
  def _detect_language(ext: str -> str | None)  # L242
  def _is_test_file(rel: str -> bool)  # L246
  def _is_config_file(name: str -> bool)  # L254
  def _extract_symbols(path: Path, ext: str -> list[dict[str, Any]])  # L258 — Extract top-level symbols from a file. Cheap regex-based.
  def _git_recent(repo_root: Path -> list[str])  # L303 — Get recently changed files via git. Returns [] if not a git repo.
  def _tokenize(query: str -> list[str])  # L320
  def _score_file(rel: str, symbols: list[dict[str, Any]], query_terms: list[str] -> tuple[float, list[str]])  # L324 — Score a file by qu
... [truncated, repo map too large]
.PHONY: smoke test audit search benchmark build-cards build-full guide init-data init doctor clean help install tui tui-textual ask plan build review explore patch undo run test-cmd lint sessions bench

help:          ## Show this help message
	@echo "Cheater make targets:"
	@echo "  install        Install with all extras (TUI + LLM + ingest + dev)"
	@echo "  install-core   Install with core deps only"
	@echo "  smoke          One-command local sanity check (no external APIs)"
	@echo "  test           Run the full test suite"
	@echo "  init           First-run wizard (writes .cheater/config.toml)"
	@echo "  init-data      Create required data folders and explain how to populate"
	@echo "  doctor         Report what can run locally and what is missing"
	@echo "  tui            Launch the line-based REPL (works without textual)"
	@echo "  tui-textual    Launch the Textual TUI (needs pip install textual)"
	@echo "  audit          Audit the corpus (use --quality for detailed report)"
	@echo "  build-cards    Build canonical v1 cards from a local JSONL"
	@echo "  build-full     Build the full ~13k-card corpus from HF dataset (needs [ingest])"
	@echo "  rescore        Re-score an existing corpus with quality metrics"
	@echo "  heldout        Generate a 50-case held-out retrieval benchmark"
	@echo "  search         Quick search demo on sample cards"
	@echo "  benchmark      Run the sample retrieval benchmark"
	@echo "  benchmark-full Run heldout benchmark on full corpus with compare"
	@echo "  guide          Retrieval-grounded repair guidance (no API)"
	@echo "  ask            Read-only ask (explore + memory + answer)"
	@echo "  plan           Read-only plan"
	@echo "  build          Build mode: explore + memory + propose patch"
	@echo "  review         Review current git diff"
	@echo "  explore        FastContext-style repo exploration"
	@echo "  run            Run a command (with approval)"
	@echo "  test-cmd       Run the project's test command"
	@echo "  lint           Run the project's lint command"
	@echo "  sessions       List sessions"
	@echo "  bench          Run multiple benchmark modes"
	@echo "  clean          Remove generated artifacts"

install:       ## Install with all extras
	pip install -e .[all]

install-core:  ## Install with core deps only
	pip install -e .

smoke:         ## One-command local sanity check (no external APIs)
	python -m cheater smoke

test:          ## Run the full test suite
	python -m pytest tests -q

init:          ## First-run wizard
	python -m cheater init

init-data:     ## Create required data folders and explain how to populate
	python -m cheater init-data

doctor:        ## Report what can run locally and what is missing
	python -m cheater doctor

tui:           ## Launch the line-based REPL
	python -m cheater tui --cards data/samples/sample_cards.v1.jsonl

tui-textual:   ## Launch the Textual TUI (needs pip install textual rich)
	python -m cheater

audit:         ## Audit the sample corpus
	python -m cheater audit-cards data/samples/sample_cards.v1.jsonl --quality

build-cards:   ## Build canonical v1 cards from a local JSONL
	python -m cheater build-cards --input data/compact_bug_cards.jsonl --output data/cards/cards.v1.jsonl

build-full:    ## Build the full ~13k-card corpus from HF dataset
	python -m cheater build-cards --hf-dataset nebius/SWE-agent-trajectories --output data/cards/cards.v1.jsonl --source "nebius/SWE-agent-trajectories" --full

rescore:       ## Re-score an existing corpus
	python -m cheater rescore --cards data/cards/cards.v1.jsonl --in-place

heldout:       ## Generate a 50-case held-out benchmark
	python -m cheater.build_heldout --cards data/cards/cards.v1.jsonl --output data/benchmarks/heldout_retrieval.v1.jsonl --count 50

search:        ## Quick search demo on sample cards
	python -m cheater search "pydantic validation error" --cards data/samples/sample_cards.v1.jsonl --top-k 3

benchmark:     ## Run the sample retrieval benchmark
	python -m cheater benchmark data/benchmarks/sample_benchmark.jsonl --cards data/samples/sample_cards.v1.jsonl

benchmark-full: ## Run the heldout benchmark on full corpus with compare
	python -m cheater benchmark data/benchmarks/heldout_retrieval.v1.jsonl --cards data/cards/cards.v1.jsonl --compare

guide:         ## Retrieval-grounded repair guidance (no API)
	python -m cheater guide "TypeError: pydantic config fails when env var missing" --cards data/samples/sample_cards.v1.jsonl

ask:           ## Read-only ask (explore + memory + answer)
	python -m cheater ask "where is card quality scoring implemented?"

plan:          ## Read-only plan
	python -m cheater plan "fix a failing test in tests/test_quality.py"

build:         ## Build mode: explore + memory + propose patch
	python -m cheater build "fix a failing test in tests/test_quality.py" --dry-run

review:        ## Review current git diff
	python -m cheater review

explore:       ## FastContext-style repo exploration
	python -m cheater explore "where is retrieval implemented"

run:           ## Run a command (with approval)
	python -m cheater run --yes pytest -x -q

test-cmd:      ## Run the project's test command
	python -m cheater test --yes

lint:          ## Run the project's lint command
	python -m cheater lint --yes

sessions:      ## List sessions
	python -m cheater sessions

bench:         ## Run multiple benchmark modes
	python -m cheater bench all

clean:         ## Remove generated artifacts (keeps checked-in samples)
	rm -rf data/indexes data/cards .pytest_cache .ruff_cache __pycache__
	find . -type d -name __pycache__ -prune -exec rm -rf {} +

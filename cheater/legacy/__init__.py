"""Legacy experimental modules from the original Cheater repository.

These are preserved as-is (features kept) but organized into this subpackage.
They are NOT required for the clean core (cheater.audit, cheater.search,
cheater.benchmark, cheater.smoke). They comprise:

- Pi-agent wrapper harness (cheater_core, cheater_session, cheater_tui, ...)
- Qwen local-agent eval (qwen_local_agent, run_eval, benchmark_harness, ...)
- Original ingest/search scripts (01_..12_ numbered scripts)
- Second card pipeline (memory_schema, build_memory_cards, hybrid_retriever, ...)

Internal imports use relative paths (from .module import ...).
Tests that exercise these live in tests/test_eval_harness.py,
tests/test_memory_pipeline.py, tests/test_retrieval.py.
"""

# Memory Bank Report

Date: 2026-06-23

## Summary

This report documents the scalable memory ingestion pipeline, provenance tracking,
contamination quarantine, and the current state of the memory corpus.

## Dataset Registry

The registry is defined in `memory_datasets.json` and managed by `memory_dataset_registry.py`.

| Dataset | Role | Priority | Enabled by Default | Quarantined |
|---|---|---|---|---|
| nebius/SWE-rebench-V2-PRs | memory_source | 1 | true | false |
| nebius/SWE-rebench-V2 | memory_source | 2 | true | false |
| nebius/SWE-rebench | memory_source | 3 | true | false |
| ByteDance-Seed/Multi-SWE-bench | memory_source | 4 | false | false |
| somethingone/MULocBench | localization_source | 5 | false | false |
| princeton-nlp/SWE-bench | benchmark_holdout | 100 | false | true |
| princeton-nlp/SWE-bench_Verified | benchmark_holdout | 100 | false | true |

Total registered: 7 datasets
Memory sources: 4 (3 enabled by default)
Benchmark holdouts: 2 (quarantined)

## Ingestion Pipeline

- `ingest_memory_datasets.py` — CLI for ingesting datasets into normalized JSONL records
- `memory_normalizers.py` — Dataset-specific extractors mapping different schemas

Normalization rules:
- Holdout datasets always return `None` from their normalizer (prevented at the schema level)
- Missing fields are handled gracefully with empty defaults
- Unknown columns are preserved in `raw_metadata`
- Each record gets a deterministic `normalized_id` from `source_dataset + instance_id + row_index`

## Deduplication

Methods (in `dedupe_memory_records.py`):
1. Exact provenance: repo + instance_id, issue_url, pr_url, commit_url
2. Patch hash: patch_sha256, test_patch_sha256  
3. Approximate: normalized title hash
4. Repo + instance_id uniqueness

Deduplication produces a report with counts per method.

## Contamination Quarantine

`contamination_filters.py` provides:

- `ContaminationFilter` with `exclude_for_benchmark()` method
- Automatic exclusion of benchmark holdout datasets
- Same-repo, same-instance, same-patch exclusion logic
- Contamination report generation

Default holdouts: `princeton-nlp/SWE-bench`, `princeton-nlp/SWE-bench_Verified`

## Card Generation

`build_memory_cards.py` converts normalized records into memory cards with:

- Title extraction from problem statement
- Error signature extraction via regex (traceback patterns)
- Change tracking from patches (symbols, files, line counts)
- Quality scoring (0-10) based on completeness
- Task type classification (bug_fix, regression, crash, incorrect_behavior, etc.)
- BM25 and dense text field generation

By default, cards with type `feature_or_enhancement`, `refactor`, or `localization_only` are disabled from default retrieval.

## Telemetry

`memory_telemetry.py` aggregates per-card stats across eval runs:

- retrieval_count
- prompted_count
- associated_success_count
- associated_failure_count
- retry_success_count
- estimated_helpfulness

## Contamination Guardrails Status

- Benchmark datasets cannot be ingested without `--include-quarantined`
- Eval harness auto-excludes holdout datasets via `ContaminationFilter`
- Cards from quarantined sources are excluded from default retrieval
- Contamination report saved per run

## Next Steps

1. Run the ingestion pipeline against at least one real dataset (e.g., nebius/SWE-rebench)
2. Build a BM25 index from the generated cards
3. Run a dry eval to verify contamination filters work
4. Generate a memory stats report after real agent runs

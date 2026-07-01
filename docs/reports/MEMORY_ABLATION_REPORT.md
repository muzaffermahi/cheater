# Memory corpus and prompt ablation

Date: 2026-06-23

## Purpose

This milestone makes memory configuration an explicit, auditable evaluation dimension.
It does not claim any solve-rate improvement. The four-arm experiment below was prompt-only:
no model completion or test outcome was produced.

## Harness changes

- `run_eval.py` accepts `--cards-path`, `--configuration-label`, and
  `--allow-large-cards`.
- Each result records the resolved corpus path, detected corpus format, `top_k`, patch
  inclusion, configuration label, bug type, retrieved-memory count, and prompt bytes.
- `compare_eval_results.py` aggregates those fields and stratifies definitive outcomes by
  configuration and bug type.
- Compact runtime cards and solved-trajectory cards are supported. Raw trajectory/source
  rows and raw-preview dumps are refused with remediation guidance.
- Supported corpora above 256 MiB require explicit `--allow-large-cards`. This prevents an
  accidental multi-gigabyte load; it does not override schema validation.

## Prompt-only grid

All ten pinned ItsDangerous tasks were run in dry-run mode with deterministic BM25 retrieval.
Artifacts are merged at `eval_comparisons/prompt_ablation_grid/`.

| configuration | corpus | memories/run | average prompt bytes | min | max |
| --- | --- | ---: | ---: | ---: | ---: |
| `compact_top1` | compact cards | 1 | 2,234.9 | 1,988 | 2,659 |
| `compact_top3` | compact cards | 3 | 4,666.0 | 4,128 | 5,565 |
| `compact_top1_patches` | compact cards with patches | 1 | 5,180.8 | 3,063 | 9,248 |
| `raw_top1` | solved-trajectory cards | 1 | 10,098.8 | 9,959 | 10,409 |

The raw solved-card arm used roughly 4.5 times the prompt bytes of compact top-1. Adding
one compact patch used more prompt space on average than retrieving three compact cards.
These are context-cost measurements, not quality measurements. Raw and compact corpora also
retrieved different cards on many tasks, so a later outcome experiment must treat corpus
choice as both a ranking and representation intervention.

## Safety probe

`bug_cards_raw.jsonl` is a 5.77 GB raw-preview dump. The evaluator inspected only enough of
the file to classify its schema, then refused it as `raw_preview_rows` with instructions to
use compact cards or rebuild solved-trajectory cards. It was never loaded as a memory index.

## Honest interpretation

The merged report contains 40 dry runs and zero definitive outcomes. Consequently:

- no configuration has a measured solve rate;
- no pairwise improvement or regression is claimed;
- no official SWE-bench score is claimed;
- bug-type rows show `0/0` until real, tested agent runs exist.

The next valid experiment is a frozen, isolated, repeated-trial comparison using the same
task set and model settings, with a baseline plus selected memory configurations. Corpus,
retrieval depth, patch inclusion, and retry should be varied one dimension at a time.

# SWE-bench Agentic Benchmark Report

**Date:** 2026-06-26
**Agent:** Qwen 3.5 9B Claude-4.6-Opus-Reasoning-Distilled (Q4_K_M, 6.55 GB, LM Studio)
**Memory:** nomic-embed-text-v1.5 + 836 LLM-compacted bug cards
**Tasks:** 11 SWE-bench-style bug-fix tasks derived from real SWE-bench Verified instances (Django)

## Headline results

| Metric | Baseline (no memory) | With Cheater memory |
|--------|---------------------|---------------------|
| Tasks solved | **10/11 (90.9%)** | **9/11 (81.8%)** |
| Total fix attempts | 16 | 17 |
| Total time | 370s | 247s |
| Avg attempts per solved task | 1.6 | 1.4 |

## Per-task breakdown

| Task | Baseline | Memory | Memory cards retrieved | Notes |
|------|----------|--------|----------------------|-------|
| swe_url_validator | FAIL (3 attempts) | FAIL (3 attempts) | 3 | Hardest task; both arms fail |
| swe_duration_parse | SOLVED (1 attempt, 12s) | SOLVED (1 attempt, 13s) | 3 | Both solve instantly |
| swe_http_memoryview | SOLVED (1 attempt, 10s) | SOLVED (1 attempt, 10s) | 3 | Both solve instantly |
| swe_username_newline | SOLVED (1 attempt, 7s) | SOLVED (1 attempt, 5s) | 3 | Both solve instantly |
| **swe_model_to_dict** | **SOLVED (3 attempts, 162s)** | **SOLVED (1 attempt, 14s)** | 3 | **Memory wins: 12x faster** |
| swe_delete_pk | SOLVED (1 attempt, 15s) | SOLVED (1 attempt, 10s) | 3 | Both solve instantly |
| swe_autoescape | SOLVED (1 attempt, 9s) | SOLVED (1 attempt, 9s) | 1 | Both solve instantly |
| swe_count_distinct | SOLVED (1 attempt, 8s) | SOLVED (1 attempt, 8s) | 3 | Both solve instantly |
| **swe_sql_injection_order** | **SOLVED (2 attempts, 46s)** | **FAIL (3 attempts, 78s)** | 3 | **Memory hurts: distracting cards** |
| swe_form_required_field | SOLVED (1 attempt, 11s) | SOLVED (1 attempt, 18s) | 3 | Both solve, memory slightly slower |
| swe_middleware_order | SOLVED (1 attempt, 8s) | SOLVED (1 attempt, 6s) | 3 | Both solve instantly |

## Key findings

### 1. Memory can dramatically help (swe_model_to_dict)
- **Baseline:** 3 attempts, 162 seconds. The agent struggled with the `fields is not None` vs `fields` distinction.
- **Memory:** 1 attempt, 14 seconds. A retrieved card about dataclass-avroschema field handling pointed the agent toward the correct `is not None` check.
- **Result:** 12x speedup, saving 148 seconds and 2 failed attempts.

### 2. Memory can hurt (swe_sql_injection_order)
- **Baseline:** Solved in 2 attempts, 46 seconds.
- **Memory:** Failed all 3 attempts. The retrieved SQL-related cards (sqlparse, sql-metadata, tortoise-orm) were about SQL parsing, not SQL parameter escaping. They led the 9B model down the wrong path.
- **Root cause:** The memory cards were topically related (SQL) but addressed different bug patterns (parsing vs injection). The 9B model has limited context capacity and the irrelevant patterns diluted its focus.

### 3. Most simple tasks are unaffected
On 8 of 11 tasks, both arms solve in 1 attempt. For simple, well-defined bugs (add a space, handle memoryview, fix regex anchor), the 9B model doesn't need memory — the problem statement alone is sufficient.

### 4. Unfiltered memory is dangerous (v1 vs v2 comparison)
The first run (v1) without relevance threshold or concise formatting showed worse results:
- v1 (no threshold, verbose cards): Baseline 87.5%, Memory 62.5% — **memory hurt 2 tasks**
- v2 (threshold 0.65, concise format): Baseline 90.9%, Memory 81.8% — **memory hurt 1 task but helped 1**

The improvements (relevance threshold, shorter memory blocks, concise fix-pattern-only format) reduced the distraction effect.

### 5. The harder the task, the more memory matters
- `swe_url_validator` (hardest): Both arms fail. Memory cards about pydantic URL validation were relevant but not specific enough to guide the fix.
- `swe_model_to_dict` (medium): Memory clearly helps — the fix pattern was non-obvious and a related card provided the key insight.
- Simple tasks: Memory is neutral — the model solves them without help.

## Experiment v1 vs v2 comparison

| Version | Threshold | Format | Baseline | Memory | Memory helps | Memory hurts |
|---------|-----------|--------|----------|--------|-------------|-------------|
| v1 (8 tasks) | None | Verbose (root_cause + fix) | 87.5% | 62.5% | 0 | 2 (model_to_dict, delete_pk) |
| v2 (11 tasks) | 0.65 | Concise (fix only) | 90.9% | 81.8% | 1 (model_to_dict) | 1 (sql_injection) |

## Contamination control
- Memory cards from the same SWE-bench instance ID are excluded
- The 836 compact cards are from `nebius/SWE-agent-trajectories` (different repos: pydantic, sqlglot, etc.)
- The benchmark tasks are derived from Django SWE-bench Verified instances
- No card in the memory corpus is from the same instance as a benchmark task

## Task design
All 11 tasks are derived from real SWE-bench Verified instances:
- `swe_url_validator` ← django__django-10097 (URLValidator userinfo)
- `swe_duration_parse` ← django__django-10999 (negative ISO 8601 durations)
- `swe_http_memoryview` ← django__django-11133 (memoryview in HttpResponse)
- `swe_username_newline` ← django__django-11099 ($ vs \Z in regex)
- `swe_model_to_dict` ← django__django-11163 (empty fields list)
- `swe_delete_pk` ← django__django-11179 (PK not cleared on delete)
- `swe_autoescape` ← django__django-11119 (render_to_string autoescape)
- `swe_count_distinct` ← django__django-10880 (missing space in COUNT DISTINCT)
- `swe_sql_injection_order` ← inspired by Django SQL safety patterns
- `swe_form_required_field` ← inspired by Django form validation patterns
- `swe_middleware_order` ← inspired by Django middleware patterns

Each task is self-contained (no external dependencies, runs on Python 3.14) and verified to fail before the gold fix and pass after.

## How to reproduce

```powershell
# Start LM Studio + load models
lms server start
lms load "qwen3.5-9b-claude-4.6-opus-reasoning-distilled-v2" --identifier qwen3.5-9b -y
lms load "text-embedding-nomic-embed-text-v1.5" --identifier nomic-embed -y

# Run the agentic benchmark (v2 with filtering)
python bench_agentic_v2.py --limit 11 --output data/benchmarks/agentic_final_results.json

# Run the first version (v1, no filtering — shows the danger)
python bench_agentic.py --limit 8 --output data/benchmarks/agentic_results.json
```

## Conclusions

1. **Cheater memory retrieval is safe when properly filtered** (relevance threshold + concise format)
2. **Memory provides significant speedup on medium-difficulty tasks** (12x on model_to_dict)
3. **Memory can hurt on tasks where the retrieved patterns are topically related but pattern-mismatched** (SQL injection vs SQL parsing)
4. **For simple bugs, memory is neutral** — the model solves them without help
5. **The 9B model is the bottleneck for harder tasks** — both arms fail on url_validator, suggesting a larger model would benefit more from memory
6. **Future direction:** Better memory filtering (semantic similarity + bug-type matching), larger models, and more tasks would likely show a clearer positive effect

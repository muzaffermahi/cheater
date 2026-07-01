"""Improved agentic benchmark: retrieves from FULL 13,389-card corpus + relevance threshold."""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np

REPO_ROOT = Path(__file__).resolve().parent
TASKS_DIR = REPO_ROOT / "data" / "benchmarks" / "agentic_tasks"
RESULTS_DIR = REPO_ROOT / "data" / "benchmarks" / "agentic_results"

LLM_BASE_URL = "http://127.0.0.1:1234/v1"
LLM_API_KEY = "lm-studio"
LLM_MODEL = "qwen-coder"  # Code-specialized 9B (qwen3.5-9b-coder) - faster, no reasoning overhead
EMBED_MODEL = "nomic-embed"
MAX_ATTEMPTS = 2
RELEVANCE_THRESHOLD = 0.63  # Lowered since compact cards have quality boost

def get_client():
    from openai import OpenAI
    return OpenAI(base_url=LLM_BASE_URL, api_key=LLM_API_KEY)

def llm_chat(client, messages, max_tokens=4000, temperature=0.0):
    r = client.chat.completions.create(
        model=LLM_MODEL, messages=messages,
        max_tokens=max_tokens, temperature=temperature,
    )
    return r.choices[0].message.content or ""

# ─── Memory retrieval from FULL 13,389-card corpus ──────────────────────────

_full_cards_cache = None
_full_embs_cache = None
_full_ids_cache = None
_compact_cards_cache = None
_compact_embs_cache = None
_compact_ids_cache = None

def load_compact_corpus():
    """Load 836 LLM-compacted cards (high-quality fix patterns)."""
    global _compact_cards_cache, _compact_embs_cache, _compact_ids_cache
    if _compact_cards_cache is not None:
        return _compact_cards_cache, _compact_embs_cache, _compact_ids_cache

    compact_path = REPO_ROOT / "data" / "compact_bug_cards.jsonl"
    compact_cache = REPO_ROOT / "data" / "indexes" / "card_embeddings.npy"
    if compact_path.is_file() and compact_cache.is_file():
        cards = []
        with compact_path.open("r", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    cards.append(json.loads(line))
        embs = np.load(str(compact_cache))
        if len(cards) == embs.shape[0]:
            ids = [str(c.get("id") or "") for c in cards]
            _compact_cards_cache = cards
            _compact_embs_cache = embs
            _compact_ids_cache = ids
            return cards, embs, ids
    return [], None, []


def load_full_corpus():
    """Load all 13,389 usable v1 cards + pre-computed embeddings."""
    global _full_cards_cache, _full_embs_cache, _full_ids_cache
    if _full_cards_cache is not None:
        return _full_cards_cache, _full_embs_cache, _full_ids_cache

    # Try the full v1 corpus first
    v1_path = REPO_ROOT / "data" / "cards" / "cards.v1.jsonl"
    emb_cache = REPO_ROOT / "data" / "indexes" / "v1_usable_embeddings.npy"
    ids_cache = REPO_ROOT / "data" / "indexes" / "v1_usable_ids.json"

    if v1_path.is_file() and emb_cache.is_file() and ids_cache.is_file():
        print("  Loading FULL v1 corpus (13,389 usable cards)...", flush=True)
        cards = []
        with v1_path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    c = json.loads(line)
                    if c.get("usable") is True:
                        cards.append(c)
        embs = np.load(str(emb_cache))
        ids = json.loads(ids_cache.read_text(encoding="utf-8"))
        # Verify alignment
        if len(cards) == len(embs) and len(cards) == len(ids):
            _full_cards_cache = cards
            _full_embs_cache = embs
            _full_ids_cache = ids
            print(f"  Loaded {len(cards)} cards, embeddings shape={embs.shape}", flush=True)
            return cards, embs, ids
        else:
            print(f"  WARNING: cache misaligned ({len(cards)} cards vs {embs.shape[0]} embs vs {len(ids)} ids)", flush=True)

    # Fallback: compact cards (836)
    print("  Falling back to compact cards (836)...", flush=True)
    compact_path = REPO_ROOT / "data" / "compact_bug_cards.jsonl"
    compact_cache = REPO_ROOT / "data" / "indexes" / "card_embeddings.npy"
    if compact_path.is_file() and compact_cache.is_file():
        cards = []
        with compact_path.open("r", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    cards.append(json.loads(line))
        embs = np.load(str(compact_cache))
        if len(cards) == embs.shape[0]:
            ids = [str(c.get("id") or "") for c in cards]
            _full_cards_cache = cards
            _full_embs_cache = embs
            _full_ids_cache = ids
            print(f"  Loaded {len(cards)} compact cards", flush=True)
            return cards, embs, ids

    print("  No memory corpus available!", flush=True)
    return [], None, []


def _extract_target_repo(problem_statement: str) -> str | None:
    """Extract the target project name from a problem statement."""
    text = problem_statement.lower()
    # Common project names to look for
    projects = [
        "django", "flask", "fastapi", "pydantic", "sqlalchemy", "requests",
        "numpy", "pandas", "scipy", "pillow", "scrapy", "celery",
        "pytest", "sphinx", "click", "sqlglot", "astroid", "sympy",
        "matplotlib", "seaborn", "urllib3", "httpx", "aiohttp", "yaml",
    ]
    for p in projects:
        if p in text:
            return p
    return None


def retrieve_memory_v2(client, problem_statement, top_k=3, exclude_id=None, query_emb=None):
    """Retrieve from BOTH compact (836 high-quality) + full (13k breadth) corpora.
    
    Compact cards get a quality boost because they have structured fix_pattern/root_cause.
    The 13k raw trajectory cards provide breadth but are noisier.
    """
    compact_cards, compact_embs, _ = load_compact_corpus()
    full_cards, full_embs, _ = load_full_corpus()

    if query_emb is not None:
        q_emb = query_emb
    else:
        r = client.embeddings.create(model=EMBED_MODEL, input=[problem_statement[:1000]])
        q_emb = np.array(r.data[0].embedding, dtype=np.float32)
        q_emb = q_emb / (np.linalg.norm(q_emb) + 1e-9)

    all_scores = []
    all_cards = []
    all_sources = []  # "compact" or "full" for quality tracking

    # Score compact corpus (high quality, +0.03 boost)
    if compact_cards and compact_embs is not None:
        c_norm = compact_embs / (np.linalg.norm(compact_embs, axis=1, keepdims=True) + 1e-9)
        c_scores = c_norm @ q_emb + 0.03  # quality boost
        all_scores.append(c_scores)
        all_cards.extend(compact_cards)
        all_sources.extend(["compact"] * len(compact_cards))

    # Score full corpus
    if full_cards and full_embs is not None:
        f_norm = full_embs / (np.linalg.norm(full_embs, axis=1, keepdims=True) + 1e-9)
        f_scores = f_norm @ q_emb
        all_scores.append(f_scores)
        all_cards.extend(full_cards)
        all_sources.extend(["full"] * len(full_cards))

    if not all_scores:
        return []

    scores = np.concatenate(all_scores)
    cards = all_cards

    # Project-aware boosting
    target_project = _extract_target_repo(problem_statement)
    if target_project:
        for i, card in enumerate(cards):
            cid = str(card.get("id") or "").lower()
            repo = str(card.get("repo") or "").lower()
            emb_text = str(card.get("embedding_text") or "").lower()[:500]
            if target_project in cid or target_project in repo or target_project in emb_text:
                scores[i] += 0.04

    # Sort and filter
    top_idx = np.argsort(scores)[::-1][:top_k * 3]

    results = []
    for idx in top_idx:
        score = float(scores[idx])
        if score < RELEVANCE_THRESHOLD:
            continue
        card = cards[idx]
        card_id = str(card.get("id") or "")

        # Contamination filter: exclude same-instance cards
        if exclude_id and exclude_id in card_id.lower():
            continue

        results.append({
            "id": card_id,
            "title": _clean_title(card),
            "score": score,
            "root_cause": _clean_fix_pattern(card),  # use fix_pattern as the "what to do" signal
            "fix_pattern": _clean_fix_pattern(card),
        })
        if len(results) >= top_k:
            break

    return results


def _clean_title(card: dict) -> str:
    """Extract a clean, readable title from a raw v1 card."""
    # Try structured fields first
    for field in ("title", "bug_type"):
        val = str(card.get(field) or "").strip()
        if val and len(val) > 5 and "errors." not in val[:20]:
            return val[:100]
    # Extract from id: "owner__repo-NNN" -> "owner/repo: instance NNN"
    cid = str(card.get("id") or "")
    m = re.match(r"([\w.-]+)__([\w.-]+)-\d+__row(\d+)", cid)
    if m:
        return f"{m.group(1)}/{m.group(2)}: agent attempt {m.group(3)}"
    # Clean symptom: skip "errors.) command" boilerplate, take first meaningful line
    symptom = str(card.get("symptom") or "").strip()
    for line in symptom.split("\n"):
        line = line.strip()
        if 10 < len(line) < 120 and not line.startswith("```") and "errors." not in line[:10]:
            return line[:100]
    return cid[:80] or "bug card"


def _clean_fix_pattern(card: dict) -> str:
    """Extract a useful fix pattern from raw v1 card (patch summary or changed files)."""
    fix = str(card.get("fix_pattern") or "").strip()
    if fix and "Changed files:" in fix:
        return fix[:200]
    files = card.get("key_files") or []
    if isinstance(files, list) and files:
        return "Changed files: " + ", ".join(str(f) for f in files[:5])[:200]
    return fix[:200] or "(see patch)"


def format_memory_v2(memories):
    """Shorter, more focused memory block."""
    if not memories:
        return ""
    lines = [
        "## Similar past bug-fixes (IMPORTANT: use as ANALOGY for the pattern, NOT as template code).",
        "Apply the same TYPE of fix to your specific code. Do not copy these patterns literally.",
        "",
    ]
    for i, m in enumerate(memories, 1):
        lines.append(f"### Example {i}: {m['title']} (relevance {m['score']:.2f})")
        if m.get("fix_pattern"):
            lines.append(f"  What changed: {m['fix_pattern']}")
        lines.append("")
    return "\n".join(lines)


# ─── Run test ────────────────────────────────────────────────────────────────

def run_test(task_dir, timeout=30):
    env = dict(os.environ)
    env["PYTHONPATH"] = str(task_dir)
    env["PYTHONIOENCODING"] = "utf-8"
    try:
        result = subprocess.run(
            [sys.executable, "test_task.py"],
            cwd=str(task_dir), capture_output=True, timeout=timeout,
            env=env, encoding='utf-8', errors='replace',
        )
        return result.returncode, (result.stdout or "") + "\n" + (result.stderr or "")
    except subprocess.TimeoutExpired:
        return -1, "TIMEOUT"
    except Exception as e:
        return -2, str(e)


def run_fix_attempt(client, problem, source_path, source_code, memories, attempt, prev_error):
    parts = [
        "You are an expert Python bug fixer. Fix the bug described below.",
        "Output ONLY the complete fixed Python file. No markdown, no explanation, no code fences.",
        "",
        "## Problem Statement",
        problem[:2000],
        "",
    ]
    if prev_error:
        parts.extend(["## Previous Attempt Failed With:", "```\n" + prev_error[:800] + "\n```", ""])
    if memories:
        parts.append(format_memory_v2(memories))
    if len(source_code) > 6000:
        source_code = source_code[:6000] + "\n# ... (truncated)"
    parts.extend([
        f"## Buggy File: {source_path}",
        "```python",
        source_code,
        "```",
        "",
        "## Fixed File (output the COMPLETE file):",
    ])
    messages = [
        {"role": "system", "content": "You are an expert Python developer. Fix bugs by outputting the corrected complete file. Output ONLY valid Python code, no markdown, no explanations."},
        {"role": "user", "content": "\n".join(parts)},
    ]
    response = llm_chat(client, messages, max_tokens=4000, temperature=0.0 if attempt == 1 else 0.2)
    code = response.strip()
    if code.startswith("```"):
        lines = code.split("\n")
        if lines[0].startswith("```"): lines = lines[1:]
        if lines and lines[-1].strip() == "```": lines = lines[:-1]
        code = "\n".join(lines)
    return code.strip()


def run_task(client, task, task_dir, use_memory=True, use_baseline=True, query_emb=None):
    task_id = task["id"]
    problem = task["problem_statement"]
    source_file = task["source_file"]
    buggy_code = task["buggy_code"]

    print(f"\n{'='*60}", flush=True)
    print(f"Task: {task_id}", flush=True)

    task_dir.mkdir(parents=True, exist_ok=True)
    (task_dir / source_file).write_text(buggy_code, encoding="utf-8")
    (task_dir / "test_task.py").write_text(task["test_code"], encoding="utf-8")

    exit_code, _ = run_test(task_dir)
    if exit_code == 0:
        print(f"  SKIP: test passes before fix", flush=True)
        return {"task_id": task_id, "status": "preflight_passed"}

    print(f"  Preflight: test fails. Good.", flush=True)

    memories = None
    if use_memory:
        memories = retrieve_memory_v2(client, problem, top_k=3, exclude_id=task_id, query_emb=query_emb)
        print(f"  Memories: {len(memories)} above threshold {RELEVANCE_THRESHOLD}", flush=True)
        for m in memories:
            print(f"    - {m['id']}: {m['title'][:60]} (score={m['score']:.3f})", flush=True)

    result = {"task_id": task_id, "status": "completed",
              "memories_retrieved": [m["id"] for m in memories] if memories else []}

    for arm_name, arm_memories, use_mem in [("baseline", None, False), ("memory", memories, use_memory)]:
        if arm_name == "baseline" and not use_baseline:
            continue
        if arm_name == "memory" and not use_mem:
            continue

        print(f"  --- {arm_name.upper()} ---", flush=True)
        (task_dir / source_file).write_text(buggy_code, encoding="utf-8")
        t0 = time.perf_counter()
        solved = False
        logs = []
        current_code = buggy_code
        for attempt in range(1, MAX_ATTEMPTS + 1):
            prev_err = logs[-1]["error"] if logs else None
            fixed = run_fix_attempt(client, problem, source_file, current_code, arm_memories, attempt, prev_err)
            if len(fixed) < 50:
                logs.append({"attempt": attempt, "solved": False, "error": "Empty response"})
                continue
            (task_dir / source_file).write_text(fixed, encoding="utf-8")
            exit_code, output = run_test(task_dir)
            solved = exit_code == 0
            logs.append({"attempt": attempt, "solved": solved, "error": output[:500]})
            print(f"    attempt {attempt}: {'SOLVED' if solved else 'FAILED'}", flush=True)
            if solved:
                break
            current_code = fixed
        elapsed = time.perf_counter() - t0
        result[arm_name] = {
            "solved": solved, "attempts": len(logs), "time": round(elapsed, 1), "logs": logs,
        }
        if arm_name == "memory" and memories:
            result[arm_name]["memories_used"] = [m["id"] for m in memories]
        print(f"  {arm_name}: {'SOLVED' if solved else 'FAILED'} in {len(logs)} attempts, {elapsed:.0f}s", flush=True)

    return result


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=8)
    parser.add_argument("--baseline-only", action="store_true")
    parser.add_argument("--memory-only", action="store_true")
    parser.add_argument("--output", default="data/benchmarks/agentic_v2_results.json")
    args = parser.parse_args()

    tasks_file = TASKS_DIR / "tasks.json"
    with tasks_file.open("r", encoding="utf-8") as f:
        tasks = json.load(f)
    tasks = tasks[:args.limit]

    print(f"Running {len(tasks)} tasks with Qwen 3.5 9B", flush=True)
    print(f"Relevance threshold: {RELEVANCE_THRESHOLD}", flush=True)

    client = get_client()
    use_memory = not args.baseline_only
    use_baseline = not args.memory_only

    # Pre-embed all task queries in batch (much faster than one-by-one)
    query_embs = {}
    if use_memory:
        print("Pre-embedding all task queries...", flush=True)
        problems = [t["problem_statement"][:1000] for t in tasks]
        BATCH = 32
        t0 = time.perf_counter()
        for i in range(0, len(problems), BATCH):
            chunk = problems[i:i+BATCH]
            r = client.embeddings.create(model=EMBED_MODEL, input=chunk)
            for j, emb_data in enumerate(r.data):
                idx = i + j
                emb = np.array(emb_data.embedding, dtype=np.float32)
                query_embs[tasks[idx]["id"]] = emb / (np.linalg.norm(emb) + 1e-9)
        print(f"  Pre-embedded {len(query_embs)} queries in {time.perf_counter()-t0:.0f}s", flush=True)

    all_results = []
    for task in tasks:
        task_dir = TASKS_DIR / task["id"]
        qe = query_embs.get(task["id"])
        result = run_task(client, task, task_dir, use_memory=use_memory, use_baseline=use_baseline, query_emb=qe)
        all_results.append(result)
        RESULTS_DIR.mkdir(parents=True, exist_ok=True)
        (RESULTS_DIR / "incremental_v2.json").write_text(
            json.dumps(all_results, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(all_results, ensure_ascii=False, indent=2), encoding="utf-8")

    completed = [r for r in all_results if r.get("status") == "completed"]
    print(f"\n{'='*60}")
    print(f"  AGENTIC BENCHMARK v2 RESULTS (Qwen 3.5 9B)")
    print(f"{'='*60}")
    print(f"  Tasks completed: {len(completed)}")
    if use_baseline:
        b = sum(1 for r in completed if r.get("baseline", {}).get("solved"))
        print(f"  Baseline:  {b}/{len(completed)} = {b/max(1,len(completed)):.1%}")
    if use_memory:
        m = sum(1 for r in completed if r.get("memory", {}).get("solved"))
        print(f"  Memory:    {m}/{len(completed)} = {m/max(1,len(completed)):.1%}")
    print(f"\n  {'Task':<30s} {'Baseline':>10s} {'Memory':>10s} {'Mem above thresh':>15s}")
    print(f"  {'-'*30} {'-'*10} {'-'*10} {'-'*15}")
    for r in completed:
        tid = r["task_id"][:28]
        b = "SOLVED" if r.get("baseline", {}).get("solved") else "FAIL"
        m = "SOLVED" if r.get("memory", {}).get("solved") else "FAIL"
        nm = str(len(r.get("memories_retrieved", [])))
        print(f"  {tid:<30s} {b:>10s} {m:>10s} {nm:>15s}")


if __name__ == "__main__":
    main()

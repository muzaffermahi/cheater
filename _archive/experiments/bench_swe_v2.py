"""SWE-bench agent benchmark v2: structured one-shot fix approach.

For each SWE-bench Verified instance:
  1. Clone repo at base commit, apply test_patch
  2. Extract the source file(s) that need fixing (from the gold patch)
  3. Give Qwen: problem statement + source file + (memory cards if applicable)
  4. Ask Qwen to output the fixed code
  5. Apply the fix and run the FAIL_TO_PASS test
  6. Compare: baseline (no memory) vs. with Cheater memory

This structured approach works better with a 9B model than free-form tool loops.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np

REPO_ROOT = Path(__file__).resolve().parent
WORK_DIR = REPO_ROOT / "_swe_workspace"
RESULTS_DIR = REPO_ROOT / "data" / "benchmarks" / "swe_agent_results"

LLM_BASE_URL = "http://127.0.0.1:1234/v1"
LLM_API_KEY = "lm-studio"
LLM_MODEL = "qwen3.5-9b"
EMBED_MODEL = "nomic-embed"

MAX_FIX_ATTEMPTS = 3  # Allow up to 3 fix attempts with test feedback


def get_llm_client():
    from openai import OpenAI
    return OpenAI(base_url=LLM_BASE_URL, api_key=LLM_API_KEY)


def llm_chat(client, messages, max_tokens=4000, temperature=0.0):
    r = client.chat.completions.create(
        model=LLM_MODEL, messages=messages,
        max_tokens=max_tokens, temperature=temperature,
    )
    content = r.choices[0].message.content or ""
    return content


# ─── Memory retrieval ────────────────────────────────────────────────────────

def retrieve_memory(client, problem_statement, top_k=3, exclude_repo=None):
    """Retrieve relevant memory cards using nomic embeddings."""
    cards_path = REPO_ROOT / "data" / "compact_bug_cards.jsonl"
    if not cards_path.is_file():
        return []

    cards = []
    with cards_path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                cards.append(json.loads(line))

    # Contamination filter
    if exclude_repo:
        repo_lower = exclude_repo.split("/")[-1].lower()
        cards = [c for c in cards if repo_lower not in str(c.get("id", "")).lower()]

    if not cards:
        return []

    # Embed query
    query_text = problem_statement[:1000]
    r = client.embeddings.create(model=EMBED_MODEL, input=[query_text])
    q_emb = np.array(r.data[0].embedding, dtype=np.float32)
    q_emb = q_emb / (np.linalg.norm(q_emb) + 1e-9)

    # Use cached embeddings
    cache_path = REPO_ROOT / "data" / "indexes" / "card_embeddings.npy"
    if cache_path.is_file():
        card_embs = np.load(str(cache_path))
    else:
        texts = [str(c.get("search_text") or c.get("title") or "") for c in cards]
        all_embs = []
        for i in range(0, len(texts), 64):
            chunk = texts[i:i+64]
            r2 = client.embeddings.create(model=EMBED_MODEL, input=chunk)
            all_embs.extend([d.embedding for d in r2.data])
        card_embs = np.array(all_embs, dtype=np.float32)
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        np.save(str(cache_path), card_embs)

    card_embs_norm = card_embs / (np.linalg.norm(card_embs, axis=1, keepdims=True) + 1e-9)
    scores = card_embs_norm @ q_emb
    top_idx = np.argsort(scores)[::-1][:top_k]

    results = []
    for idx in top_idx:
        card = cards[idx]
        results.append({
            "id": card.get("id"),
            "title": card.get("title"),
            "score": float(scores[idx]),
            "root_cause": str(card.get("root_cause") or "")[:400],
            "fix_pattern": str(card.get("fix_pattern") or "")[:400],
        })
    return results


def format_memory_block(memories):
    if not memories:
        return ""
    lines = ["## Relevant bug-fix patterns from memory (use as analogies):", ""]
    for i, m in enumerate(memories, 1):
        lines.append(f"### Pattern {i}: {m['title']} (relevance: {m['score']:.3f})")
        lines.append(f"Root cause: {m['root_cause']}")
        lines.append(f"Fix pattern: {m['fix_pattern']}")
        lines.append("")
    return "\n".join(lines)


# ─── Patch parsing ───────────────────────────────────────────────────────────

def extract_changed_files_from_patch(patch_text):
    """Extract the list of source files (not test files) changed by a patch."""
    files = []
    for line in patch_text.split("\n"):
        if line.startswith("diff --git "):
            parts = line.split()
            if len(parts) >= 4:
                path = parts[3]
                if path.startswith("b/"):
                    path = path[2:]
                if "test" not in path.lower() and path.endswith(".py"):
                    files.append(path)
    return files


def extract_file_content(repo_dir, file_path):
    """Read a file from the repo, return its content."""
    full_path = repo_dir / file_path
    if not full_path.is_file():
        return None
    return full_path.read_text(encoding="utf-8")


# ─── Git operations ──────────────────────────────────────────────────────────

def clone_repo(repo, target_dir):
    if target_dir.exists():
        # Check if it has full history
        result = subprocess.run(
            ["git", "rev-parse", "--is-shallow-repository"],
            cwd=str(target_dir), capture_output=True, text=True, timeout=10
        )
        if result.stdout.strip() == "true":
            # Unshallow it
            subprocess.run(["git", "fetch", "--unshallow"],
                           cwd=str(target_dir), capture_output=True, text=True, timeout=300)
        return True
    target_dir.parent.mkdir(parents=True, exist_ok=True)
    url = f"https://github.com/{repo}.git"
    print(f"  Cloning {repo} (full)...", flush=True)
    result = subprocess.run(
        ["git", "clone", url, str(target_dir)],
        capture_output=True, text=True, timeout=600
    )
    if result.returncode != 0:
        print(f"  Clone failed: {result.stderr[:200]}", flush=True)
        return False
    return True


def checkout_commit(repo_dir, commit):
    result = subprocess.run(
        ["git", "checkout", commit],
        cwd=str(repo_dir), capture_output=True, text=True, timeout=30
    )
    return result.returncode == 0


def reset_repo(repo_dir):
    subprocess.run(["git", "checkout", "."], cwd=str(repo_dir), capture_output=True, timeout=30)
    subprocess.run(["git", "clean", "-fd"], cwd=str(repo_dir), capture_output=True, timeout=30)


def apply_patch(repo_dir, patch_text):
    patch_file = repo_dir / "_test_patch.diff"
    patch_file.write_text(patch_text, encoding="utf-8")
    result = subprocess.run(
        ["git", "apply", str(patch_file)],
        cwd=str(repo_dir), capture_output=True, text=True, timeout=30
    )
    patch_file.unlink(missing_ok=True)
    return result.returncode == 0, result.stderr


def get_diff(repo_dir):
    result = subprocess.run(
        ["git", "diff"],
        cwd=str(repo_dir), capture_output=True, text=True, timeout=30
    )
    return result.stdout


# ─── Test runner ─────────────────────────────────────────────────────────────

def run_test(repo_dir, test_cmd, timeout=120):
    env = dict(os.environ)
    env["PYTHONPATH"] = str(repo_dir)
    env["PYTHONIOENCODING"] = "utf-8"
    try:
        result = subprocess.run(
            test_cmd, cwd=str(repo_dir), capture_output=True,
            timeout=timeout, env=env, shell=True,
            encoding='utf-8', errors='replace',
        )
        output = (result.stdout or "") + "\n" + (result.stderr or "")
        return result.returncode, output
    except subprocess.TimeoutExpired:
        return -1, "TIMEOUT"
    except Exception as e:
        return -2, str(e)


def parse_fail_to_pass(ftp_str):
    try:
        tests = json.loads(ftp_str)
        return tests if isinstance(tests, list) else [tests]
    except:
        return [ftp_str]


def make_test_command(test_id, repo=None):
    """Create a test command for a SWE-bench test ID.
    
    SWE-bench test IDs for Django look like:
      "test_ascii_validator (auth_tests.test_validators.UsernameValidatorsTests)"
    We convert them to Django's runtests.py format.
    """
    # Parse: "test_name (module.path.ClassName)"
    m = re.match(r'(\S+)\s+\(([^)]+)\)', test_id)
    if m:
        test_name = m.group(1)
        test_path = m.group(2)
        # For Django: python runtests.py module.path.ClassName.test_name
        if repo and 'django' in repo:
            return f"python runtests.py {test_path}.{test_name} --noinput 2>&1"
        return f"python -m pytest {test_path}::{test_name} -x -q --tb=short 2>&1"
    # pytest format already
    return f"python -m pytest {test_id} -x -q --tb=short --no-header 2>&1"


# ─── Agent fix attempt ───────────────────────────────────────────────────────

def build_fix_prompt(problem_statement, file_path, file_content, memories=None, test_error=None):
    """Build a prompt asking Qwen to fix the buggy file."""
    prompt_parts = [
        "You are an expert Python bug fixer. Fix the bug described in the problem statement.",
        "Output ONLY the fixed Python code. No explanation, no markdown fences.",
        "",
        "## Problem Statement",
        problem_statement[:3000],
        "",
    ]

    if test_error:
        prompt_parts.extend([
            "## Current Test Error",
            "```\n" + test_error[:1500] + "\n```",
            "",
        ])

    if memories:
        prompt_parts.append(format_memory_block(memories))

    # Truncate very long files
    if len(file_content) > 8000:
        file_content = file_content[:8000] + "\n# ... (file truncated)"

    prompt_parts.extend([
        f"## Buggy File: {file_path}",
        "```python",
        file_content,
        "```",
        "",
        "## Your Fix",
        "Output the COMPLETE fixed file (not just the changed lines):",
    ])

    return "\n".join(prompt_parts)


def extract_code_from_response(response):
    """Extract Python code from the LLM response."""
    response = response.strip()
    # Remove markdown fences if present
    if response.startswith("```"):
        lines = response.split("\n")
        # Skip the first line (```python) and last line (```)
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        response = "\n".join(lines)
    return response.strip()


def apply_fix(repo_dir, file_path, new_content):
    """Write the fixed content to the file."""
    full_path = repo_dir / file_path
    if not full_path.is_file():
        return False, f"File not found: {file_path}"
    full_path.write_text(new_content, encoding="utf-8")
    return True, "Fix applied"


def run_fix_attempt(client, problem_statement, repo_dir, file_path, test_cmd, memories=None, attempt=1, prev_error=None):
    """Run a single fix attempt. Returns (solved, error_output)."""
    file_content = extract_file_content(repo_dir, file_path)
    if file_content is None:
        return False, f"Could not read {file_path}"

    prompt = build_fix_prompt(problem_statement, file_path, file_content, memories, prev_error)

    messages = [
        {"role": "system", "content": "You are an expert Python developer. Fix bugs by outputting the corrected complete file. Output ONLY Python code, no explanations."},
        {"role": "user", "content": prompt},
    ]

    print(f"    Asking Qwen for fix (attempt {attempt})...", flush=True)
    response = llm_chat(client, messages, max_tokens=4000, temperature=0.0 if attempt == 1 else 0.2)

    # Extract code
    fixed_code = extract_code_from_response(response)
    if not fixed_code or len(fixed_code) < 50:
        return False, "LLM returned empty or too-short response"

    # Apply fix
    ok, msg = apply_fix(repo_dir, file_path, fixed_code)
    if not ok:
        return False, msg

    # Run test
    exit_code, output = run_test(repo_dir, test_cmd, timeout=60)
    solved = exit_code == 0

    return solved, output


# ─── Main benchmark ──────────────────────────────────────────────────────────

def run_instance(client, inst, work_dir, use_memory=True, use_baseline=True):
    """Run a single SWE-bench instance with baseline and/or memory arms."""
    inst_id = inst["instance_id"]
    repo = inst["repo"]
    commit = inst["base_commit"]
    problem = inst["problem_statement"]
    ftp = parse_fail_to_pass(inst["FAIL_TO_PASS"])

    print(f"\n{'='*60}", flush=True)
    print(f"Instance: {inst_id}", flush=True)
    print(f"Repo: {repo}  Difficulty: {inst.get('difficulty','')}", flush=True)
    print(f"Test: {ftp[0][:80]}", flush=True)

    # Clone repo
    repo_dir = work_dir / repo.replace("/", "__")
    if not clone_repo(repo, repo_dir):
        return {"instance_id": inst_id, "status": "clone_failed"}

    if not checkout_commit(repo_dir, commit):
        print(f"  Failed to checkout {commit[:12]}", flush=True)
        return {"instance_id": inst_id, "status": "checkout_failed"}

    # Apply test patch
    ok, err = apply_patch(repo_dir, inst["test_patch"])
    if not ok:
        print(f"  Failed to apply test patch: {err[:200]}", flush=True)
        return {"instance_id": inst_id, "status": "patch_failed", "error": err[:200]}

    # Identify the file to fix (from the gold patch)
    source_files = extract_changed_files_from_patch(inst["patch"])
    if not source_files:
        print(f"  No source files found in gold patch", flush=True)
        return {"instance_id": inst_id, "status": "no_source_file"}
    file_to_fix = source_files[0]
    print(f"  File to fix: {file_to_fix}", flush=True)

    # Preflight: verify test fails
    test_cmd = make_test_command(ftp[0], repo=repo)
    print(f"  Preflight: {test_cmd[:80]}", flush=True)
    exit_code, preflight_output = run_test(repo_dir, test_cmd, timeout=60)
    if exit_code == 0:
        print(f"  WARNING: test already passes. Skipping.", flush=True)
        return {"instance_id": inst_id, "status": "preflight_passed"}

    print(f"  Preflight: test fails (exit={exit_code}). Good.", flush=True)

    # Retrieve memory
    memories = None
    if use_memory:
        print(f"  Retrieving memory cards...", flush=True)
        memories = retrieve_memory(client, problem, top_k=3, exclude_repo=repo)
        print(f"  Found {len(memories)} memories (after contamination filter)", flush=True)
        for m in memories:
            print(f"    - {m['id']}: {m['title'][:60]} (score={m['score']:.3f})", flush=True)

    results = {"instance_id": inst_id, "repo": repo, "difficulty": inst.get("difficulty", ""),
               "file_to_fix": file_to_fix, "status": "completed",
               "memories_retrieved": [m["id"] for m in memories] if memories else []}

    # Baseline arm
    if use_baseline:
        print(f"\n  --- BASELINE (no memory) ---", flush=True)
        reset_repo(repo_dir)
        apply_patch(repo_dir, inst["test_patch"])
        t0 = time.perf_counter()
        b_solved = False
        b_attempts = []
        for attempt in range(1, MAX_FIX_ATTEMPTS + 1):
            prev_err = b_attempts[-1]["error"] if b_attempts else None
            b_solved, b_output = run_fix_attempt(
                client, problem, repo_dir, file_to_fix, test_cmd,
                memories=None, attempt=attempt, prev_error=prev_err
            )
            b_attempts.append({"attempt": attempt, "solved": b_solved, "error": b_output[:500]})
            print(f"    Baseline attempt {attempt}: {'SOLVED' if b_solved else 'FAILED'}", flush=True)
            if b_solved:
                break
        b_time = time.perf_counter() - t0
        b_diff = get_diff(repo_dir) or ""
        results["baseline"] = {
            "solved": b_solved, "attempts": len(b_attempts), "time": round(b_time, 1),
            "diff": b_diff[:3000], "attempt_logs": b_attempts,
        }
        print(f"  Baseline: {'SOLVED' if b_solved else 'FAILED'} in {len(b_attempts)} attempts, {b_time:.0f}s", flush=True)

    # Memory arm
    if use_memory:
        print(f"\n  --- WITH CHEATER MEMORY ---", flush=True)
        reset_repo(repo_dir)
        apply_patch(repo_dir, inst["test_patch"])
        t0 = time.perf_counter()
        m_solved = False
        m_attempts = []
        for attempt in range(1, MAX_FIX_ATTEMPTS + 1):
            prev_err = m_attempts[-1]["error"] if m_attempts else None
            m_solved, m_output = run_fix_attempt(
                client, problem, repo_dir, file_to_fix, test_cmd,
                memories=memories, attempt=attempt, prev_error=prev_err
            )
            m_attempts.append({"attempt": attempt, "solved": m_solved, "error": m_output[:500]})
            print(f"    Memory attempt {attempt}: {'SOLVED' if m_solved else 'FAILED'}", flush=True)
            if m_solved:
                break
        m_time = time.perf_counter() - t0
        m_diff = get_diff(repo_dir) or ""
        results["memory"] = {
            "solved": m_solved, "attempts": len(m_attempts), "time": round(m_time, 1),
            "diff": m_diff[:3000], "attempt_logs": m_attempts,
            "memories_used": [m["id"] for m in memories] if memories else [],
        }
        print(f"  Memory: {'SOLVED' if m_solved else 'FAILED'} in {len(m_attempts)} attempts, {m_time:.0f}s", flush=True)

    return results


def main():
    parser = argparse.ArgumentParser(description="SWE-bench agent benchmark v2")
    parser.add_argument("--instances", default="data/benchmarks/swe_subset.json")
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--baseline-only", action="store_true")
    parser.add_argument("--memory-only", action="store_true")
    parser.add_argument("--output", default="data/benchmarks/swe_agent_v2_results.json")
    args = parser.parse_args()

    with open(args.instances, "r", encoding="utf-8") as f:
        instances = json.load(f)

    # Sort by difficulty, pick easiest
    instances.sort(key=lambda x: (0 if x.get("difficulty", "").startswith("<15") else 1, x["instance_id"]))
    instances = instances[:args.limit]

    print(f"Running {len(instances)} SWE-bench instances with Qwen 3.5 9B", flush=True)
    use_memory = not args.baseline_only
    use_baseline = not args.memory_only

    client = get_llm_client()

    # Pre-compute embeddings
    if use_memory:
        print("Pre-computing memory card embeddings...", flush=True)
        retrieve_memory(client, "warmup", exclude_repo="none")

    all_results = []
    for i, inst in enumerate(instances):
        result = run_instance(client, inst, WORK_DIR, use_memory=use_memory, use_baseline=use_baseline)
        all_results.append(result)

        # Save incremental
        RESULTS_DIR.mkdir(parents=True, exist_ok=True)
        (RESULTS_DIR / "incremental_v2.json").write_text(
            json.dumps(all_results, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    # Save final
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(
        json.dumps(all_results, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # Summary
    print(f"\n{'='*60}")
    print(f"  SWE-BENCH AGENT RESULTS (Qwen 3.5 9B)")
    print(f"{'='*60}")
    completed = [r for r in all_results if r.get("status") == "completed"]
    total = len(all_results)
    print(f"  Total:     {total}")
    print(f"  Completed: {len(completed)}")
    if use_baseline:
        b_solved = sum(1 for r in completed if r.get("baseline", {}).get("solved"))
        print(f"  Baseline:  {b_solved}/{len(completed)} = {b_solved/max(1,len(completed)):.1%}")
    if use_memory:
        m_solved = sum(1 for r in completed if r.get("memory", {}).get("solved"))
        print(f"  Memory:    {m_solved}/{len(completed)} = {m_solved/max(1,len(completed)):.1%}")
    print(f"\n  {'Instance':<40s} {'Baseline':>10s} {'Memory':>10s} {'Memories':>10s}")
    print(f"  {'-'*40} {'-'*10} {'-'*10} {'-'*10}")
    for r in all_results:
        inst = r["instance_id"][:38]
        b = "SOLVED" if r.get("baseline", {}).get("solved") else ("FAIL" if r.get("baseline") else "SKIP")
        m = "SOLVED" if r.get("memory", {}).get("solved") else ("FAIL" if r.get("memory") else "SKIP")
        n_mem = str(len(r.get("memories_retrieved", [])))
        print(f"  {inst:<40s} {b:>10s} {m:>10s} {n_mem:>10s}")


if __name__ == "__main__":
    main()

"""SWE-bench agent benchmark: compares Qwen 3.5 9B with and without Cheater memory.

For each SWE-bench Verified instance:
  1. Clone the repo at the base commit (or reuse cached clone)
  2. Apply the test_patch (adds/modifies tests)
  3. Verify the FAIL_TO_PASS test fails (preflight)
  4. Run the agent (Qwen 3.5 9B via LM Studio) with a constrained tool loop:
     - read_file: read a source file
     - edit_file: replace a block of code
     - run_test: run the failing test command
  5. Two arms:
     - baseline:    agent gets problem statement only
     - cheater:     agent gets problem statement + retrieved memory cards
  6. Check if the FAIL_TO_PASS test passes after the agent's fix
  7. Record: solved/failed, agent turns, test output

Contamination control: memory cards from the same repo/instance are excluded.
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

# ─── Config ──────────────────────────────────────────────────────────────────

REPO_ROOT = Path(__file__).resolve().parent
WORK_DIR = REPO_ROOT / "_swe_workspace"
RESULTS_DIR = REPO_ROOT / "data" / "benchmarks" / "swe_agent_results"

LLM_BASE_URL = "http://127.0.0.1:1234/v1"
LLM_API_KEY = "lm-studio"
LLM_MODEL = "qwen3.5-9b"
EMBED_MODEL = "nomic-embed"

MAX_TURNS = 6
MAX_TOKENS = 3000

# ─── LLM client ──────────────────────────────────────────────────────────────

def get_llm_client():
    from openai import OpenAI
    return OpenAI(base_url=LLM_BASE_URL, api_key=LLM_API_KEY)

def llm_chat(client, messages, max_tokens=MAX_TOKENS, temperature=0.0):
    r = client.chat.completions.create(
        model=LLM_MODEL, messages=messages,
        max_tokens=max_tokens, temperature=temperature,
    )
    content = r.choices[0].message.content or ""
    reasoning = getattr(r.choices[0].message, 'reasoning_content', None) or ""
    return content, reasoning

# ─── Memory retrieval ────────────────────────────────────────────────────────

def retrieve_memory(client, problem_statement, top_k=3):
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

    # Embed query
    query_text = problem_statement[:1000]
    r = client.embeddings.create(model=EMBED_MODEL, input=[query_text])
    q_emb = np.array(r.data[0].embedding, dtype=np.float32)
    q_emb = q_emb / (np.linalg.norm(q_emb) + 1e-9)

    # Embed card texts (cached if available)
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
            "symptom": str(card.get("error_signature") or card.get("title") or "")[:200],
            "root_cause": str(card.get("root_cause") or "")[:300],
            "fix_pattern": str(card.get("fix_pattern") or "")[:300],
            "changed_files": card.get("changed_files") or [],
        })
    return results

def format_memory_block(memories):
    """Format retrieved memories into a prompt section."""
    if not memories:
        return ""
    lines = ["## Retrieved bug-memory cards (treat as analogies only):", ""]
    for i, m in enumerate(memories, 1):
        lines.append(f"### Memory {i}: {m['title']} (score: {m['score']:.3f})")
        lines.append(f"- Symptom: {m['symptom']}")
        lines.append(f"- Root cause: {m['root_cause']}")
        lines.append(f"- Fix pattern: {m['fix_pattern']}")
        if m.get("changed_files"):
            lines.append(f"- Changed files: {', '.join(m['changed_files'][:5])}")
        lines.append("")
    return "\n".join(lines)

# ─── Git operations ──────────────────────────────────────────────────────────

def clone_repo(repo, target_dir):
    """Clone a repo shallow, then fetch the specific commit."""
    if target_dir.exists():
        return True
    target_dir.parent.mkdir(parents=True, exist_ok=True)
    url = f"https://github.com/{repo}.git"
    print(f"  Cloning {repo}...", flush=True)
    result = subprocess.run(
        ["git", "clone", "--depth", "1", url, str(target_dir)],
        capture_output=True, text=True, timeout=120
    )
    if result.returncode != 0:
        print(f"  Clone failed: {result.stderr[:200]}", flush=True)
        return False
    # Unshallow to get the specific commit
    result = subprocess.run(
        ["git", "fetch", "--unshallow"],
        cwd=str(target_dir), capture_output=True, text=True, timeout=120
    )
    return True

def checkout_commit(repo_dir, commit):
    """Checkout a specific commit."""
    result = subprocess.run(
        ["git", "checkout", commit],
        cwd=str(repo_dir), capture_output=True, text=True, timeout=30
    )
    return result.returncode == 0

def reset_repo(repo_dir):
    """Reset repo to clean state (discard all changes)."""
    subprocess.run(["git", "checkout", "."], cwd=str(repo_dir), capture_output=True, timeout=30)
    subprocess.run(["git", "clean", "-fd"], cwd=str(repo_dir), capture_output=True, timeout=30)

def apply_patch(repo_dir, patch_text):
    """Apply a git patch."""
    patch_file = repo_dir / "_test_patch.diff"
    patch_file.write_text(patch_text, encoding="utf-8")
    result = subprocess.run(
        ["git", "apply", str(patch_file)],
        cwd=str(repo_dir), capture_output=True, text=True, timeout=30
    )
    patch_file.unlink(missing_ok=True)
    return result.returncode == 0, result.stderr

def get_diff(repo_dir):
    """Get current git diff."""
    result = subprocess.run(
        ["git", "diff"],
        cwd=str(repo_dir), capture_output=True, text=True, timeout=30
    )
    return result.stdout

# ─── Test runner ─────────────────────────────────────────────────────────────

def run_test(repo_dir, test_cmd, timeout=120):
    """Run a test command and return (exit_code, output)."""
    env = dict(os.environ)
    env["PYTHONPATH"] = str(repo_dir)
    try:
        result = subprocess.run(
            test_cmd, cwd=str(repo_dir), capture_output=True, text=True,
            timeout=timeout, env=env, shell=True
        )
        output = result.stdout + "\n" + result.stderr
        return result.returncode, output
    except subprocess.TimeoutExpired:
        return -1, "TIMEOUT"
    except Exception as e:
        return -2, str(e)

def parse_fail_to_pass(ftp_str):
    """Parse FAIL_TO_PASS JSON string into a list of test IDs."""
    try:
        tests = json.loads(ftp_str)
        if isinstance(tests, list):
            return tests
        return [tests]
    except:
        return [ftp_str]

def make_test_command(test_id, repo):
    """Create a pytest command for a test ID."""
    # SWE-bench test IDs look like:
    # "test_requests.py::RequestsTestCase::test_no_content_length"
    # or "tests/test_utils.py::test_prepend_scheme_if_needed[...]"
    return f"python -m pytest {test_id} -x -q --tb=short --no-header 2>&1"

# ─── Agent loop ──────────────────────────────────────────────────────────────

def build_agent_prompt(problem_statement, repo_dir, memories=None, test_cmd=None):
    """Build the initial agent prompt."""
    # List Python files in the repo (top 2 levels)
    py_files = []
    for p in sorted(repo_dir.rglob("*.py")):
        rel = p.relative_to(repo_dir)
        parts = rel.parts
        if len(parts) <= 3 and not parts[0].startswith('.') and 'test' not in parts[0].lower():
            py_files.append(str(rel))
    py_files = py_files[:30]

    prompt_parts = [
        "You are a bug-fixing agent. Fix the bug described below.",
        "",
        "## Problem Statement",
        problem_statement[:3000],
        "",
        "## Test Command",
        f"Run: `{test_cmd}`",
        "",
        "## Available Python files:",
        "\n".join(f"  - {f}" for f in py_files),
        "",
    ]

    if memories:
        prompt_parts.append(format_memory_block(memories))

    prompt_parts.extend([
        "## Tool format (use EXACTLY this format):",
        "To read a file:  read_file requests/models.py",
        "To edit a file:  edit_file requests/models.py",
        "  Then provide the OLD and NEW code blocks:",
        "  OLD:",
        "  ```",
        "  <exact old code to replace>",
        "  ```",
        "  NEW:",
        "  ```",
        "  <new code>",
        "  ```",
        "To run tests:  run_test",
        "",
        "Start by reading the relevant source file, then edit it, then run_test.",
        "Use only ONE tool call per response. Be concise.",
    ])

    return "\n".join(prompt_parts)


def parse_agent_action(content):
    """Parse the agent's response to find tool calls anywhere in the text."""
    content = content.strip()
    # Search for tool calls anywhere in the response
    # Format 1: read_file <path>
    m = re.search(r'read_file\s+[`"]?([^\s`"<\n]+)[`"]?', content)
    if m:
        return ("read_file", m.group(1).strip())
    # Format 2: <read_file path="...">
    m = re.search(r'<read_file\s+path=["\']([^"\']+)["\']', content)
    if m:
        return ("read_file", m.group(1).strip())
    # Format 3: edit_file <path>
    m = re.search(r'edit_file\s+[`"]?([^\s`"<\n]+)[`"]?', content)
    if m:
        return ("edit_file", m.group(1).strip())
    # Format 4: <edit_file path="...">
    m = re.search(r'<edit_file\s+path=["\']([^"\']+)["\']', content)
    if m:
        return ("edit_file", m.group(1).strip())
    # Format 5: run_test
    if re.search(r'run_test', content):
        return ("run_test", "")
    return ("text", content)


def parse_edit_blocks(text):
    """Parse OLD/NEW blocks from an edit_file response."""
    # Try multiple formats
    # Format 1: OLD: ... NEW: ...
    old_block = []
    new_block = []
    state = None
    for line in text.split("\n"):
        if re.match(r'^OLD\s*:', re.IGNORECASE) or re.match(r'^```old', re.IGNORECASE):
            state = "old"
            continue
        elif re.match(r'^NEW\s*:', re.IGNORECASE) or re.match(r'^```new', re.IGNORECASE) or re.match(r'^```python', re.IGNORECASE):
            state = "new"
            continue
        elif line.strip() == "```" and state:
            state = None
            continue
        if state == "old":
            old_block.append(line)
        elif state == "new":
            new_block.append(line)
    old_text = "\n".join(old_block).strip()
    new_text = "\n".join(new_block).strip()
    if old_text and new_text:
        return old_text, new_text

    # Format 2: Replace "X" with "Y"
    m = re.search(r'[Rr]eplace\s+[\'"`](.+?)[\'"`]\s+with\s+[\'"`](.+?)[\'"`]', text, re.DOTALL)
    if m:
        return m.group(1), m.group(2)

    # Format 3: Find "old code" and replace with "new code"
    m = re.search(r'(?:find|change|replace)\s+(.+?)\s+(?:to|with|->)\s+(.+?)(?:\n|$)', text, re.IGNORECASE | re.DOTALL)
    if m:
        return m.group(1).strip().strip('`"\''), m.group(2).strip().strip('`\'"')

    return "", ""


def apply_edit(repo_dir, file_path, old_text, new_text):
    """Apply an edit to a file in the repo."""
    full_path = repo_dir / file_path
    if not full_path.is_file():
        return False, f"File not found: {file_path}"
    content = full_path.read_text(encoding="utf-8")
    if old_text not in content:
        # Try with stripped whitespace
        if old_text.strip() in content:
            old_text = old_text.strip()
        else:
            return False, "OLD text not found in file"
    content = content.replace(old_text, new_text, 1)
    full_path.write_text(content, encoding="utf-8")
    return True, "Edit applied"


def run_agent_loop(client, problem_statement, repo_dir, test_cmd, memories=None, label="baseline"):
    """Run the constrained agent loop. Returns (solved, turns, diff, log)."""
    system_prompt = (
        "You are a bug-fixing agent. You have tools: read_file, edit_file, run_test. "
        "Respond with ONE action per turn. Be concise."
    )
    prompt = build_agent_prompt(problem_statement, repo_dir, memories, test_cmd)
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": prompt},
    ]

    log = []
    solved = False

    for turn in range(1, MAX_TURNS + 1):
        print(f"    [{label}] Turn {turn}/{MAX_TURNS}...", flush=True)
        content, reasoning = llm_chat(client, messages)
        log.append({"turn": turn, "role": "assistant", "content": content[:500], "reasoning": reasoning[:200]})

        action, arg = parse_agent_action(content)

        if action == "read_file":
            file_path = arg.strip().strip('"').strip("'")
            full_path = repo_dir / file_path
            if full_path.is_file():
                file_content = full_path.read_text(encoding="utf-8")
                # Truncate very long files
                if len(file_content) > 5000:
                    file_content = file_content[:5000] + "\n... (truncated)"
                response = f"File {file_path}:\n```\n{file_content}\n```"
            else:
                response = f"File not found: {file_path}"
            messages.append({"role": "assistant", "content": content})
            messages.append({"role": "user", "content": response})
            log.append({"turn": turn, "action": "read_file", "file": file_path, "success": full_path.is_file()})

        elif action == "edit_file":
            file_path = arg.strip().strip('"').strip("'")
            # The OLD/NEW blocks should be in the content after the edit_file line
            old_text, new_text = parse_edit_blocks(content)
            if old_text and new_text:
                success, msg = apply_edit(repo_dir, file_path, old_text, new_text)
                response = f"Edit {'applied' if success else 'failed'}: {msg}"
            else:
                # Try a simpler approach: just write the whole new file content
                response = "Could not parse OLD/NEW blocks. Use format:\nOLD:\n<old code>\nNEW:\n<new code>"
            messages.append({"role": "assistant", "content": content})
            messages.append({"role": "user", "content": response})
            log.append({"turn": turn, "action": "edit_file", "file": file_path, "success": success if old_text else False})

        elif action == "run_test":
            exit_code, output = run_test(repo_dir, test_cmd)
            solved = exit_code == 0
            response = f"Test exit code: {exit_code}\nOutput (last 2000 chars):\n{output[-2000:]}"
            messages.append({"role": "assistant", "content": content})
            messages.append({"role": "user", "content": response})
            log.append({"turn": turn, "action": "run_test", "exit_code": exit_code, "solved": solved})
            if solved:
                print(f"    [{label}] TEST PASSED on turn {turn}!", flush=True)
                break

        else:
            # Agent gave text response, prompt for action
            messages.append({"role": "assistant", "content": content})
            messages.append({"role": "user", "content": "Please use a tool: read_file <path>, edit_file <path>, or run_test"})

    diff = get_diff(repo_dir)
    return solved, turn, diff, log


# ─── Main benchmark runner ───────────────────────────────────────────────────

def run_benchmark(instances, work_dir, use_memory=True, use_baseline=True):
    """Run the agent benchmark on a list of SWE-bench instances."""
    client = get_llm_client()
    results = []

    # Pre-compute card embeddings if using memory
    if use_memory:
        print("Pre-computing memory card embeddings...", flush=True)
        retrieve_memory(client, "test query")  # triggers caching

    for i, inst in enumerate(instances):
        inst_id = inst["instance_id"]
        repo = inst["repo"]
        commit = inst["base_commit"]
        problem = inst["problem_statement"]
        ftp = parse_fail_to_pass(inst["FAIL_TO_PASS"])

        print(f"\n{'='*60}", flush=True)
        print(f"Instance {i+1}/{len(instances)}: {inst_id}", flush=True)
        print(f"Repo: {repo}  Commit: {commit[:12]}", flush=True)
        print(f"Test: {ftp[0][:80]}", flush=True)

        # Clone repo
        repo_dir = work_dir / repo.replace("/", "__")
        if not clone_repo(repo, repo_dir):
            results.append({"instance_id": inst_id, "status": "clone_failed"})
            continue

        # Checkout base commit
        if not checkout_commit(repo_dir, commit):
            print(f"  Failed to checkout {commit[:12]}", flush=True)
            results.append({"instance_id": inst_id, "status": "checkout_failed"})
            continue

        # Apply test patch
        ok, err = apply_patch(repo_dir, inst["test_patch"])
        if not ok:
            print(f"  Failed to apply test patch: {err[:200]}", flush=True)
            results.append({"instance_id": inst_id, "status": "patch_failed", "error": err[:200]})
            continue

        # Preflight: verify test fails
        test_cmd = make_test_command(ftp[0], repo)
        print(f"  Preflight: running test (should fail)...", flush=True)
        exit_code, output = run_test(repo_dir, test_cmd, timeout=60)
        if exit_code == 0:
            print(f"  WARNING: test already passes (exit=0). Skipping.", flush=True)
            results.append({"instance_id": inst_id, "status": "preflight_passed", "test_output": output[-500:]})
            continue
        print(f"  Preflight: test fails (exit={exit_code}). Good.", flush=True)

        # Retrieve memory if needed
        memories = None
        if use_memory:
            print(f"  Retrieving memory cards...", flush=True)
            memories = retrieve_memory(client, problem, top_k=3)
            # Contamination control: exclude cards from same repo
            repo_name = repo.split("/")[-1].lower()
            memories = [m for m in memories if repo_name not in str(m.get("id", "")).lower()]
            print(f"  Found {len(memories)} relevant memories (after contamination filter)", flush=True)

        # Run baseline arm
        baseline_result = None
        if use_baseline:
            print(f"\n  --- BASELINE (no memory) ---", flush=True)
            reset_repo(repo_dir)
            # Re-apply test patch after reset
            apply_patch(repo_dir, inst["test_patch"])
            t0 = time.perf_counter()
            b_solved, b_turns, b_diff, b_log = run_agent_loop(
                client, problem, repo_dir, test_cmd, memories=None, label="baseline"
            )
            b_time = time.perf_counter() - t0
            baseline_result = {
                "solved": b_solved, "turns": b_turns, "time": round(b_time, 1),
                "diff": b_diff[:2000], "log": b_log,
            }
            print(f"  Baseline: {'SOLVED' if b_solved else 'FAILED'} in {b_turns} turns, {b_time:.0f}s", flush=True)

        # Run memory arm
        memory_result = None
        if use_memory:
            print(f"\n  --- WITH CHEATER MEMORY ---", flush=True)
            reset_repo(repo_dir)
            apply_patch(repo_dir, inst["test_patch"])
            t0 = time.perf_counter()
            m_solved, m_turns, m_diff, m_log = run_agent_loop(
                client, problem, repo_dir, test_cmd, memories=memories, label="memory"
            )
            m_time = time.perf_counter() - t0
            memory_result = {
                "solved": m_solved, "turns": m_turns, "time": round(m_time, 1),
                "diff": m_diff[:2000], "log": m_log,
                "memories_used": [m["id"] for m in (memories or [])],
            }
            print(f"  Memory: {'SOLVED' if m_solved else 'FAILED'} in {m_turns} turns, {m_time:.0f}s", flush=True)

        results.append({
            "instance_id": inst_id,
            "repo": repo,
            "difficulty": inst.get("difficulty", ""),
            "status": "completed",
            "baseline": baseline_result,
            "memory": memory_result,
            "memories_retrieved": [m["id"] for m in (memories or [])] if memories else [],
        })

        # Save incremental results
        RESULTS_DIR.mkdir(parents=True, exist_ok=True)
        (RESULTS_DIR / "incremental.json").write_text(
            json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    return results


def main():
    import argparse
    parser = argparse.ArgumentParser(description="SWE-bench agent benchmark with Cheater memory")
    parser.add_argument("--instances", default="data/benchmarks/swe_subset.json",
                        help="JSON file with SWE-bench instances")
    parser.add_argument("--limit", type=int, default=3, help="Max instances to run")
    parser.add_argument("--baseline-only", action="store_true", help="Run baseline arm only")
    parser.add_argument("--memory-only", action="store_true", help="Run memory arm only")
    parser.add_argument("--output", default="data/benchmarks/swe_agent_results.json",
                        help="Output results file")
    args = parser.parse_args()

    with open(args.instances, "r", encoding="utf-8") as f:
        instances = json.load(f)

    # Filter to easiest instances first
    instances.sort(key=lambda x: (0 if x.get("difficulty", "").startswith("<15") else 1, x["instance_id"]))
    instances = instances[:args.limit]

    print(f"Running {len(instances)} SWE-bench instances", flush=True)
    use_memory = not args.baseline_only
    use_baseline = not args.memory_only

    results = run_benchmark(instances, WORK_DIR, use_memory=use_memory, use_baseline=use_baseline)

    # Save final results
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(
        json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # Print summary
    print(f"\n{'='*60}")
    print(f"  SWE-BENCH AGENT RESULTS")
    print(f"{'='*60}")
    b_solved = sum(1 for r in results if r.get("baseline", {}).get("solved"))
    m_solved = sum(1 for r in results if r.get("memory", {}).get("solved"))
    total = len(results)
    completed = sum(1 for r in results if r.get("status") == "completed")
    print(f"  Total instances:    {total}")
    print(f"  Completed:          {completed}")
    if use_baseline:
        print(f"  Baseline solved:    {b_solved}/{completed} = {b_solved/max(1,completed):.1%}")
    if use_memory:
        print(f"  Memory solved:      {m_solved}/{completed} = {m_solved/max(1,completed):.1%}")
    print(f"\n  Per-instance:")
    print(f"  {'Instance':<40s} {'Baseline':>10s} {'Memory':>10s}")
    print(f"  {'-'*40} {'-'*10} {'-'*10}")
    for r in results:
        inst = r["instance_id"]
        b = "SOLVED" if r.get("baseline", {}).get("solved") else "FAIL" if r.get("baseline") else "N/A"
        m = "SOLVED" if r.get("memory", {}).get("solved") else "FAIL" if r.get("memory") else "N/A"
        print(f"  {inst:<40s} {b:>10s} {m:>10s}")


if __name__ == "__main__":
    main()

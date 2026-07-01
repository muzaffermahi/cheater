"""Self-contained SWE-bench-style agentic benchmark.

Creates minimal Python tasks from real SWE-bench bug patterns that run on
Python 3.14 without external dependencies. Each task has:
  - A buggy Python file (extracted/simplified from the real SWE-bench patch)
  - A test file that fails before the fix and passes after
  - A problem statement (from SWE-bench)

The agent (Qwen 3.5 9B) attempts to fix each task:
  - Baseline: problem statement + buggy file only
  - With memory: problem statement + buggy file + Cheater memory cards

Comparison: pass rate with vs. without memory.
"""
from __future__ import annotations

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
TASKS_DIR = REPO_ROOT / "data" / "benchmarks" / "agentic_tasks"
RESULTS_DIR = REPO_ROOT / "data" / "benchmarks" / "agentic_results"

LLM_BASE_URL = "http://127.0.0.1:1234/v1"
LLM_API_KEY = "lm-studio"
LLM_MODEL = "qwen3.5-9b"
EMBED_MODEL = "nomic-embed"

MAX_ATTEMPTS = 3


def get_client():
    from openai import OpenAI
    return OpenAI(base_url=LLM_BASE_URL, api_key=LLM_API_KEY)


def llm_chat(client, messages, max_tokens=4000, temperature=0.0):
    r = client.chat.completions.create(
        model=LLM_MODEL, messages=messages,
        max_tokens=max_tokens, temperature=temperature,
    )
    return r.choices[0].message.content or ""


# ─── Memory retrieval ────────────────────────────────────────────────────────

def retrieve_memory(client, problem_statement, top_k=3):
    cards_path = REPO_ROOT / "data" / "compact_bug_cards.jsonl"
    if not cards_path.is_file():
        return []
    cards = []
    with cards_path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                cards.append(json.loads(line))

    r = client.embeddings.create(model=EMBED_MODEL, input=[problem_statement[:1000]])
    q_emb = np.array(r.data[0].embedding, dtype=np.float32)
    q_emb = q_emb / (np.linalg.norm(q_emb) + 1e-9)

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

    return [{
        "id": cards[idx].get("id"),
        "title": cards[idx].get("title"),
        "score": float(scores[idx]),
        "root_cause": str(cards[idx].get("root_cause") or "")[:400],
        "fix_pattern": str(cards[idx].get("fix_pattern") or "")[:400],
    } for idx in top_idx]


def format_memory(memories):
    if not memories:
        return ""
    lines = ["## Relevant bug-fix patterns from memory (use as analogies):", ""]
    for i, m in enumerate(memories, 1):
        lines.append(f"### Pattern {i}: {m['title']} (relevance: {m['score']:.3f})")
        lines.append(f"Root cause: {m['root_cause']}")
        lines.append(f"Fix pattern: {m['fix_pattern']}")
        lines.append("")
    return "\n".join(lines)


# ─── Task runner ─────────────────────────────────────────────────────────────

def run_test(task_dir, timeout=30):
    """Run the test for a task. Returns (exit_code, output)."""
    env = dict(os.environ)
    env["PYTHONPATH"] = str(task_dir)
    env["PYTHONIOENCODING"] = "utf-8"
    try:
        result = subprocess.run(
            [sys.executable, "test_task.py"],
            cwd=str(task_dir), capture_output=True, timeout=timeout,
            env=env, encoding='utf-8', errors='replace',
        )
        output = (result.stdout or "") + "\n" + (result.stderr or "")
        return result.returncode, output
    except subprocess.TimeoutExpired:
        return -1, "TIMEOUT"
    except Exception as e:
        return -2, str(e)


def run_fix_attempt(client, problem, source_path, source_code, memories, attempt, prev_error):
    """Ask Qwen to fix the buggy file."""
    parts = [
        "You are an expert Python bug fixer. Fix the bug described below.",
        "Output ONLY the complete fixed Python file. No markdown, no explanation, no code fences.",
        "",
        "## Problem Statement",
        problem[:2000],
        "",
    ]
    if prev_error:
        parts.extend([
            "## Previous Attempt Failed With:",
            "```\n" + prev_error[:1000] + "\n```",
            "",
        ])
    if memories:
        parts.append(format_memory(memories))

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

    # Extract code - remove markdown fences if present
    code = response.strip()
    if code.startswith("```"):
        lines = code.split("\n")
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        code = "\n".join(lines)
    return code.strip()


def run_task(client, task, task_dir, use_memory=True, use_baseline=True):
    """Run a single task with baseline and/or memory arms."""
    task_id = task["id"]
    problem = task["problem_statement"]
    source_file = task["source_file"]
    buggy_code = task["buggy_code"]
    fixed_code = task["fixed_code"]
    test_code = task["test_code"]

    print(f"\n{'='*60}", flush=True)
    print(f"Task: {task_id}", flush=True)
    print(f"  {task['description']}", flush=True)

    # Set up task directory
    task_dir.mkdir(parents=True, exist_ok=True)
    (task_dir / source_file).write_text(buggy_code, encoding="utf-8")
    (task_dir / "test_task.py").write_text(test_code, encoding="utf-8")

    # Preflight: verify test fails
    exit_code, preflight = run_test(task_dir)
    if exit_code == 0:
        print(f"  WARNING: test passes before fix. Skipping.", flush=True)
        return {"task_id": task_id, "status": "preflight_passed"}

    print(f"  Preflight: test fails (exit={exit_code}). Good.", flush=True)

    # Retrieve memory
    memories = None
    if use_memory:
        memories = retrieve_memory(client, problem, top_k=3)
        print(f"  Memories: {len(memories)} retrieved", flush=True)
        for m in memories:
            print(f"    - {m['id']}: {m['title'][:60]} (score={m['score']:.3f})", flush=True)

    result = {"task_id": task_id, "status": "completed",
              "memories_retrieved": [m["id"] for m in memories] if memories else []}

    # Baseline arm
    if use_baseline:
        print(f"  --- BASELINE ---", flush=True)
        (task_dir / source_file).write_text(buggy_code, encoding="utf-8")  # reset
        t0 = time.perf_counter()
        b_solved = False
        b_logs = []
        for attempt in range(1, MAX_ATTEMPTS + 1):
            prev_err = b_logs[-1]["error"] if b_logs else None
            fixed = run_fix_attempt(client, problem, source_file, buggy_code, None, attempt, prev_err)
            if len(fixed) < 50:
                b_logs.append({"attempt": attempt, "solved": False, "error": "Empty response"})
                continue
            (task_dir / source_file).write_text(fixed, encoding="utf-8")
            exit_code, output = run_test(task_dir)
            b_solved = exit_code == 0
            b_logs.append({"attempt": attempt, "solved": b_solved, "error": output[:500]})
            print(f"    attempt {attempt}: {'SOLVED' if b_solved else 'FAILED'}", flush=True)
            if b_solved:
                break
            # Use the fixed code as the new base for next attempt (with error feedback)
            buggy_code = fixed
        b_time = time.perf_counter() - t0
        result["baseline"] = {
            "solved": b_solved, "attempts": len(b_logs), "time": round(b_time, 1),
            "logs": b_logs,
        }
        print(f"  Baseline: {'SOLVED' if b_solved else 'FAILED'} in {len(b_logs)} attempts, {b_time:.0f}s", flush=True)
        # Reset buggy code for memory arm
        buggy_code = task["buggy_code"]

    # Memory arm
    if use_memory:
        print(f"  --- WITH MEMORY ---", flush=True)
        (task_dir / source_file).write_text(buggy_code, encoding="utf-8")  # reset
        t0 = time.perf_counter()
        m_solved = False
        m_logs = []
        for attempt in range(1, MAX_ATTEMPTS + 1):
            prev_err = m_logs[-1]["error"] if m_logs else None
            fixed = run_fix_attempt(client, problem, source_file, buggy_code, memories, attempt, prev_err)
            if len(fixed) < 50:
                m_logs.append({"attempt": attempt, "solved": False, "error": "Empty response"})
                continue
            (task_dir / source_file).write_text(fixed, encoding="utf-8")
            exit_code, output = run_test(task_dir)
            m_solved = exit_code == 0
            m_logs.append({"attempt": attempt, "solved": m_solved, "error": output[:500]})
            print(f"    attempt {attempt}: {'SOLVED' if m_solved else 'FAILED'}", flush=True)
            if m_solved:
                break
            buggy_code = fixed
        m_time = time.perf_counter() - t0
        result["memory"] = {
            "solved": m_solved, "attempts": len(m_logs), "time": round(m_time, 1),
            "logs": m_logs,
            "memories_used": [m["id"] for m in memories] if memories else [],
        }
        print(f"  Memory: {'SOLVED' if m_solved else 'FAILED'} in {len(m_logs)} attempts, {m_time:.0f}s", flush=True)

    return result


# ─── Tasks ───────────────────────────────────────────────────────────────────

def create_tasks():
    """Create self-contained SWE-bench-style tasks that run on Python 3.14."""
    tasks_dir = TASKS_DIR
    tasks_dir.mkdir(parents=True, exist_ok=True)

    tasks = []

    # ─── Task 1: URL validator (from django__django-10097) ───
    tasks.append({
        "id": "swe_url_validator",
        "description": "URLValidator should reject invalid characters in username/password (SWE-bench django-10097 style)",
        "problem_statement": (
            "Make URLValidator reject invalid characters in the username and password. "
            "RFC 1738 section 3.1 requires that within the user and password field, "
            "any ':', '@', or '/' must be encoded. The URLValidator currently accepts "
            "URLs with these characters unencoded in the userinfo section."
        ),
        "source_file": "validators.py",
        "buggy_code": '''import re

URL_REGEX = re.compile(
    r'^(?:http|ftp)s?://'
    r'(?:(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\\.)+(?:[A-Z]{2,6}\\.?|[A-Z0-9-]{2,}\\.?)|'
    r'localhost|'
    r'\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3})'
    r'(?::\\d+)?'
    r'(?:/?|[/?]\\S+)$',
    re.IGNORECASE
)

USERINFO_REGEX = re.compile(r'^[^@]+@')

def validate_url(url):
    """Validate a URL. Returns True if valid, False otherwise."""
    if not URL_REGEX.match(url):
        return False
    return True
''',
        "fixed_code": '''import re

URL_REGEX = re.compile(
    r'^(?:http|ftp)s?://'
    r'(?:([^\\s:@/]+(?::[^\\s:@/]*)?)@)?'
    r'(?:(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\\.)+(?:[A-Z]{2,6}\\.?|[A-Z0-9-]{2,}\\.?)|'
    r'localhost|'
    r'\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3})'
    r'(?::\\d+)?'
    r'(?:/?|[/?]\\S+)$',
    re.IGNORECASE
)

def validate_url(url):
    """Validate a URL. Returns True if valid, False otherwise."""
    if not URL_REGEX.match(url):
        return False
    # Check userinfo for invalid unencoded characters
    if '://' in url:
        rest = url.split('://', 1)[1]
        if '@' in rest.split('/', 1)[0]:
            userinfo = rest.split('@', 1)[0]
            # Reject if userinfo contains unencoded / or @ (beyond the first @)
            if '/' in userinfo:
                return False
    return True
''',
        "test_code": '''from validators import validate_url

def test_valid_urls():
    assert validate_url("http://example.com/")
    assert validate_url("http://user:pass@example.com/")
    assert validate_url("http://user@example.com/path")
    print("test_valid_urls PASSED")

def test_invalid_userinfo():
    # URLs with / in userinfo should be rejected
    assert not validate_url("http://user/pass@example.com/")
    assert not validate_url("http://user:pa/ss@example.com/")
    print("test_invalid_userinfo PASSED")

def test_normal_urls():
    assert validate_url("https://example.com/path?query=1")
    assert validate_url("ftp://ftp.example.com/file.txt")
    print("test_normal_urls PASSED")

if __name__ == "__main__":
    test_valid_urls()
    test_invalid_userinfo()
    test_normal_urls()
    print("ALL TESTS PASSED")
''',
    })

    # ─── Task 2: Duration parsing (from django__django-10999) ───
    tasks.append({
        "id": "swe_duration_parse",
        "description": "parse_duration() should handle negative durations (SWE-bench django-10999 style)",
        "problem_statement": (
            "Fix parse_duration() for negative durations. The function should correctly "
            "parse ISO 8601 durations with negative values like '-P1D' (negative 1 day). "
            "Currently it fails to handle the negative sign."
        ),
        "source_file": "duration.py",
        "buggy_code": '''import re

ISO8601_DURATION_RE = re.compile(
    r'^(?P<sign>[-+]?)'
    r'P'
    r'(?:(?P<days>\\d+)D)?'
    r'(?:T'
    r'(?:(?P<hours>\\d+)H)?'
    r'(?:(?P<minutes>\\d+)M)?'
    r'(?:(?P<seconds>\\d+)S)?'
    r')?$'
)

def parse_duration(duration_string):
    """Parse an ISO 8601 duration string. Returns total seconds (float)."""
    match = ISO8601_DURATION_RE.match(duration_string)
    if not match:
        return None
    days = int(match.group('days') or 0)
    hours = int(match.group('hours') or 0)
    minutes = int(match.group('minutes') or 0)
    seconds = int(match.group('seconds') or 0)
    total = days * 86400 + hours * 3600 + minutes * 60 + seconds
    return float(total)
''',
        "fixed_code": '''import re

ISO8601_DURATION_RE = re.compile(
    r'^(?P<sign>[-+]?)'
    r'P'
    r'(?:(?P<days>\\d+)D)?'
    r'(?:T'
    r'(?:(?P<hours>\\d+)H)?'
    r'(?:(?P<minutes>\\d+)M)?'
    r'(?:(?P<seconds>\\d+)S)?'
    r')?$'
)

def parse_duration(duration_string):
    """Parse an ISO 8601 duration string. Returns total seconds (float)."""
    match = ISO8601_DURATION_RE.match(duration_string)
    if not match:
        return None
    sign = match.group('sign') or ''
    days = int(match.group('days') or 0)
    hours = int(match.group('hours') or 0)
    minutes = int(match.group('minutes') or 0)
    seconds = int(match.group('seconds') or 0)
    total = days * 86400 + hours * 3600 + minutes * 60 + seconds
    if sign == '-':
        total = -total
    return float(total)
''',
        "test_code": '''from duration import parse_duration

def test_positive_durations():
    assert parse_duration("P1D") == 86400.0
    assert parse_duration("PT1H") == 3600.0
    assert parse_duration("PT1M") == 60.0
    assert parse_duration("PT1S") == 1.0
    assert parse_duration("P1DT1H1M1S") == 86400 + 3600 + 60 + 1
    print("test_positive_durations PASSED")

def test_negative_durations():
    assert parse_duration("-P1D") == -86400.0
    assert parse_duration("-PT1H") == -3600.0
    assert parse_duration("-P1DT1H") == -(86400 + 3600)
    print("test_negative_durations PASSED")

def test_zero_and_empty():
    assert parse_duration("P0D") == 0.0
    assert parse_duration("invalid") is None
    print("test_zero_and_empty PASSED")

if __name__ == "__main__":
    test_positive_durations()
    test_negative_durations()
    test_zero_and_empty()
    print("ALL TESTS PASSED")
''',
    })

    # ─── Task 3: HttpResponse memoryview (from django__django-11133) ───
    tasks.append({
        "id": "swe_http_memoryview",
        "description": "HttpResponse should handle memoryview objects (SWE-bench django-11133 style)",
        "problem_statement": (
            "HttpResponse doesn't handle memoryview objects. When content is a memoryview "
            "(as returned by PostgreSQL BinaryField), the response fails. Fix HttpResponse "
            "to convert memoryview content to bytes."
        ),
        "source_file": "response.py",
        "buggy_code": '''class HttpResponse:
    def __init__(self, content=b"", status=200):
        self.status = status
        self.content = content

    @property
    def content(self):
        return self._content

    @content.setter
    def content(self, value):
        self._content = value
''',
        "fixed_code": '''class HttpResponse:
    def __init__(self, content=b"", status=200):
        self.status = status
        self.content = content

    @property
    def content(self):
        return self._content

    @content.setter
    def content(self, value):
        if isinstance(value, memoryview):
            value = bytes(value)
        self._content = value
''',
        "test_code": '''from response import HttpResponse

def test_bytes_content():
    r = HttpResponse(b"hello")
    assert r.content == b"hello"
    assert r.status == 200
    print("test_bytes_content PASSED")

def test_memoryview_content():
    mv = memoryview(b"hello world")
    r = HttpResponse(mv)
    assert r.content == b"hello world"
    assert isinstance(r.content, bytes)
    print("test_memoryview_content PASSED")

def test_empty_content():
    r = HttpResponse()
    assert r.content == b""
    print("test_empty_content PASSED")

if __name__ == "__main__":
    test_bytes_content()
    test_memoryview_content()
    test_empty_content()
    print("ALL TESTS PASSED")
''',
    })

    # ─── Task 4: UsernameValidator trailing newline (from django__django-11099) ───
    tasks.append({
        "id": "swe_username_newline",
        "description": "UsernameValidator should reject trailing newline (SWE-bench django-11099 style)",
        "problem_statement": (
            "ASCIIUsernameValidator and UnicodeUsernameValidator use the regex "
            "r'^[\\w.@+-]+$'. However, $ in Python regexes also matches before a "
            "trailing newline. Fix the validators to use \\Z instead of $ so that "
            "usernames with trailing newlines are rejected."
        ),
        "source_file": "validators2.py",
        "buggy_code": '''import re

ASCII_USERNAME_RE = re.compile(r'^[\\w.@+-]+$')
UNICODE_USERNAME_RE = re.compile(r'^[\\w.@+-]+$', re.UNICODE)

def validate_ascii_username(username):
    """Validate username against ASCII rules."""
    return bool(ASCII_USERNAME_RE.match(username))

def validate_unicode_username(username):
    """Validate username against Unicode rules."""
    return bool(UNICODE_USERNAME_RE.match(username))
''',
        "fixed_code": '''import re

ASCII_USERNAME_RE = re.compile(r'^[\\w.@+-]+\\Z')
UNICODE_USERNAME_RE = re.compile(r'^[\\w.@+-]+\\Z', re.UNICODE)

def validate_ascii_username(username):
    """Validate username against ASCII rules."""
    return bool(ASCII_USERNAME_RE.match(username))

def validate_unicode_username(username):
    """Validate username against Unicode rules."""
    return bool(UNICODE_USERNAME_RE.match(username))
''',
        "test_code": '''from validators2 import validate_ascii_username, validate_unicode_username

def test_valid_usernames():
    assert validate_ascii_username("user123")
    assert validate_ascii_username("user.name")
    assert validate_ascii_username("user@domain")
    assert validate_ascii_username("user+tag")
    assert validate_ascii_username("user-tag")
    print("test_valid_usernames PASSED")

def test_trailing_newline_rejected():
    assert not validate_ascii_username("user\\n")
    assert not validate_unicode_username("user\\n")
    assert not validate_ascii_username("user123\\n")
    print("test_trailing_newline_rejected PASSED")

def test_invalid_usernames():
    assert not validate_ascii_username("")
    assert not validate_ascii_username("user name")
    assert not validate_ascii_username("user#name")
    print("test_invalid_usernames PASSED")

if __name__ == "__main__":
    test_valid_usernames()
    test_trailing_newline_rejected()
    test_invalid_usernames()
    print("ALL TESTS PASSED")
''',
    })

    # ─── Task 5: model_to_dict empty fields (from django__django-11163) ───
    tasks.append({
        "id": "swe_model_to_dict",
        "description": "model_to_dict should return empty dict for empty fields list (SWE-bench django-11163 style)",
        "problem_statement": (
            "model_to_dict(instance, fields=[]) should return an empty dict, because no "
            "fields were requested. But it returns all fields. The problem is the condition "
            "'if fields and f.name not in fields' which should also handle the case where "
            "fields is an empty list."
        ),
        "source_file": "models.py",
        "buggy_code": '''def model_to_dict(instance, fields=None, exclude=None):
    """Convert a model instance to a dict of field values.
    
    Args:
        instance: Object with a ._meta.fields list of field objects,
                  each having a .name attribute and a .value_from_object(obj) method.
        fields: List of field names to include. If None, includes all fields.
        exclude: List of field names to exclude.
    Returns:
        dict mapping field names to values.
    """
    data = {}
    for f in instance._meta.fields:
        if fields and f.name not in fields:
            continue
        if exclude and f.name in exclude:
            continue
        data[f.name] = f.value_from_object(instance)
    return data
''',
        "fixed_code": '''def model_to_dict(instance, fields=None, exclude=None):
    """Convert a model instance to a dict of field values.
    
    Args:
        instance: Object with a ._meta.fields list of field objects,
                  each having a .name attribute and a .value_from_object(obj) method.
        fields: List of field names to include. If None, includes all fields.
                 If empty list, returns empty dict.
        exclude: List of field names to exclude.
    Returns:
        dict mapping field names to values.
    """
    data = {}
    for f in instance._meta.fields:
        if fields is not None and f.name not in fields:
            continue
        if exclude and f.name in exclude:
            continue
        data[f.name] = f.value_from_object(instance)
    return data
''',
        "test_code": '''from models import model_to_dict

class FakeField:
    def __init__(self, name, value):
        self.name = name
        self._value = value
    def value_from_object(self, obj):
        return self._value

class FakeMeta:
    def __init__(self, fields):
        self.fields = fields

class FakeModel:
    def __init__(self):
        self._meta = FakeMeta([
            FakeField("name", "test"),
            FakeField("age", 25),
            FakeField("email", "test@example.com"),
        ])

obj = FakeModel()

def test_all_fields():
    result = model_to_dict(obj)
    assert result == {"name": "test", "age": 25, "email": "test@example.com"}
    print("test_all_fields PASSED")

def test_empty_fields():
    result = model_to_dict(obj, fields=[])
    assert result == {}, f"Expected empty dict, got {result}"
    print("test_empty_fields PASSED")

def test_specific_fields():
    result = model_to_dict(obj, fields=["name", "email"])
    assert result == {"name": "test", "email": "test@example.com"}
    print("test_specific_fields PASSED")

def test_exclude():
    result = model_to_dict(obj, exclude=["age"])
    assert result == {"name": "test", "email": "test@example.com"}
    print("test_exclude PASSED")

if __name__ == "__main__":
    test_all_fields()
    test_empty_fields()
    test_specific_fields()
    test_exclude()
    print("ALL TESTS PASSED")
''',
    })

    # ─── Task 6: delete() should clear PK (from django__django-11179) ───
    tasks.append({
        "id": "swe_delete_pk",
        "description": "delete() should set PK to None after deletion (SWE-bench django-11179 style)",
        "problem_statement": (
            "delete() on instances of models without any dependencies doesn't clear PKs. "
            "It should be set to None after .delete() call. The bug is in the deletion "
            "logic where the PK is not reset for models with no dependencies."
        ),
        "source_file": "deletion.py",
        "buggy_code": '''class Collector:
    """Collects objects for deletion and handles the deletion process."""
    
    def __init__(self):
        self.data = {}

    def add(self, obj):
        """Add an object to be deleted."""
        key = type(obj).__name__
        self.data.setdefault(key, []).append(obj)

    def delete(self):
        """Delete all collected objects. Returns count of deleted objects."""
        count = 0
        for key, objects in self.data.items():
            for obj in objects:
                count += 1
                # Bug: PK is not cleared after deletion
        self.data = {}
        return count
''',
        "fixed_code": '''class Collector:
    """Collects objects for deletion and handles the deletion process."""
    
    def __init__(self):
        self.data = {}

    def add(self, obj):
        """Add an object to be deleted."""
        key = type(obj).__name__
        self.data.setdefault(key, []).append(obj)

    def delete(self):
        """Delete all collected objects. Returns count of deleted objects."""
        count = 0
        for key, objects in self.data.items():
            for obj in objects:
                count += 1
                # Clear the PK after deletion
                if hasattr(obj, 'pk'):
                    obj.pk = None
        self.data = {}
        return count
''',
        "test_code": '''from deletion import Collector

class SimpleModel:
    def __init__(self, pk):
        self.pk = pk

def test_delete_clears_pk():
    obj = SimpleModel(pk=42)
    collector = Collector()
    collector.add(obj)
    assert obj.pk == 42
    count = collector.delete()
    assert count == 1
    assert obj.pk is None, f"PK should be None after delete, got {obj.pk}"
    print("test_delete_clears_pk PASSED")

def test_delete_multiple():
    obj1 = SimpleModel(pk=1)
    obj2 = SimpleModel(pk=2)
    obj3 = SimpleModel(pk=3)
    collector = Collector()
    collector.add(obj1)
    collector.add(obj2)
    collector.add(obj3)
    count = collector.delete()
    assert count == 3
    assert obj1.pk is None
    assert obj2.pk is None
    assert obj3.pk is None
    print("test_delete_multiple PASSED")

def test_delete_empty():
    collector = Collector()
    count = collector.delete()
    assert count == 0
    print("test_delete_empty PASSED")

if __name__ == "__main__":
    test_delete_clears_pk()
    test_delete_multiple()
    test_delete_empty()
    print("ALL TESTS PASSED")
''',
    })

    # ─── Task 7: render_to_string autoescape (from django__django-11119) ───
    tasks.append({
        "id": "swe_autoescape",
        "description": "render_to_string should honor autoescape setting (SWE-bench django-11119 style)",
        "problem_statement": (
            "Engine.render_to_string() creates a Context without specifying the engine's "
            "autoescape attribute. So if you create an engine with autoescape=False and "
            "then call its render_to_string() method, the result will always be autoescaped. "
            "Fix render_to_string to pass the engine's autoescape setting to the Context."
        ),
        "source_file": "engine.py",
        "buggy_code": '''class Context:
    def __init__(self, autoescape=True):
        self.autoescape = autoescape

class Template:
    def __init__(self, source):
        self.source = source
    
    def render(self, context):
        if context.autoescape:
            return self.source.replace("<", "&lt;").replace(">", "&gt;")
        return self.source

class Engine:
    def __init__(self, autoescape=True):
        self.autoescape = autoescape
    
    def render_to_string(self, template_source, context_dict=None):
        template = Template(template_source)
        # Bug: Context is created without passing the engine's autoescape setting
        context = Context()
        if context_dict:
            for k, v in context_dict.items():
                pass  # would set context vars
        return template.render(context)
''',
        "fixed_code": '''class Context:
    def __init__(self, autoescape=True):
        self.autoescape = autoescape

class Template:
    def __init__(self, source):
        self.source = source
    
    def render(self, context):
        if context.autoescape:
            return self.source.replace("<", "&lt;").replace(">", "&gt;")
        return self.source

class Engine:
    def __init__(self, autoescape=True):
        self.autoescape = autoescape
    
    def render_to_string(self, template_source, context_dict=None):
        template = Template(template_source)
        # Fix: pass the engine's autoescape setting to Context
        context = Context(autoescape=self.autoescape)
        if context_dict:
            for k, v in context_dict.items():
                pass  # would set context vars
        return template.render(context)
''',
        "test_code": '''from engine import Engine

def test_autoescape_true():
    e = Engine(autoescape=True)
    result = e.render_to_string("<b>hello</b>")
    assert result == "&lt;b&gt;hello&lt;/b&gt;", f"Got: {result}"
    print("test_autoescape_true PASSED")

def test_autoescape_false():
    e = Engine(autoescape=False)
    result = e.render_to_string("<b>hello</b>")
    assert result == "<b>hello</b>", f"Got: {result}"
    print("test_autoescape_false PASSED")

def test_default_autoescape():
    e = Engine()
    result = e.render_to_string("<b>hello</b>")
    assert "&lt;" in result
    print("test_default_autoescape PASSED")

if __name__ == "__main__":
    test_autoescape_true()
    test_autoescape_false()
    test_default_autoescape()
    print("ALL TESTS PASSED")
''',
    })

    # ─── Task 8: Count distinct space (from django__django-10880) ───
    tasks.append({
        "id": "swe_count_distinct",
        "description": "Count with distinct=True should add space in SQL (SWE-bench django-10880 style)",
        "problem_statement": (
            "A Count annotation containing both a Case condition and a distinct=True parameter "
            "produces a query error. A space is missing: 'COUNT(DISTINCTCASE WHEN ...)' should be "
            "'COUNT(DISTINCT CASE WHEN ...)'. Fix the SQL generation to add the missing space."
        ),
        "source_file": "aggregates.py",
        "buggy_code": '''def build_count_sql(expression, distinct=False):
    """Build a COUNT SQL expression.
    
    Args:
        expression: The expression to count.
        distinct: Whether to use COUNT(DISTINCT ...).
    Returns:
        SQL string.
    """
    if distinct:
        return f"COUNT(DISTINCT{expression})"
    return f"COUNT({expression})"
''',
        "fixed_code": '''def build_count_sql(expression, distinct=False):
    """Build a COUNT SQL expression.
    
    Args:
        expression: The expression to count.
        distinct: Whether to use COUNT(DISTINCT ...).
    Returns:
        SQL string.
    """
    if distinct:
        return f"COUNT(DISTINCT {expression})"
    return f"COUNT({expression})"
''',
        "test_code": '''from aggregates import build_count_sql

def test_normal_count():
    sql = build_count_sql("id")
    assert sql == "COUNT(id)", f"Got: {sql}"
    print("test_normal_count PASSED")

def test_distinct_count():
    sql = build_count_sql("id", distinct=True)
    assert sql == "COUNT(DISTINCT id)", f"Got: {sql}"
    print("test_distinct_count PASSED")

def test_distinct_case_when():
    sql = build_count_sql("CASE WHEN x THEN 1 ELSE 0 END", distinct=True)
    assert "DISTINCT CASE" in sql, f"Missing space in: {sql}"
    print("test_distinct_case_when PASSED")

if __name__ == "__main__":
    test_normal_count()
    test_distinct_count()
    test_distinct_case_when()
    print("ALL TESTS PASSED")
''',
    })

    # Save tasks
    tasks_file = tasks_dir / "tasks.json"
    with tasks_file.open("w", encoding="utf-8") as f:
        json.dump(tasks, f, indent=2, ensure_ascii=False)

    # Also write each task's files to disk for verification
    for task in tasks:
        task_subdir = tasks_dir / task["id"]
        task_subdir.mkdir(exist_ok=True)
        (task_subdir / task["source_file"]).write_text(task["buggy_code"], encoding="utf-8")
        (task_subdir / "test_task.py").write_text(task["test_code"], encoding="utf-8")

    return tasks


def main():
    import argparse
    parser = argparse.ArgumentParser(description="SWE-bench-style agentic benchmark")
    parser.add_argument("--limit", type=int, default=8)
    parser.add_argument("--baseline-only", action="store_true")
    parser.add_argument("--memory-only", action="store_true")
    parser.add_argument("--output", default="data/benchmarks/agentic_results.json")
    args = parser.parse_args()

    print("Creating SWE-bench-style tasks...", flush=True)
    tasks = create_tasks()
    tasks = tasks[:args.limit]
    print(f"  {len(tasks)} tasks created", flush=True)

    # Verify all tasks fail before fix and pass after fix
    print("\nVerifying tasks...", flush=True)
    valid_tasks = []
    for task in tasks:
        task_dir = TASKS_DIR / task["id"]
        # Test buggy code
        (task_dir / task["source_file"]).write_text(task["buggy_code"], encoding="utf-8")
        (task_dir / "test_task.py").write_text(task["test_code"], encoding="utf-8")
        exit_code, _ = run_test(task_dir)
        if exit_code == 0:
            print(f"  {task['id']}: SKIP (test passes before fix)", flush=True)
            continue
        # Test fixed code
        (task_dir / task["source_file"]).write_text(task["fixed_code"], encoding="utf-8")
        exit_code, _ = run_test(task_dir)
        if exit_code != 0:
            print(f"  {task['id']}: SKIP (test fails even with gold fix)", flush=True)
            continue
        print(f"  {task['id']}: OK (fails before fix, passes after)", flush=True)
        valid_tasks.append(task)
        # Reset to buggy
        (task_dir / task["source_file"]).write_text(task["buggy_code"], encoding="utf-8")

    print(f"\n{len(valid_tasks)} valid tasks", flush=True)
    if not valid_tasks:
        print("No valid tasks. Exiting.", flush=True)
        return

    client = get_client()
    use_memory = not args.baseline_only
    use_baseline = not args.memory_only

    all_results = []
    for task in valid_tasks:
        task_dir = TASKS_DIR / task["id"]
        result = run_task(client, task, task_dir, use_memory=use_memory, use_baseline=use_baseline)
        all_results.append(result)

        RESULTS_DIR.mkdir(parents=True, exist_ok=True)
        (RESULTS_DIR / "incremental.json").write_text(
            json.dumps(all_results, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(
        json.dumps(all_results, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # Summary
    print(f"\n{'='*60}")
    print(f"  AGENTIC BENCHMARK RESULTS (Qwen 3.5 9B)")
    print(f"{'='*60}")
    completed = [r for r in all_results if r.get("status") == "completed"]
    print(f"  Tasks completed: {len(completed)}")
    if use_baseline:
        b_solved = sum(1 for r in completed if r.get("baseline", {}).get("solved"))
        print(f"  Baseline solved:  {b_solved}/{len(completed)} = {b_solved/max(1,len(completed)):.1%}")
    if use_memory:
        m_solved = sum(1 for r in completed if r.get("memory", {}).get("solved"))
        print(f"  Memory solved:    {m_solved}/{len(completed)} = {m_solved/max(1,len(completed)):.1%}")
    print(f"\n  {'Task':<35s} {'Baseline':>10s} {'Memory':>10s} {'Mem IDs':>30s}")
    print(f"  {'-'*35} {'-'*10} {'-'*10} {'-'*30}")
    for r in completed:
        tid = r["task_id"][:33]
        b = "SOLVED" if r.get("baseline", {}).get("solved") else "FAIL"
        m = "SOLVED" if r.get("memory", {}).get("solved") else "FAIL"
        mems = ",".join(r.get("memories_retrieved", [])[:2])[:28]
        print(f"  {tid:<35s} {b:>10s} {m:>10s} {mems:>30s}")


if __name__ == "__main__":
    main()

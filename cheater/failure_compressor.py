"""Cheater failure compressor: turn raw pytest / py_compile / runtime output
into a tight, model-friendly JSON summary.

Why this exists:
  - A raw pytest log is hundreds or thousands of lines. A 9B model chokes on
    that. We need a single small JSON blob that points the model at the
    right test, the right error type, and the right files.
  - This module is deterministic. The LLM does NOT see raw output, ever.

Public API:
  compress_command_result(command, stdout, stderr, exit_code)
        -> FailureSummary
  render_failure_for_model(summary, max_tokens=3000) -> str

The FailureSummary dataclass serializes to:
  {
    "command": "...",
    "passed": bool,
    "exit_code": int,
    "failures": [
       {"test": ..., "error_type": ..., "message": ...,
        "expected": ..., "got": ...,
        "top_stack_files": [...], "likely_relevant_files": [...]}
    ],
    "summary": "...",
    "is_syntax_error": bool,
    "is_import_error": bool,
    "is_test_failure": bool
  }
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

# pytest patterns
_PYTEST_FAILED_LINE_RE = re.compile(r"^FAILED\s+([\w./:\\-]+?)(?:\s*-\s*|\s*$)", re.MULTILINE)
_PYTEST_PASSED_RE = re.compile(r"=+\s*(\d+)\s+passed")
_PYTEST_FAILED_RE = re.compile(r"=+\s*(\d+)\s+failed")
# Strip ANSI / trailing =s inside the captured group
_PYTEST_SHORT_SUMMARY_RE = re.compile(
    r"=+\s*((?:\d+\s+)?(?:passed|failed|error|skipped|warning)[^\n=]*?)\s*=+"
)
_PYTEST_TEST_LINE_RE = re.compile(r"^(FAILED\s+\S+)$", re.MULTILINE)
_PY_ASSERT_RE = re.compile(r"AssertionError:?\s*(.*)", re.IGNORECASE)
_PY_ASSERT_DETAIL_RE = re.compile(r"assert\s+(.+?)\s*$", re.MULTILINE)
_PY_FILE_LINE_RE = re.compile(r"""File ['"]([^'"]+)['"], line (\d+)""")
_PY_SYNTAX_HINT_RE = re.compile(
    r"File ['\"]([^'\"]+)['\"], line (\d+).*?(?:SyntaxError|IndentationError|TabError)",
    re.DOTALL,
)
_PY_IMPORT_ERROR_RE = re.compile(r"(?:^|\n)(?:from\s+([\w.]+)\s+import\s+([\w, ]+)|import\s+([\w.]+))")
_PY_MOD_NOT_FOUND_RE = re.compile(r"ModuleNotFoundError: No module named '([^']+)'")
_PY_GENERIC_ERR_RE = re.compile(r"\b(\w+(?:Error|Exception|Interrupt|Exit|Fatal))\b")

_TAIL_KEEP = 1500
_TAIL_MAX_LINES = 80


# ---------- data types ----------

@dataclass
class FailureEntry:
    test: str = ""
    error_type: str = ""
    message: str = ""
    expected: str = ""
    got: str = ""
    top_stack_files: list[str] = field(default_factory=list)
    likely_relevant_files: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class FailureSummary:
    command: str = ""
    passed: bool = True
    exit_code: int = 0
    failures: list[FailureEntry] = field(default_factory=list)
    summary: str = ""
    is_syntax_error: bool = False
    is_import_error: bool = False
    is_test_failure: bool = False
    tail: str = ""
    error_type: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "command": self.command,
            "passed": self.passed,
            "exit_code": self.exit_code,
            "failures": [f.to_dict() for f in self.failures],
            "summary": self.summary,
            "is_syntax_error": self.is_syntax_error,
            "is_import_error": self.is_import_error,
            "is_test_failure": self.is_test_failure,
            "error_type": self.error_type,
        }


# ---------- helpers ----------

def _clip(text: str, max_chars: int) -> str:
    if not text or len(text) <= max_chars:
        return text or ""
    return text[:max(0, max_chars - 30)] + "\n... [truncated]"


def _tail(text: str, max_lines: int = _TAIL_MAX_LINES, max_chars: int = _TAIL_KEEP) -> str:
    if not text:
        return ""
    lines = text.splitlines()
    tail = "\n".join(lines[-max_lines:])
    return _clip(tail, max_chars)


def _stack_files(output: str) -> list[str]:
    """Extract unique file paths from a Python traceback (top first)."""
    seen: list[str] = []
    seen_set: set[str] = set()
    for m in _PY_FILE_LINE_RE.finditer(output):
        path = m.group(1).replace("\\", "/")
        if path not in seen_set:
            seen.append(path)
            seen_set.add(path)
    return seen


def _strip_ansi(text: str) -> str:
    return re.sub(r"\x1b\[[0-9;]*[a-zA-Z]", "", text or "")


# ---------- main entry point ----------

def compress_command_result(
    command: str,
    stdout: str,
    stderr: str,
    exit_code: int,
) -> FailureSummary:
    """Parse the output and return a FailureSummary. Never raises."""
    s = FailureSummary(command=command, exit_code=exit_code)
    out = _strip_ansi((stdout or "") + "\n" + (stderr or ""))
    s.tail = _tail(out)
    s.passed = exit_code == 0
    if s.passed:
        s.summary = "command exited 0"
        return s
    # 1) Syntax error
    sm = _PY_SYNTAX_HINT_RE.search(out)
    if sm:
        s.is_syntax_error = True
        # Detect error type from the matched range (last 20 chars)
        tail = sm.group(0).split("\n")[-1].strip()
        for et in ("SyntaxError", "IndentationError", "TabError"):
            if et in tail:
                s.error_type = et
                break
        if not s.error_type:
            s.error_type = "SyntaxError"
        s.summary = f"Python {s.error_type} at {sm.group(1)}:L{sm.group(2)}"
        s.failures.append(FailureEntry(
            test="(no test)",
            error_type=s.error_type,
            message=s.summary,
            top_stack_files=[sm.group(1).replace("\\", "/")],
            likely_relevant_files=[sm.group(1).replace("\\", "/")],
        ))
        return s
    # 2) Import error
    if "ModuleNotFoundError" in out or "ImportError" in out:
        s.is_import_error = True
        m = _PY_MOD_NOT_FOUND_RE.search(out)
        if m:
            s.error_type = "ModuleNotFoundError"
            s.summary = f"ModuleNotFoundError: {m.group(1)}"
        else:
            m2 = _PY_GENERIC_ERR_RE.search(out)
            s.error_type = m2.group(1) if m2 else "ImportError"
            s.summary = "import failed"
        # Try to grab the offending line
        for imp in _PY_IMPORT_ERROR_RE.finditer(out)[:3] if False else _PY_IMPORT_ERROR_RE.finditer(out):
            pass
        # Find the traceback top
        stack = _stack_files(out)
        s.failures.append(FailureEntry(
            test="(import)",
            error_type=s.error_type,
            message=s.summary,
            top_stack_files=stack[:5],
            likely_relevant_files=stack[:3],
        ))
        return s
    # 3) Pytest failure
    failed_tests = list(dict.fromkeys(m.group(1) for m in _PYTEST_FAILED_LINE_RE.finditer(out)))
    if failed_tests or "FAILED" in out or "= " in out and " failed " in out:
        s.is_test_failure = True
        # Summary line
        pm = _PYTEST_SHORT_SUMMARY_RE.search(out)
        if pm:
            s.summary = pm.group(1).strip()
        else:
            s.summary = f"{len(failed_tests)} test(s) failed"
        # Pull each failure block. Pytest writes a '_____<test>_____' separator
        # before the test body, and the body ends at the next separator
        # ('_____' or '====' final summary).
        for test_name in failed_tests[:10]:
            short = test_name.split("::")[-1] if "::" in test_name else Path(test_name).stem
            esc = re.escape(short)
            # Try a few separator shapes
            body_start = None
            for pat in (
                rf"^_{5,}\s+{esc}\s+_{5,}\s*$",
                rf"^_{5,}\s+{esc}\s*$",
                rf"^_{5,}\s+{re.escape(test_name)}\s+_{5,}\s*$",
            ):
                bm = re.search(pat, out, re.MULTILINE)
                if bm:
                    body_start = bm.end()
                    break
            if body_start is None:
                # Fall back to the FAILED line
                tm = re.search(r"^FAILED\s+" + re.escape(test_name) + r".*$",
                               out, re.MULTILINE)
                if not tm:
                    continue
                body_start = tm.end()
            # End: next '_____' or '====' final summary
            next_sep = re.search(r"^(?:_{5,}|=+\s+\d)", out[body_start:], re.MULTILINE)
            body_end = body_start + next_sep.start() if next_sep else len(out)
            body = out[body_start:body_end]
            e = FailureEntry(test=test_name)
            e.top_stack_files = _stack_files(body)
            if not e.top_stack_files and "::" in test_name:
                # The body didn't include a stack; use the test file path
                tf = test_name.split("::", 1)[0]
                e.top_stack_files = [tf]
            e.likely_relevant_files = e.top_stack_files[:3]
            et = _PY_GENERIC_ERR_RE.search(body)
            if et:
                e.error_type = et.group(1)
            am = _PY_ASSERT_RE.search(body)
            if am:
                e.message = am.group(1).strip()[:300]
            if not e.message:
                for ln in body.splitlines():
                    ls = ln.strip()
                    if ls.startswith("E   ") or ls.startswith("E "):
                        e.message = ls.lstrip("E ").strip()[:300]
                        break
            if not e.message:
                for ln in body.splitlines():
                    ls = ln.strip()
                    if ls and not ls.startswith(">"):
                        e.message = ls[:300]
                        break
            e.expected, e.got = _extract_expected_got(body)
            s.failures.append(e)
        # Fallback if we still built nothing
        if not s.failures and failed_tests:
            for t in failed_tests[:10]:
                e = FailureEntry(test=t)
                e.top_stack_files = _stack_files(out)
                e.likely_relevant_files = e.top_stack_files[:3]
                s.failures.append(e)
        return s
    # 4) Generic Python runtime error
    m = _PY_GENERIC_ERR_RE.search(out)
    if m:
        s.error_type = m.group(1)
        # Try to extract the error message on the same line (e.g. "ValueError: oh no")
        line_re = re.compile(rf"^{re.escape(s.error_type)}:\s*(.+?)$", re.MULTILINE)
        lm = line_re.search(out)
        if lm:
            s.summary = f"{s.error_type}: {lm.group(1).strip()[:200]}"
        else:
            s.summary = f"{s.error_type} raised"
    else:
        s.summary = f"command exited {exit_code}"
    s.failures.append(FailureEntry(
        test="(runtime)",
        error_type=s.error_type or "RuntimeError",
        message=s.summary,
        top_stack_files=_stack_files(out)[:5],
        likely_relevant_files=_stack_files(out)[:3],
    ))
    return s


# ---------- expected/got extraction ----------

def _extract_expected_got(block: str) -> tuple[str, str]:
    """Best-effort parse of 'assert X == Y' or pytest AssertionError."""
    expected = ""
    got = ""
    # pytest "AssertionError: <a> == <b>" or "assert <a> == <b>"
    m = re.search(r"assert\s+(.+?)\s*==\s*(.+?)$", block, re.MULTILINE)
    if m:
        got = m.group(1).strip()[:200]
        expected = m.group(2).strip()[:200]
    if not expected:
        m = re.search(r"AssertionError:\s*(.+?)\s*==\s*(.+)", block)
        if m:
            got = m.group(1).strip()[:200]
            expected = m.group(2).strip()[:200]
    return expected, got


# ---------- rendering ----------

def render_failure_for_model(summary: FailureSummary, max_tokens: int = 3000) -> str:
    """Render the summary as a tight markdown block for the model."""
    cap = max(400, max_tokens * 4)
    out: list[str] = []
    out.append("=== TEST FAILURE SUMMARY ===")
    out.append(f"command:    {summary.command}")
    out.append(f"exit_code:  {summary.exit_code}")
    out.append(f"passed:     {summary.passed}")
    if summary.error_type:
        out.append(f"error_type: {summary.error_type}")
    out.append(f"summary:    {summary.summary}")
    flags: list[str] = []
    if summary.is_syntax_error:
        flags.append("SYNTAX_ERROR")
    if summary.is_import_error:
        flags.append("IMPORT_ERROR")
    if summary.is_test_failure:
        flags.append("TEST_FAILURE")
    if flags:
        out.append(f"flags:      {' '.join(flags)}")
    if summary.failures:
        out.append("")
        out.append(f"failures ({len(summary.failures)}):")
        for i, f in enumerate(summary.failures[:10], start=1):
            out.append(f"  [{i}] test: {f.test or '(unknown)'}")
            if f.error_type:
                out.append(f"      error_type: {f.error_type}")
            if f.message:
                out.append(f"      message:    {f.message}")
            if f.expected or f.got:
                out.append(f"      expected:   {f.expected}")
                out.append(f"      got:        {f.got}")
            if f.top_stack_files:
                out.append(f"      stack:      {', '.join(f.top_stack_files[:5])}")
            if f.likely_relevant_files:
                out.append(f"      files:      {', '.join(f.likely_relevant_files[:3])}")
    if summary.tail:
        out.append("")
        out.append("tail (last lines, raw):")
        out.append("```")
        out.append(_clip(summary.tail, max(200, cap // 2)))
        out.append("```")
    out.append("")
    out.append("HINTS:")
    out.append("- Do NOT edit tests unless explicitly allowed.")
    out.append("- Use localize_bug to find the suspect source files.")
    out.append("- Use inspect_symbol to see callers/definitions.")
    out.append("- Use read_context_pack for a compact context block.")
    text = "\n".join(out)
    return _clip(text, cap)

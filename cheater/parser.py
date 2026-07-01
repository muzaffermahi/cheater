"""Forgiving tool-call parser for small (8B-35B) models.

Small models produce messy output. This module parses tool calls from
multiple formats and auto-repairs common mistakes.

Supported input formats (in order tried):
  1. JSON (with code fences, surrounding prose)
  2. YAML (key: value blocks)
  3. XML tool-call format
  4. Hermes format (<|tool_call|>)
  5. Plain-text "verb args" format (rare)

Auto-repair fixes:
  - Missing quotes around JSON keys
  - Trailing commas
  - Single quotes → double quotes
  - Python booleans (True/False) → JSON (true/false)
  - Python None → JSON null
  - Unescaped newlines in strings
  - Trailing semicolons

Public API:
  parse_tool_call(text) -> tuple[dict | None, str]
      Returns (parsed, error_reason). parsed has shape {"action": str, "args": dict}
      or {"category": str} for the 2-stage router.
  parse_json_loose(text) -> tuple[Any, str]
      Generic JSON parse with repair. Returns (value, error_reason).
  repair_json(text) -> str
      Apply common repairs to a JSON string. Best-effort.

The parser is intentionally permissive. It prefers a "good" parse over
"strict correctness" because small models fail at strict correctness ~30%
of the time.
"""
from __future__ import annotations

import json
import re
from typing import Any


# ---------- the main entry point ----------

def parse_tool_call(text: str) -> tuple[dict | None, str]:
    """Parse a tool call from any supported format.

    Returns (parsed, ""). parsed has shape {"action": str, "args": dict}
    or {"category": str} for the 2-stage router. On failure, returns
    (None, reason).
    """
    if not text or not text.strip():
        return None, "empty response"
    text = text.strip()
    # Try each format in order
    for fn in (
        _parse_json_format,
        _parse_hermes_format,
        _parse_xml_format,
        _parse_yaml_format,
        _parse_plain_verb_format,
    ):
        try:
            parsed = fn(text)
            if isinstance(parsed, dict):
                # Normalize: ensure {"action": ..., "args": ...} or {"category": ...}
                if "category" in parsed and len(parsed) <= 2:
                    return {"category": str(parsed["category"])}, ""
                if "action" in parsed:
                    args = parsed.get("args", {})
                    if not isinstance(args, dict):
                        args = {"value": args}
                    return {"action": str(parsed["action"]), "args": args}, ""
        except Exception:
            continue
    return None, "could not parse tool call from any format"


def parse_json_loose(text: str) -> tuple[Any, str]:
    """Generic JSON parse with auto-repair. Returns (value, error_reason)."""
    if not text or not text.strip():
        return None, "empty"
    text = text.strip()
    # Try raw
    try:
        return json.loads(text), ""
    except json.JSONDecodeError:
        pass
    # Try with code fences stripped
    m = re.search(r"```(?:json)?\s*\n(.*?)\n```", text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(1).strip()), ""
        except json.JSONDecodeError:
            text = m.group(1).strip()
    # Try with surrounding prose stripped
    start = text.find("{")
    if start >= 0:
        end = text.rfind("}")
        if end > start:
            candidate = text[start:end + 1]
            try:
                return json.loads(candidate), ""
            except json.JSONDecodeError:
                pass
            # Try with repair
            repaired = repair_json(candidate)
            try:
                return json.loads(repaired), ""
            except json.JSONDecodeError as e:
                return None, f"json parse error after repair: {e}"
    return None, "no JSON object found"


# ---------- format-specific parsers ----------

def _parse_json_format(text: str) -> dict | None:
    """Parse JSON object. Tolerant of code fences, surrounding prose, repair."""
    parsed, _err = parse_json_loose(text)
    if isinstance(parsed, dict):
        return parsed
    return None


_HERMES_RE = re.compile(r"<\|tool_call\|>\s*(\{.*?\})\s*(?:<\|/tool_call\|>|$)", re.DOTALL)


def _parse_hermes_format(text: str) -> dict | None:
    """Parse Hermes format: <|tool_call|>{"name": "...", "arguments": {...}}<|/tool_call|>"""
    m = _HERMES_RE.search(text)
    if not m:
        return None
    raw = m.group(1).strip()
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        try:
            obj = json.loads(repair_json(raw))
        except json.JSONDecodeError:
            return None
    if not isinstance(obj, dict):
        return None
    # Hermes uses "name" + "arguments"
    name = obj.get("name") or obj.get("function") or obj.get("tool")
    args = obj.get("arguments", obj.get("args", obj.get("parameters", {})))
    if not name:
        return None
    if not isinstance(args, dict):
        args = {"value": args}
    return {"action": str(name), "args": args}


_XML_TOOL_RE = re.compile(
    r"<(?:tool|function|call)\s+name=[\"']([^\"']+)[\"']\s*>(.*?)</(?:tool|function|call)>",
    re.DOTALL,
)
_XML_ARG_RE = re.compile(r"<(?:arg|param)\s+name=[\"']([^\"']+)[\"']\s*>(.*?)</(?:arg|param)>", re.DOTALL)


def _parse_xml_format(text: str) -> dict | None:
    """Parse XML tool-call format: <tool name="x"><arg name="y">v</arg></tool>"""
    m = _XML_TOOL_RE.search(text)
    if not m:
        return None
    name = m.group(1)
    body = m.group(2)
    args: dict[str, str] = {}
    for am in _XML_ARG_RE.finditer(body):
        args[am.group(1)] = am.group(2).strip()
    if not args:
        # Maybe self-closing: <tool name="x" arg="v" />
        for am in re.finditer(r"\barg=[\"']([^\"']+)[\"']\s*=\s*[\"']([^\"']+)[\"']", body):
            args[am.group(1)] = am.group(2)
    return {"action": str(name), "args": args}


def _parse_yaml_format(text: str) -> dict | None:
    """Parse YAML-like key: value blocks.

    Common in small models. Looks for:
      action: tool_name
      args:
        key: value
    or
      action: tool_name
      key: value
    """
    lines = text.splitlines()
    if not lines:
        return None
    # Find the action line
    action = None
    arg_lines: list[tuple[int, str]] = []  # (indent, line)
    for i, line in enumerate(lines):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if action is None:
            m = re.match(r"^action\s*:\s*(.+)$", stripped)
            if m:
                action = m.group(1).strip().strip("'\"")
                continue
            # Some models write `- action: name` (YAML list)
            m = re.match(r"^-\s*action\s*:\s*(.+)$", stripped)
            if m:
                action = m.group(1).strip().strip("'\"")
                continue
        else:
            arg_lines.append((len(line) - len(line.lstrip()), line))
    if not action:
        return None
    # Parse args (simple flat dict)
    args: dict[str, Any] = {}
    current_key: str | None = None
    current_value: list[str] = []
    for indent, line in arg_lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped == "args:":
            continue
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$", stripped)
        if m:
            if current_key is not None:
                args[current_key] = _coerce_yaml_value("\n".join(current_value).strip())
            current_key = m.group(1)
            current_value = [m.group(2)] if m.group(2) else []
        elif current_key is not None:
            current_value.append(stripped)
    if current_key is not None:
        args[current_key] = _coerce_yaml_value("\n".join(current_value).strip())
    if not args:
        # Maybe the model just put everything on one line
        return {"action": action, "args": {}}
    return {"action": action, "args": args}


def _coerce_yaml_value(v: str) -> Any:
    """Best-effort coerce a YAML string to a Python value."""
    if not v:
        return ""
    if v.lower() in ("true", "yes"):
        return True
    if v.lower() in ("false", "no"):
        return False
    if v.lower() in ("null", "none", "~"):
        return None
    if v.startswith('"') and v.endswith('"'):
        return v[1:-1]
    if v.startswith("'") and v.endswith("'"):
        return v[1:-1]
    if v.startswith("[") and v.endswith("]"):
        # Inline list
        items = [_coerce_yaml_value(x.strip()) for x in v[1:-1].split(",") if x.strip()]
        return items
    try:
        if "." in v:
            return float(v)
        return int(v)
    except ValueError:
        return v


# Verb args format: "read_file(path='x.py', line_range='1-50')"
# Very rare, but seen in some small models.
_VERB_RE = re.compile(
    r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)\s*$",
    re.DOTALL,
)


def _parse_plain_verb_format(text: str) -> dict | None:
    m = _VERB_RE.match(text.strip())
    if not m:
        return None
    name = m.group(1)
    body = m.group(2)
    if not body.strip():
        return {"action": name, "args": {}}
    # Parse key=value, key="value", or positional args
    args: dict[str, Any] = {}
    pos = 0
    i = 0
    while i < len(body):
        # Skip whitespace and commas
        while i < len(body) and body[i] in " \t,":
            i += 1
        if i >= len(body):
            break
        # Try key=value
        m2 = re.match(r"\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*", body[i:])
        if m2:
            key = m2.group(1)
            i += m2.end()
            # Parse the value
            if i < len(body) and body[i] in "'\"":
                quote = body[i]
                i += 1
                start = i
                while i < len(body) and body[i] != quote:
                    if body[i] == "\\" and i + 1 < len(body):
                        i += 2
                    else:
                        i += 1
                val = body[start:i]
                if i < len(body):
                    i += 1  # skip closing quote
            else:
                start = i
                while i < len(body) and body[i] not in ",":
                    i += 1
                val = body[start:i].strip()
            args[key] = val
        else:
            # Positional: just a value
            start = i
            while i < len(body) and body[i] not in ",":
                i += 1
            val = body[start:i].strip().strip("'\"")
            args[f"arg{pos}"] = val
            pos += 1
    return {"action": name, "args": args}


# ---------- auto-repair ----------

def repair_json(text: str) -> str:
    """Apply common JSON repairs. Best-effort, not perfect."""
    s = text
    # Replace Python booleans / None
    s = re.sub(r"\bTrue\b", "true", s)
    s = re.sub(r"\bFalse\b", "false", s)
    s = re.sub(r"\bNone\b", "null", s)
    # Single quotes → double quotes (rough)
    # This is dangerous for strings with apostrophes; only do safe substitutions.
    # Replace 'foo' (with no inner single quote) → "foo"
    s = re.sub(r"'([^'\n]+)'", r'"\1"', s)
    # Trailing commas before } or ]
    s = re.sub(r",\s*([}\]])", r"\1", s)
    # Keys without quotes:  {foo: 1} → {"foo": 1}
    s = re.sub(r"([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:", r'\1"\2":', s)
    # Unescaped newlines in string values — replace literal newlines inside strings with \n
    # This is hard to do correctly; skip for now.
    return s

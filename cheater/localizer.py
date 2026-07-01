"""Cheater localizer: Agentless-style file + symbol localization.

The localizer does ONE thing: it ranks where to look. It does NOT propose
patches, it does NOT edit files, and it does NOT call other tools. The
output is a validated JSON object the model downstream (or the deterministic
fallback) can consume.

Pipeline:
  1. deterministic_localize(task, traceback, repo_map)
       - pure-Python, no model required
       - extracts file paths from the traceback
       - tokenizes task + traceback
       - scores every RepoFile by query overlap (path, symbols, imports)
       - returns a LocalizationResult

  2. localize_with_model(model_client, task, context_pack)
       - asks the model to fill the same JSON shape
       - if invalid JSON, attempts one repair call
       - on second failure, falls back to deterministic_localize

JSON shape (validated):
  {
    "suspected_files":    [{"path": str, "confidence": 0..1, "reason": str}],
    "suspected_symbols":  [{"name": str, "file": str, "confidence": 0..1, "reason": str}],
    "search_queries":     [str],
    "needed_context":     [str],
    "risk_notes":         [str]
  }

Public API:
  LocalizationResult                 -- dataclass with the JSON shape
  localize_with_model(model, ...)    -- model path
  deterministic_localize(task, ...)  -- pure-Python fallback
  collect_localized_context(result)  -- load the source snippets
  repair_localization_json(text)     -- best-effort JSON repair
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Iterable


# Match "File 'path', line N" or 'File "path", line N'
_PY_FILE_RE = re.compile(r"""File ['"]([^'"]+)['"], line (\d+)""")
# Match pytest "FAILED tests/test_x.py::test_y - reason"
_PYTEST_FAILED_RE = re.compile(r"FAILED\s+([\w./:\\-]+?)(?:\s*-\s*|\s*$)")
# Match import errors: "from foo.bar import baz" / "import foo.bar"
_IMPORT_ERR_RE = re.compile(r"(?:from\s+([\w.]+)\s+import\s+([\w., ]+))|(?:import\s+([\w.]+))")
# Match a JSON object even with prose around it
_JSON_OBJ_RE = re.compile(r"\{.*\}", re.DOTALL)

MAX_FILES_CTX = 12
MAX_CHARS_PER_FILE = 12_000

# Stopwords used by the localizer. Kept small and conservative.
_STOPWORDS: set[str] = {
    "py", "in", "to", "for", "of", "the", "a", "an", "and", "or", "but",
    "with", "is", "on", "by", "from", "as", "be", "it", "this", "that",
    "all", "any", "some", "no", "nor", "not", "have", "has", "had", "do",
    "does", "did", "so", "such", "than", "too", "very", "can", "will",
    "would", "should", "could", "may", "might", "must", "shall", "i", "we",
    "you", "your", "they", "he", "she", "them", "us", "me", "my", "our",
}


# ---------- data types ----------

@dataclass
class SuspectedFile:
    path: str
    confidence: float
    reason: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class SuspectedSymbol:
    name: str
    file: str
    confidence: float
    reason: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class LocalizationResult:
    suspected_files: list[SuspectedFile] = field(default_factory=list)
    suspected_symbols: list[SuspectedSymbol] = field(default_factory=list)
    search_queries: list[str] = field(default_factory=list)
    needed_context: list[str] = field(default_factory=list)
    risk_notes: list[str] = field(default_factory=list)
    source: str = "deterministic"  # "model" | "deterministic" | "model-repaired" | "model-fallback"

    def to_dict(self) -> dict[str, Any]:
        return {
            "suspected_files": [s.to_dict() for s in self.suspected_files],
            "suspected_symbols": [s.to_dict() for s in self.suspected_symbols],
            "search_queries": list(self.search_queries),
            "needed_context": list(self.needed_context),
            "risk_notes": list(self.risk_notes),
            "source": self.source,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "LocalizationResult":
        if not isinstance(d, dict):
            raise ValueError("localizer JSON must be an object")
        files = []
        for f in (d.get("suspected_files") or []):
            if not isinstance(f, dict) or not f.get("path"):
                continue
            conf = f.get("confidence", 0.0)
            try:
                conf = float(conf)
            except (TypeError, ValueError):
                conf = 0.0
            conf = max(0.0, min(1.0, conf))
            files.append(SuspectedFile(path=str(f["path"]), confidence=conf,
                                       reason=str(f.get("reason", ""))[:200]))
        symbols = []
        for s in (d.get("suspected_symbols") or []):
            if not isinstance(s, dict) or not s.get("name") or not s.get("file"):
                continue
            conf = s.get("confidence", 0.0)
            try:
                conf = float(conf)
            except (TypeError, ValueError):
                conf = 0.0
            conf = max(0.0, min(1.0, conf))
            symbols.append(SuspectedSymbol(
                name=str(s["name"]), file=str(s["file"]),
                confidence=conf, reason=str(s.get("reason", ""))[:200],
            ))
        return cls(
            suspected_files=files,
            suspected_symbols=symbols,
            search_queries=[str(x)[:200] for x in (d.get("search_queries") or [])][:20],
            needed_context=[str(x)[:200] for x in (d.get("needed_context") or [])][:20],
            risk_notes=[str(x)[:200] for x in (d.get("risk_notes") or [])][:20],
            source=str(d.get("source", "model")),
        )


# ---------- helpers ----------

def _tokenize(text: str) -> list[str]:
    if not text:
        return []
    cleaned = re.sub(r"[/\\.,:;!?()\[\]{}<>\"']", " ", text)
    return [t.lower() for t in re.findall(r"[A-Za-z_][A-Za-z0-9_]*|\d+", cleaned)
            if len(t) >= 2]


def _clip(text: str, max_chars: int) -> str:
    if not text or len(text) <= max_chars:
        return text or ""
    return text[:max(0, max_chars - 30)] + "\n... [truncated]"


def _extract_traceback_files(traceback: str) -> list[tuple[str, int]]:
    if not traceback:
        return []
    out: list[tuple[str, int]] = []
    for m in _PY_FILE_RE.finditer(traceback):
        try:
            out.append((m.group(1).replace("\\", "/"), int(m.group(2))))
        except ValueError:
            continue
    return out


def _extract_pytest_targets(traceback: str) -> list[str]:
    if not traceback:
        return []
    return [m.group(1).replace("\\", "/") for m in _PYTEST_FAILED_RE.finditer(traceback)]


# ---------- deterministic localizer ----------

def deterministic_localize(
    task: str,
    traceback: str = "",
    repo_map: Any = None,
) -> LocalizationResult:
    """Pure-Python ranker. Never raises; always returns a LocalizationResult."""
    result = LocalizationResult(source="deterministic")
    q_tokens = _tokenize(task + " " + traceback)
    q_set = {t for t in q_tokens if len(t) >= 2 and t not in _STOPWORDS}
    # Files from traceback
    tb_files = _extract_traceback_files(traceback)
    pytest_targets = _extract_pytest_targets(traceback)
    # Score every file
    file_scores: dict[str, float] = {}
    reasons: dict[str, list[str]] = {}
    # Traceback files get a strong boost (top of stack first)
    for i, (path, line) in enumerate(tb_files):
        # Top of stack gets max boost
        boost = 10.0 - min(i, 5) * 1.5
        file_scores[path] = file_scores.get(path, 0.0) + boost
        reasons.setdefault(path, []).append(f"in traceback (line {line})")
    for p in pytest_targets:
        if p.endswith(".py"):
            # Test file: the *source* of the failure is its likely target
            base = Path(p).stem
            file_scores.setdefault(p, file_scores.get(p, 0.0) + 1.0)
            reasons.setdefault(p, []).append("pytest failed test")
            if base.startswith("test_"):
                src = base[len("test_"):] + ".py"
                file_scores[src] = file_scores.get(src, 0.0) + 1.5
                reasons.setdefault(src, []).append("matches failing test_*.py")
    if repo_map is not None:
        files = getattr(repo_map, "files", None) or []
        for rf in files:
            if isinstance(rf, dict):
                path = rf.get("path", "")
                syms: list[str] = []
                for c in (rf.get("classes") or []):
                    syms.append(c.get("name", ""))
                    for m in (c.get("methods") or []):
                        syms.append(str(m))
                for f in (rf.get("functions") or []):
                    syms.append(f.get("name", ""))
                import_terms: set[str] = set()
                for imp in (rf.get("imports") or []):
                    import_terms.update(imp.get("module", "").lower().split("."))
                    import_terms.update(n.lower() for n in (imp.get("names") or []))
            else:
                # RepoFile dataclass
                path = rf.path
                syms = list(rf.symbol_names())
                import_terms = set()
                for imp in rf.imports:
                    import_terms.update(imp.module.lower().split("."))
                    import_terms.update(n.lower() for n in imp.names)
            if not path:
                continue
            pl = path.lower()
            stem = pl.rsplit("/", 1)[-1].rsplit(".", 1)[0]
            score = 0.0
            for t in q_set:
                if t in pl.split("/"):
                    score += 4.0
                    reasons.setdefault(path, []).append(f"path segment '{t}'")
                elif t == stem:
                    score += 5.0
                    reasons.setdefault(path, []).append(f"filename '{t}'")
                elif t in stem:
                    score += 3.0
                    reasons.setdefault(path, []).append(f"path contains '{t}'")
                elif t in pl:
                    score += 1.0
                    reasons.setdefault(path, []).append(f"path contains '{t}'")
            for t in q_set:
                t_stripped = t.replace("_", "")
                for sn in syms:
                    low = sn.lower()
                    stripped = low.replace("_", "")
                    if t == low:
                        score += 4.0
                        reasons.setdefault(path, []).append(f"defines symbol '{t}'")
                        break
                    if t_stripped and (t_stripped == stripped or t_stripped in stripped or stripped in t_stripped):
                        score += 2.0
                        reasons.setdefault(path, []).append(f"defines symbol '{t}'")
                        break
                    if t in low or low in t:
                        score += 2.5
                        reasons.setdefault(path, []).append(f"defines symbol '{t}'")
                        break
            for t in q_set:
                if t in import_terms:
                    score += 0.8
                    reasons.setdefault(path, []).append(f"imports '{t}'")
            if score > 0:
                if path in file_scores:
                    file_scores[path] += score
                else:
                    file_scores[path] = file_scores.get(path, 0.0) + score
    # Normalize to 0..1
    if file_scores:
        top = max(file_scores.values()) or 1.0
        sorted_files = sorted(file_scores.items(), key=lambda x: x[1], reverse=True)
        for path, score in sorted_files[:MAX_FILES_CTX]:
            conf = max(0.05, min(1.0, score / top))
            reason = "; ".join(reasons.get(path, [])[:3])[:200]
            result.suspected_files.append(SuspectedFile(
                path=path, confidence=round(conf, 3), reason=reason,
            ))
    # Suspected symbols: from the top files, pick symbols matching tokens
    top_paths = [sf.path for sf in result.suspected_files[:6]]
    if repo_map is not None:
        files = getattr(repo_map, "files", None) or []
        rf_by_path: dict[str, Any] = {}
        for f in files:
            if isinstance(f, dict):
                rf_by_path[f.get("path", "")] = f
            else:
                rf_by_path[getattr(f, "path", "")] = f
        for path in top_paths:
            rf = rf_by_path.get(path)
            if rf is None:
                continue
            for c in getattr(rf, "classes", []):
                if isinstance(c, dict):
                    cls_name = c.get("name", "")
                    methods = c.get("methods") or []
                else:
                    cls_name = c.name
                    methods = c.methods
                if any(t in cls_name.lower() for t in q_set):
                    result.suspected_symbols.append(SuspectedSymbol(
                        name=cls_name, file=path, confidence=0.7,
                        reason="class name matches query",
                    ))
                for m in methods[:10]:
                    if any(t in m.lower() for t in q_set):
                        result.suspected_symbols.append(SuspectedSymbol(
                            name=f"{cls_name}.{m}", file=path, confidence=0.5,
                            reason="method name matches query",
                        ))
            for f in getattr(rf, "functions", []):
                if isinstance(f, dict):
                    fn_name = f.get("name", "")
                else:
                    fn_name = f.name
                if any(t in fn_name.lower() for t in q_set):
                    result.suspected_symbols.append(SuspectedSymbol(
                        name=fn_name, file=path, confidence=0.6,
                        reason="function name matches query",
                    ))
    # Search queries: top tokens, capped
    result.search_queries = sorted(q_set)[:10]
    # Needed context: top 3 paths
    result.needed_context = top_paths[:3]
    # Risk notes
    if any(Path(p).name.startswith("test_") for p in top_paths[:3]):
        result.risk_notes.append("top hits are tests; do not edit tests unless allowed")
    return result


# ---------- JSON repair ----------

def repair_localization_json(text: str) -> dict[str, Any] | None:
    """Best-effort: pull a JSON object out of arbitrary model output."""
    if not text:
        return None
    text = text.strip()
    # 1) Direct
    try:
        d = json.loads(text)
        return d if isinstance(d, dict) else None
    except Exception:
        pass
    # 2) Strip code fences
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if m:
        try:
            d = json.loads(m.group(1))
            return d if isinstance(d, dict) else None
        except Exception:
            pass
    # 3) First {...} block
    m = _JSON_OBJ_RE.search(text)
    if m:
        candidate = m.group(0)
        try:
            d = json.loads(candidate)
            return d if isinstance(d, dict) else None
        except Exception:
            pass
        # 4) Try to fix a trailing comma / single-quote issue
        fixed = re.sub(r",\s*([}\]])", r"\1", candidate)
        try:
            d = json.loads(fixed)
            return d if isinstance(d, dict) else None
        except Exception:
            pass
    return None


# ---------- model path ----------

LOCALIZER_PROMPT = """\
You are a code-localization model. Given a task description, an optional
traceback, and a compact repo map, your job is to RANK where to look. You
must NOT propose patches or edits.

Output a single JSON object with this exact shape (no other text, no
markdown fences, no comments):

{{
  "suspected_files": [
    {{"path": "cheater/quality.py", "confidence": 0.9, "reason": "function `score_card` is called from the failing test"}}
  ],
  "suspected_symbols": [
    {{"name": "score_card", "file": "cheater/quality.py", "confidence": 0.85, "reason": "appears in the traceback"}}
  ],
  "search_queries": ["def score_card", "score_card("],
  "needed_context": ["cheater/quality.py", "cheater/retrieval.py"],
  "risk_notes": ["top hit is a test file — do not edit tests unless allowed"]
}}

Rules:
  - Keep suspected_files to <= 8 items.
  - Keep suspected_symbols to <= 8 items.
  - confidence is between 0.0 and 1.0.
  - reason is one short sentence.
  - If you don't know, return empty arrays.

TASK: {task}

TRACEBACK:
{traceback}

REPO MAP EXCERPT:
{repo_map_excerpt}
"""


def _model_chat(model_client: Any, prompt: str, max_tokens: int = 800) -> str:
    if model_client is None:
        raise ValueError("model_client is None")
    if hasattr(model_client, "chat"):
        return model_client.chat(
            [{"role": "user", "content": prompt}],
            max_tokens=max_tokens,
            temperature=0.1,
        )
    raise ValueError("model_client has no .chat() method")


def localize_with_model(
    model_client: Any,
    task: str,
    context_pack: Any = None,
    *,
    repo_map_excerpt: str = "",
    traceback: str = "",
) -> LocalizationResult:
    """Ask the model for a LocalizationResult. Falls back to deterministic on failure.

    `context_pack` is optional; if provided, we pull the repo_map provider
    from it instead of using the raw `repo_map_excerpt` arg.
    """
    excerpt = repo_map_excerpt
    if not excerpt and context_pack is not None:
        rm = context_pack.get("repo_map") if hasattr(context_pack, "get") else None
        if rm is not None:
            excerpt = rm.body
    if not excerpt:
        excerpt = "(no repo map provided)"
    tb = traceback or (context_pack.get("traceback").body if context_pack
                       and hasattr(context_pack, "get")
                       and context_pack.get("traceback") else "")
    if not isinstance(tb, str):
        tb = ""
    prompt = LOCALIZER_PROMPT.format(
        task=task or "(no task)", traceback=_clip(tb, 3000),
        repo_map_excerpt=_clip(excerpt, 4000),
    )
    # Try once
    try:
        text = _model_chat(model_client, prompt)
    except Exception:
        return deterministic_localize(task, tb or traceback)
    parsed = repair_localization_json(text)
    if parsed is not None:
        try:
            r = LocalizationResult.from_dict(parsed)
            r.source = "model"
            return r
        except Exception:
            pass
    # Repair attempt
    repaired = repair_localization_json(text)
    if repaired is not None:
        try:
            r = LocalizationResult.from_dict(repaired)
            r.source = "model-repaired"
            return r
        except Exception:
            pass
    # Fallback
    return deterministic_localize(task, tb or traceback)


# ---------- collect snippets ----------

def collect_localized_context(
    result: LocalizationResult,
    repo_root: str | Path,
    *,
    max_chars_per_file: int = MAX_CHARS_PER_FILE,
    max_files: int = MAX_FILES_CTX,
) -> dict[str, str]:
    """Load the source snippets for the suspected files."""
    out: dict[str, str] = {}
    root = Path(repo_root).resolve()
    for sf in result.suspected_files[:max_files]:
        try:
            p = (root / sf.path).resolve()
        except (OSError, ValueError):
            continue
        try:
            p.relative_to(root)
        except ValueError:
            continue
        if not p.is_file():
            out[sf.path] = "(file not found)"
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except OSError as e:
            out[sf.path] = f"(read error: {e})"
            continue
        out[sf.path] = _clip(text, max_chars_per_file)
    return out

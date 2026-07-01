"""Cheater repo map: AST-based, narrow, deterministic.

For Python repos initially. Walks the repo (skipping junk dirs and big files),
parses .py files with `ast`, and collects per-file:

  - path
  - imports (top-level only)
  - classes
  - functions
  - async functions
  - method names (best-effort from ClassDef.body)
  - signatures (best-effort, first decorators skipped)
  - docstrings (first line, capped at 160 chars)
  - top-level constants (cheap: top-level `NAME = literal` assigns)

Also detects tests (test_*.py / *_test.py / paths under tests/) and produces a
best-effort source <-> test mapping using:

  1. Filename similarity (test_foo.py -> foo.py)
  2. Import references (test imports X; suggest files that export X)
  3. Grep/ripgrep fallback (callers of test-touched symbols)

Public API:
  RepoFile                        -- one parsed file
  RepoMap                         -- the whole map
  build_repo_map(repo_root)       -- build from a directory
  load_repo_map(path)             -- load a saved map (JSON)
  save_repo_map(repo_map, out)    -- write JSON + markdown
  render_repo_map_markdown(map)   -- small, capped markdown
  select_relevant_map(map, q, ...) -- narrow the map to a query

The output is deliberately small and structured so the LLM never gets the
whole repo.
"""
from __future__ import annotations

import ast
import json
import os
import re
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Iterable


# Same hard-ignore list style as cheater.explorer, but kept local so repo_map
# does not need to import explorer (and so the two modules can evolve
# independently).
DEFAULT_IGNORED_DIRS: set[str] = {
    ".git", ".hg", ".svn",
    "__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache",
    "node_modules", "bower_components",
    "venv", ".venv", "env",
    "dist", "build", ".next", ".nuxt", ".cache", ".parcel-cache",
    "target",
    ".idea", ".vscode",
    "data/cards", "data/indexes", "data/raw", "data/eval_tasks",
    "_archive", "_swe_workspace",
    ".cheater", ".memory", ".smallcode", ".code-graph", ".agents",
}

MAX_FILE_BYTES = 256_000
MAX_FILES = 5_000
MAX_DOCSTRING_CHARS = 160
MAX_LINE_LEN = 1_000

TEST_FILE_RE = re.compile(r"(^|/)test_[A-Za-z0-9_]+\.py$|(^|/)[A-Za-z0-9_]+_test\.py$")
TEST_DIRS = ("tests/", "test/")


# ---------- data types ----------

@dataclass
class FunctionInfo:
    name: str
    line: int
    is_async: bool = False
    is_method: bool = False
    signature: str = ""           # best-effort, e.g. "def foo(self, x: int) -> bool"
    decorators: list[str] = field(default_factory=list)
    doc: str = ""                 # first line of docstring, truncated

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ClassInfo:
    name: str
    line: int
    bases: list[str] = field(default_factory=list)
    methods: list[str] = field(default_factory=list)
    doc: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ImportInfo:
    """A single top-level import (from X import Y) or (import X.Y)."""
    module: str            # e.g. "os" or "cheater.memory"
    names: list[str] = field(default_factory=list)  # imported names (for `from X import a, b`)
    alias: str = ""
    is_from: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ConstantInfo:
    """Cheap top-level constant."""
    name: str
    value_repr: str  # str() of the AST literal node, capped

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class RepoFile:
    path: str                 # repo-relative, forward slashes
    language: str = "python"
    parse_error: str = ""     # populated if ast.parse fails
    imports: list[ImportInfo] = field(default_factory=list)
    classes: list[ClassInfo] = field(default_factory=list)
    functions: list[FunctionInfo] = field(default_factory=list)
    constants: list[ConstantInfo] = field(default_factory=list)
    module_doc: str = ""
    line_count: int = 0
    is_test: bool = False

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        return d

    def symbol_names(self) -> list[str]:
        out: list[str] = []
        for c in self.classes:
            out.append(c.name)
            out.extend(c.methods)
        for f in self.functions:
            out.append(f.name)
        for c in self.constants:
            out.append(c.name)
        return out


@dataclass
class RepoMap:
    repo_root: str
    generated_at: float
    files: list[RepoFile] = field(default_factory=list)
    test_to_source: dict[str, list[str]] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "repo_root": self.repo_root,
            "generated_at": self.generated_at,
            "schema": "cheater.repo_map.v1",
            "files": [f.to_dict() for f in self.files],
            "test_to_source": self.test_to_source,
            "warnings": self.warnings,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "RepoMap":
        files: list[RepoFile] = []
        for fd in d.get("files", []) or []:
            imp = [ImportInfo(**i) for i in (fd.get("imports") or [])]
            cls_ = [ClassInfo(**c) for c in (fd.get("classes") or [])]
            funcs = [FunctionInfo(**f) for f in (fd.get("functions") or [])]
            consts = [ConstantInfo(**c) for c in (fd.get("constants") or [])]
            files.append(RepoFile(
                path=fd.get("path", ""),
                language=fd.get("language", "python"),
                parse_error=fd.get("parse_error", ""),
                imports=imp,
                classes=cls_,
                functions=funcs,
                constants=consts,
                module_doc=fd.get("module_doc", ""),
                line_count=int(fd.get("line_count", 0) or 0),
                is_test=bool(fd.get("is_test", False)),
            ))
        return cls(
            repo_root=d.get("repo_root", ""),
            generated_at=float(d.get("generated_at", 0.0) or 0.0),
            files=files,
            test_to_source=dict(d.get("test_to_source") or {}),
            warnings=list(d.get("warnings") or []),
        )

    def get(self, path: str) -> RepoFile | None:
        for f in self.files:
            if f.path == path:
                return f
        return None

    def all_test_files(self) -> list[RepoFile]:
        return [f for f in self.files if f.is_test]

    def all_source_files(self) -> list[RepoFile]:
        return [f for f in self.files if not f.is_test]


# ---------- internals ----------

def _is_ignored_dir(name: str) -> bool:
    return name in DEFAULT_IGNORED_DIRS or name.endswith(".egg-info")


def _is_test_path(rel: str) -> bool:
    rel = rel.replace("\\", "/")
    if TEST_FILE_RE.search(rel):
        return True
    for d in TEST_DIRS:
        if rel.startswith(d):
            return True
    return False


def _walk_python_files(repo_root: Path) -> Iterable[Path]:
    """Yield candidate .py files under repo_root, skipping ignored dirs."""
    for dirpath, dirnames, filenames in os.walk(repo_root):
        rel_dir = os.path.relpath(dirpath, repo_root).replace("\\", "/")
        pruned: list[str] = []
        for d in dirnames:
            if _is_ignored_dir(d):
                continue
            # Skip dot-prefixed dirs at the root
            if rel_dir == "." and d.startswith(".") and d not in (".",):
                continue
            pruned.append(d)
        dirnames[:] = pruned
        for f in filenames:
            if not f.endswith(".py"):
                continue
            full = Path(dirpath) / f
            try:
                if full.stat().st_size > MAX_FILE_BYTES:
                    continue
            except OSError:
                continue
            yield full


def _doc_first_line(node: ast.AST) -> str:
    doc = ast.get_docstring(node) or ""
    if not doc:
        return ""
    first = doc.strip().splitlines()[0] if doc.strip() else ""
    if len(first) > MAX_DOCSTRING_CHARS:
        first = first[:MAX_DOCSTRING_CHARS - 3] + "..."
    return first


def _signature_str(node: ast.FunctionDef | ast.AsyncFunctionDef) -> str:
    """Best-effort: skip decorators, render arguments roughly."""
    args = node.args
    parts: list[str] = []
    pos_args = list(args.posonlyargs) + list(args.args)
    defaults = list(args.defaults)
    pad = max(0, len(pos_args) - len(defaults))
    for i, a in enumerate(pos_args):
        s = a.arg
        ann = ast.unparse(a.annotation) if a.annotation else ""
        if ann:
            s += f": {ann}"
        if i >= pad:
            s += "=?"
        parts.append(s)
    if args.vararg:
        s = f"*{args.vararg.arg}"
        if args.vararg.annotation:
            s += f": {ast.unparse(args.vararg.annotation)}"
        parts.append(s)
    elif args.kwonlyargs:
        parts.append("*")
    for a in args.kwonlyargs:
        s = a.arg
        if a.annotation:
            s += f": {ast.unparse(a.annotation)}"
        parts.append(s)
    if args.kwarg:
        s = f"**{args.kwarg.arg}"
        if args.kwarg.annotation:
            s += f": {ast.unparse(args.kwarg.annotation)}"
        parts.append(s)
    sig = ", ".join(parts)
    if node.returns:
        sig = f"{sig} -> {ast.unparse(node.returns)}"
    return sig


def _decorator_strs(node: ast.FunctionDef | ast.AsyncFunctionDef) -> list[str]:
    out: list[str] = []
    for d in node.decorator_list:
        try:
            out.append(ast.unparse(d))
        except Exception:
            out.append("?")
    return out


def _const_value_repr(node: ast.AST) -> str:
    """Cheap constant repr. Falls back to 'object' for non-literals."""
    if isinstance(node, ast.Constant):
        v = node.value
        r = repr(v)
        if len(r) > 80:
            r = r[:77] + "..."
        return r
    # Don't try to evaluate expressions — too risky. Mark as expression.
    return "<expr>"


def _parse_one_file(path: Path, rel: str, source: str) -> RepoFile:
    rf = RepoFile(path=rel)
    rf.line_count = source.count("\n") + (0 if source.endswith("\n") else 1)
    rf.is_test = _is_test_path(rel)
    try:
        tree = ast.parse(source, filename=rel)
    except (SyntaxError, ValueError) as e:
        rf.parse_error = f"{type(e).__name__}: {e}"
        return rf
    rf.module_doc = _doc_first_line(tree)
    # Iterate top-level body
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            fname = node.name
            fi = FunctionInfo(
                name=fname,
                line=getattr(node, "lineno", 0) or 0,
                is_async=isinstance(node, ast.AsyncFunctionDef),
                is_method=False,
                signature=f"def {fname}({_signature_str(node)})" or f"def {fname}()",
                decorators=_decorator_strs(node),
                doc=_doc_first_line(node),
            )
            rf.functions.append(fi)
        elif isinstance(node, ast.ClassDef):
            methods: list[str] = []
            bases: list[str] = []
            for b in node.bases:
                try:
                    bases.append(ast.unparse(b))
                except Exception:
                    bases.append("?")
            for sub in node.body:
                if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    methods.append(sub.name)
            ci = ClassInfo(
                name=node.name,
                line=getattr(node, "lineno", 0) or 0,
                bases=bases,
                methods=methods,
                doc=_doc_first_line(node),
            )
            rf.classes.append(ci)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                rf.imports.append(ImportInfo(
                    module=alias.name, names=[], alias=alias.asname or "",
                    is_from=False,
                ))
        elif isinstance(node, ast.ImportFrom):
            mod = node.module or ""
            names = [a.name for a in node.names]
            rf.imports.append(ImportInfo(
                module=mod, names=names, alias="", is_from=True,
            ))
        elif isinstance(node, ast.Assign):
            # Top-level constant only if all targets are simple Names and
            # the value is a literal-ish expression.
            try:
                value_repr = _const_value_repr(node.value)
            except Exception:
                continue
            for t in node.targets:
                if isinstance(t, ast.Name) and value_repr != "<expr>":
                    rf.constants.append(ConstantInfo(name=t.id, value_repr=value_repr))
    return rf


def _filename_to_candidate(rel: str) -> list[str]:
    """For a test file path, propose candidate source paths."""
    name = Path(rel).name
    stem = Path(rel).stem
    candidates: list[str] = []
    # test_foo.py -> foo.py, src/test_foo.py -> src/foo.py
    if stem.startswith("test_"):
        base = stem[len("test_"):]
        if base:
            candidates.append(base + ".py")
    elif stem.endswith("_test"):
        base = stem[: -len("_test")]
        if base:
            candidates.append(base + ".py")
    # Drop test_ from the path: tests/test_x.py -> x.py
    parts = rel.split("/")
    for i, p in enumerate(parts):
        if p.startswith("test_") and p.endswith(".py"):
            rest = p[len("test_"):]
            new_parts = list(parts[:i]) + [rest] + parts[i+1:]
            candidates.append("/".join(new_parts))
    # Same directory sibling
    parent = str(Path(rel).parent).replace("\\", "/")
    if stem.startswith("test_"):
        base = stem[len("test_"):]
        if base and parent not in (".", ""):
            candidates.append(f"{parent}/{base}.py")
        elif base:
            candidates.append(f"{base}.py")
    return candidates


def _map_tests_to_sources(m: RepoMap) -> None:
    """Fill m.test_to_source.

    Strategy:
      1. Filename similarity (cheap)
      2. Import references: which source file exports an imported name?
    """
    source_paths = {f.path for f in m.all_source_files()}
    source_symbols: dict[str, list[str]] = {}
    for sf in m.all_source_files():
        for sym in sf.symbol_names():
            source_symbols.setdefault(sym, []).append(sf.path)

    for tf in m.all_test_files():
        candidates: list[str] = []
        # 1. filename similarity
        for c in _filename_to_candidate(tf.path):
            # Also try a few directory permutations
            for cand in (c, "cheater/" + c, "src/" + c):
                if cand in source_paths and cand not in candidates:
                    candidates.append(cand)
        # 2. import references
        for imp in tf.imports:
            # Look at the module's tail
            tail = imp.module.split(".")[-1] if imp.module else ""
            if tail and tail in source_symbols:
                for sp in source_symbols[tail]:
                    if sp not in candidates:
                        candidates.append(sp)
            for n in imp.names:
                if n in source_symbols:
                    for sp in source_symbols[n]:
                        if sp not in candidates:
                            candidates.append(sp)
        # Keep top 5
        m.test_to_source[tf.path] = candidates[:5]


# ---------- public API ----------

def build_repo_map(repo_root: str | Path) -> RepoMap:
    """Build a RepoMap from a directory. Never raises.

    On permission errors or parse failures, records warnings/errors and
    continues.
    """
    root = Path(repo_root).resolve()
    m = RepoMap(repo_root=str(root), generated_at=time.time())
    if not root.is_dir():
        m.warnings.append(f"repo_root is not a directory: {root}")
        return m
    n = 0
    for p in _walk_python_files(root):
        if n >= MAX_FILES:
            m.warnings.append(f"too many files (>{MAX_FILES}); results may be noisy")
            break
        try:
            rel = str(p.relative_to(root)).replace("\\", "/")
        except ValueError:
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except OSError as e:
            m.warnings.append(f"read error: {rel}: {e}")
            continue
        rf = _parse_one_file(p, rel, text)
        m.files.append(rf)
        n += 1
    _map_tests_to_sources(m)
    return m


def save_repo_map(m: RepoMap, out_dir: str | Path) -> dict[str, str]:
    """Write repo_map.json and repo_map.md under out_dir. Returns paths."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    json_path = out / "repo_map.json"
    md_path = out / "repo_map.md"
    json_path.write_text(json.dumps(m.to_dict(), indent=2, ensure_ascii=False),
                         encoding="utf-8")
    md_path.write_text(render_repo_map_markdown(m), encoding="utf-8")
    return {"json": str(json_path), "md": str(md_path)}


def load_repo_map(path: str | Path) -> RepoMap:
    """Load a saved RepoMap from JSON. Raises on bad shape."""
    p = Path(path)
    data = json.loads(p.read_text(encoding="utf-8"))
    return RepoMap.from_dict(data)


# ---------- rendering ----------

def render_repo_map_markdown(repo_map: RepoMap, max_tokens: int = 6000) -> str:
    """Render a compact markdown overview. Caps at ~max_tokens (very rough).

    Heuristic: 1 token ≈ 4 chars.
    """
    cap = max(1000, max_tokens * 4)
    lines: list[str] = []
    lines.append(f"# Cheater repo map")
    lines.append("")
    lines.append(f"repo_root: `{repo_map.repo_root}`")
    lines.append(f"files: {len(repo_map.files)}  tests: {len(repo_map.all_test_files())}  sources: {len(repo_map.all_source_files())}")
    if repo_map.warnings:
        lines.append("")
        lines.append("Warnings:")
        for w in repo_map.warnings:
            lines.append(f"  - {w}")
    lines.append("")
    # Module list
    lines.append("## Modules")
    for f in repo_map.files:
        bits = [f"`{f.path}`"]
        if f.is_test:
            bits.append("[test]")
        if f.parse_error:
            bits.append(f"[parse error: {f.parse_error[:40]}]")
        if f.module_doc:
            bits.append(f"— {f.module_doc[:80]}")
        lines.append("  - " + " ".join(bits))
    if len("\n".join(lines)) > cap:
        return _truncate(lines, cap)
    # Symbols
    lines.append("")
    lines.append("## Symbols")
    for f in repo_map.all_source_files():
        if not (f.classes or f.functions or f.constants):
            continue
        lines.append(f"")
        lines.append(f"### `{f.path}`")
        for c in f.classes:
            bases = f"({', '.join(c.bases)})" if c.bases else ""
            doc = f" — {c.doc}" if c.doc else ""
            lines.append(f"  class {c.name}{bases}:{doc}")
            for method in c.methods[:30]:
                lines.append(f"    .{method}()")
        for fn in f.functions:
            tag = "async " if fn.is_async else ""
            doc = f" — {fn.doc}" if fn.doc else ""
            sig = fn.signature or f"def {fn.name}()"
            lines.append(f"  {tag}{sig}  # L{fn.line}{doc}")
        for c in f.constants:
            lines.append(f"  {c.name} = {c.value_repr}")
    if len("\n".join(lines)) > cap:
        return _truncate(lines, cap)
    # Test map
    if repo_map.test_to_source:
        lines.append("")
        lines.append("## Test -> Source map")
        for tf, sources in repo_map.test_to_source.items():
            if not sources:
                lines.append(f"  - `{tf}` -> (no likely source)")
            else:
                lines.append(f"  - `{tf}` -> {', '.join(f'`{s}`' for s in sources)}")
    return _truncate(lines, cap)


def _truncate(lines: list[str], cap: int) -> str:
    text = "\n".join(lines)
    if len(text) <= cap:
        return text
    # Keep the head and a note
    keep = text[: cap - 80]
    return keep + "\n... [truncated, repo map too large]"


def select_relevant_map(
    m: RepoMap,
    query: str,
    traceback: str = "",
    top_k: int = 20,
) -> str:
    """Pick the files most relevant to the query/traceback and render them.

    Ranking (deterministic):
      - Traceback file paths are boosted strongly.
      - Filename / class / function / constant name matches are boosted.
      - Imports matching the query (module tail) get a small boost.
    """
    q_tokens = _tokenize(query + " " + traceback)
    STOP = {"py", "in", "to", "for", "of", "the", "a", "an", "and", "or", "with",
            "is", "on", "by", "from", "as", "be", "it", "this", "that"}
    q_set = {t for t in q_tokens if len(t) >= 2 and t not in STOP}
    tb_files = _extract_traceback_files(traceback)
    if not m.files:
        return "(empty repo map)"
    scored: list[tuple[float, RepoFile]] = []
    for f in m.files:
        s = 0.0
        path_lower = f.path.lower()
        name_lower = path_lower.rsplit("/", 1)[-1]  # e.g. "tools.py"
        stem_lower = name_lower.rsplit(".", 1)[0]   # e.g. "tools"
        # Strong boost for direct path-segment match
        for t in q_set:
            if t in path_lower.split("/"):
                s += 4.0
            elif t == stem_lower:
                s += 5.0  # exact filename match
            elif t in stem_lower:
                s += 3.0
            elif t in path_lower:
                s += 1.0
        if f.path in tb_files:
            s += 10.0
        # symbol matches (exact and substring; underscore-stripped)
        def _sym_keys(name: str) -> tuple[str, str]:
            low = name.lower()
            stripped = low.replace("_", "")
            return low, stripped
        sym_keys = [_sym_keys(sn) for sn in f.symbol_names()]
        for t in q_set:
            t_stripped = t.replace("_", "")
            for low, stripped in sym_keys:
                if t == low:
                    s += 4.0
                elif t in low or low in t:
                    s += 2.5
                elif t_stripped and (t_stripped == stripped or t_stripped in stripped or stripped in t_stripped):
                    s += 2.0
        # imports
        for imp in f.imports:
            for tok in (imp.module.split("."), imp.names):
                for t in q_set:
                    if any(t == x.lower() or t in x.lower() for x in tok):
                        s += 1.0
        if f.is_test:
            s *= 0.8  # slightly deprioritize tests unless explicitly asked
        if s > 0:
            scored.append((s, f))
    scored.sort(key=lambda x: x[0], reverse=True)
    if not scored:
        # No overlap — return a tiny list of small source files
        chosen = sorted(m.all_source_files(), key=lambda f: f.line_count)[:top_k]
    else:
        chosen = [f for _, f in scored[:top_k]]
    # Render the chosen files as a compact list
    lines: list[str] = []
    lines.append(f"# Relevant repo map (top {len(chosen)} files for query)")
    lines.append(f"query: {query[:120]}")
    if tb_files:
        lines.append(f"traceback files (boosted): {sorted(tb_files)}")
    for f in chosen:
        lines.append("")
        lines.append(f"## `{f.path}`  (L{f.line_count}){' [test]' if f.is_test else ''}")
        if f.parse_error:
            lines.append(f"  parse_error: {f.parse_error[:120]}")
        if f.module_doc:
            lines.append(f"  doc: {f.module_doc}")
        if f.imports:
            imps = []
            for imp in f.imports[:10]:
                if imp.is_from:
                    names = ", ".join(imp.names[:5])
                    imps.append(f"from {imp.module} import {names}")
                else:
                    imps.append(f"import {imp.module}")
            lines.append("  imports: " + "; ".join(imps))
        for c in f.classes:
            bases = f"({', '.join(c.bases)})" if c.bases else ""
            doc = f"  # {c.doc}" if c.doc else ""
            lines.append(f"  class {c.name}{bases}{doc}")
            for m in c.methods[:15]:
                lines.append(f"    .{m}()")
        for fn in f.functions[:40]:
            tag = "async " if fn.is_async else ""
            doc = f"  # {fn.doc}" if fn.doc else ""
            sig = fn.signature or f"def {fn.name}()"
            lines.append(f"  {tag}{sig}  # L{fn.line}{doc}")
        for c in f.constants[:10]:
            lines.append(f"  {c.name} = {c.value_repr}")
    return "\n".join(lines)


def _tokenize(text: str) -> list[str]:
    if not text:
        return []
    # Split on whitespace + punctuation; treat path-like segments as one.
    # Replace path separators with spaces so "cheater/tools.py" becomes two
    # tokens: "cheater" and "tools" (with "py" dropped via stopword below).
    cleaned = re.sub(r"[/\\.,:;!?()\[\]{}<>\"']", " ", text)
    return [t.lower() for t in re.findall(r"[A-Za-z_][A-Za-z0-9_]*|\d+", cleaned)
            if len(t) >= 2]


_TRACEBACK_FILE_RE = re.compile(r'File "([^"]+)", line \d+')


def _extract_traceback_files(traceback: str) -> set[str]:
    if not traceback:
        return set()
    out: set[str] = set()
    for m in _TRACEBACK_FILE_RE.finditer(traceback):
        out.add(m.group(1).replace("\\", "/"))
    return out

"""FastContext-style repo explorer for Cheater.

Given a user task, return focused repo context (file paths, symbols, line
ranges), NOT solve the task. Pure stdlib, no heavy deps.

Public API:
  explore(query, repo_root=...)            -> ExplorerResult (dict-like)
  format_explorer(result, text=True)       -> human-readable text
  save_explorer(result, path)              -> write JSON

Output keys:
  query, repo_root, languages, top_files, symbols, line_ranges,
  test_files, config_files, recent_files, warnings, scanned_files

Robust:
  - Skips large/binary files
  - Honors .gitignore
  - Has hard ignore list for junk dirs
  - Warns if repo is too large
"""
from __future__ import annotations

import os
import re
import subprocess
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Iterable

# Hard ignore list (in addition to .gitignore)
DEFAULT_IGNORED_DIRS: set[str] = {
    ".git", ".hg", ".svn",
    "__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache",
    "node_modules", "bower_components",
    "venv", ".venv", "env", ".env",
    "dist", "build", ".next", ".nuxt", ".cache", ".parcel-cache",
    "target",  # Rust
    ".idea", ".vscode",
    "data/cards", "data/indexes", "data/raw", "data/eval_tasks",
    "_archive", "_swe_workspace",
    ".cheater", ".memory", ".smallcode", ".code-graph", ".agents",
}

# File extensions we will index (text-like, code-like)
TEXT_EXTENSIONS: set[str] = {
    ".py", ".pyi",
    ".js", ".jsx", ".mjs", ".cjs",
    ".ts", ".tsx",
    ".rs",
    ".go",
    ".java", ".kt", ".scala",
    ".c", ".h", ".cpp", ".cc", ".cxx", ".hpp",
    ".rb",
    ".php",
    ".swift", ".m",
    ".sh", ".bash", ".zsh",
    ".html", ".css", ".scss", ".less",
    ".json", ".yaml", ".yml", ".toml",
    ".md", ".rst", ".txt",
    ".sql",
    ".xml",
}

# Language per extension (used for same-language boost)
EXT_LANGUAGE: dict[str, str] = {
    ".py": "python", ".pyi": "python",
    ".js": "javascript", ".jsx": "javascript",
    ".ts": "typescript", ".tsx": "typescript",
    ".rs": "rust",
    ".go": "go",
    ".java": "java", ".kt": "kotlin",
    ".c": "c", ".h": "c", ".cpp": "cpp",
    ".rb": "ruby",
    ".php": "php",
    ".sh": "shell", ".bash": "shell",
}

# Config files
CONFIG_FILES: set[str] = {
    "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt",
    "package.json", "tsconfig.json", "yarn.lock", "pnpm-lock.yaml",
    "Cargo.toml", "Cargo.lock",
    "pom.xml", "build.gradle", "build.gradle.kts",
    "go.mod", "go.sum",
    "Makefile", "CMakeLists.txt",
    "cheater.toml", ".cheater/config.toml",
}

# Test file patterns
TEST_PATTERNS: tuple[str, ...] = (
    "tests/", "test/", "spec/", "__tests__/",
    "test_", "_test.", ".test.", ".spec.", "Test.",
)

# Symbol patterns per language
PY_SYMBOL_RE = re.compile(r"^(?:def|class|async\s+def)\s+([A-Za-z_][A-Za-z0-9_]*)")
PY_IMPORT_RE = re.compile(r"^(?:from\s+([\w.]+)|import\s+([\w.]+))")
JS_SYMBOL_RE = re.compile(r"^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|"
                          r"^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)|"
                          r"^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*")
JS_IMPORT_RE = re.compile(r"^(?:import|export).*?from\s+['\"]([^'\"]+)['\"]")
RUST_SYMBOL_RE = re.compile(r"^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)|"
                            r"^(?:pub\s+)?struct\s+([A-Za-z_][\w]*)|"
                            r"^(?:pub\s+)?impl(?:<[^>]+>)?\s+([A-Za-z_][\w]*)|"
                            r"^(?:pub\s+)?mod\s+([A-Za-z_][\w]*)")
GO_SYMBOL_RE = re.compile(r"^func\s+(?:\([^)]+\)\s+)?([A-Za-z_][\w]*)")
JAVA_SYMBOL_RE = re.compile(r"^(?:public|private|protected)?\s*(?:static\s+)?"
                            r"(?:[A-Za-z<>?,\s]+)\s+([A-Za-z_][\w]*)\s*\(")

MAX_FILE_BYTES = 256_000  # skip files larger than this
MAX_FILES_SCAN = 20_000   # bail if more than this many files
MAX_LINE_LEN = 1000       # skip lines longer than this when scanning symbols
MAX_GIT_FILES = 200       # max recent git files to consider


@dataclass
class ExplorerResult:
    """Structured repo-context result."""
    query: str = ""
    repo_root: str = ""
    languages: list[str] = field(default_factory=list)
    top_files: list[dict[str, Any]] = field(default_factory=list)
    symbols: list[dict[str, Any]] = field(default_factory=list)
    line_ranges: list[dict[str, Any]] = field(default_factory=list)
    test_files: list[str] = field(default_factory=list)
    config_files: list[str] = field(default_factory=list)
    recent_files: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    scanned_files: int = 0
    scanned_bytes: int = 0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _read_gitignore(repo_root: Path) -> list[str]:
    """Read .gitignore patterns as raw strings (very simple glob matcher)."""
    p = repo_root / ".gitignore"
    if not p.is_file():
        return []
    patterns: list[str] = []
    try:
        for line in p.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            patterns.append(line)
    except OSError:
        pass
    return patterns


def _is_gitignored(rel: str, patterns: list[str]) -> bool:
    """Very simple gitignore matcher. Supports `*`, `**`, and directory patterns.

    Not 100% spec-compliant; catches the common cases.
    """
    if not patterns:
        return False
    parts = rel.replace("\\", "/").split("/")
    name = parts[-1]
    for pat in patterns:
        p = pat.rstrip("/")
        if not p:
            continue
        if p.startswith("**/"):
            tail = p[3:]
            if _glob_match(name, tail) or any(_glob_match("/".join(parts[i:]), tail) for i in range(len(parts))):
                return True
            continue
        if p.startswith("/"):
            if _glob_match(rel.lstrip("/"), p.lstrip("/")):
                return True
            continue
        if "/" in p:
            if _glob_match(rel, p):
                return True
            continue
        # Bare name: match against any path component
        if _glob_match(name, p):
            return True
    return False


def _glob_match(name: str, pattern: str) -> bool:
    """Translate glob to regex; * and ** supported."""
    i, j = 0, 0
    star_i = -1
    star_j = -1
    while i < len(name):
        if j < len(pattern) and pattern[j] == "*":
            star_i = i
            star_j = j
            j += 1
        elif j < len(pattern) and (pattern[j] == "?" or pattern[j] == name[i]):
            i += 1
            j += 1
        elif star_j != -1:
            j = star_j + 1
            i = star_i + 1
            star_i += 1
        else:
            return False
    while j < len(pattern) and pattern[j] == "*":
        j += 1
    return j == len(pattern)


def _walk_repo(
    repo_root: Path,
    ignored_dirs: set[str],
    gitignore_patterns: list[str],
) -> Iterable[Path]:
    """Yield candidate text files under repo_root."""
    for dirpath, dirnames, filenames in os.walk(repo_root):
        rel_dir = os.path.relpath(dirpath, repo_root).replace("\\", "/")
        # Prune ignored dirs in-place
        pruned: list[str] = []
        for d in dirnames:
            rel = d if rel_dir == "." else f"{rel_dir}/{d}"
            if d in ignored_dirs or _is_gitignored(rel + "/", gitignore_patterns):
                continue
            pruned.append(d)
        dirnames[:] = pruned

        for f in filenames:
            rel = f if rel_dir == "." else f"{rel_dir}/{f}"
            if _is_gitignored(rel, gitignore_patterns):
                continue
            ext = os.path.splitext(f)[1].lower()
            if ext not in TEXT_EXTENSIONS:
                continue
            full = Path(dirpath) / f
            try:
                if full.stat().st_size > MAX_FILE_BYTES:
                    continue
            except OSError:
                continue
            yield full


def _detect_language(ext: str) -> str | None:
    return EXT_LANGUAGE.get(ext.lower())


def _is_test_file(rel: str) -> bool:
    rel = rel.replace("\\", "/")
    for pat in TEST_PATTERNS:
        if pat in rel:
            return True
    return False


def _is_config_file(name: str) -> bool:
    return name in CONFIG_FILES


def _extract_symbols(path: Path, ext: str) -> list[dict[str, Any]]:
    """Extract top-level symbols from a file. Cheap regex-based."""
    symbols: list[dict[str, Any]] = []
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return symbols
    for i, line in enumerate(text.splitlines(), start=1):
        if len(line) > MAX_LINE_LEN:
            continue
        kind = None
        name: str | None = None
        if ext in (".py", ".pyi"):
            m = PY_SYMBOL_RE.match(line)
            if m:
                kind = "class" if line.lstrip().startswith("class") else "function"
                name = m.group(1)
        elif ext in (".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"):
            m = JS_SYMBOL_RE.match(line)
            if m:
                name = next((g for g in m.groups() if g), None)
                kind = "function" if "function" in line else "class" if "class" in line else "const"
        elif ext == ".rs":
            m = RUST_SYMBOL_RE.match(line)
            if m:
                name = next((g for g in m.groups() if g), None)
                kind = "fn" if line.lstrip().startswith(("fn", "async", "pub")) else None
                if "struct" in line:
                    kind = "struct"
                elif "impl" in line:
                    kind = "impl"
                elif "mod" in line:
                    kind = "mod"
        elif ext == ".go":
            m = GO_SYMBOL_RE.match(line)
            if m:
                name = m.group(1)
                kind = "function"
        if name:
            symbols.append({"name": name, "file": str(path), "line": i, "kind": kind})
            if len(symbols) >= 50:
                break
    return symbols


def _git_recent(repo_root: Path) -> list[str]:
    """Get recently changed files via git. Returns [] if not a git repo."""
    try:
        out = subprocess.run(
            ["git", "diff", "--name-only", "HEAD"],
            cwd=str(repo_root),
            capture_output=True,
            text=True,
            timeout=5,
        )
        if out.returncode == 0:
            return [l.strip() for l in out.stdout.splitlines() if l.strip()][:MAX_GIT_FILES]
    except (OSError, subprocess.TimeoutExpired, FileNotFoundError):
        pass
    return []


def _tokenize(query: str) -> list[str]:
    return [t.lower() for t in re.findall(r"[A-Za-z_][A-Za-z0-9_]*|\d+", query) if len(t) >= 2]


def _score_file(rel: str, symbols: list[dict[str, Any]], query_terms: list[str]) -> tuple[float, list[str]]:
    """Score a file by query-term overlap with name and symbols. Returns (score, why)."""
    if not query_terms:
        return 0.0, []
    rel_lower = rel.lower()
    sym_names = {s["name"].lower() for s in symbols}
    why: list[str] = []
    score = 0.0
    # File-name match
    for t in query_terms:
        if t in rel_lower:
            score += 1.0
            why.append(f"path contains '{t}'")
    # Symbol-name match
    for t in query_terms:
        if t in sym_names:
            score += 2.0
            why.append(f"symbol '{t}'")
    return score, why


def _score_file_contents(path: Path, query_terms: list[str]) -> tuple[float, list[tuple[int, int, list[str]]]]:
    """Score a file by line-term overlap. Returns (score, [(line_no_start, line_no_end, terms)])"""
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return 0.0, []
    lines = text.splitlines()
    line_hits: list[tuple[int, list[str]]] = []
    total_hits = 0
    for i, line in enumerate(lines, start=1):
        if len(line) > MAX_LINE_LEN:
            continue
        ll = line.lower()
        hits = [t for t in query_terms if t in ll]
        if hits:
            line_hits.append((i, hits))
            total_hits += len(hits)
    if not line_hits:
        return 0.0, []
    # Coalesce adjacent line hits into ranges
    ranges: list[tuple[int, int, list[str]]] = []
    cur_start, cur_end, cur_hits = line_hits[0][0], line_hits[0][0], set(line_hits[0][1])
    for ln, hits in line_hits[1:]:
        if ln - cur_end <= 2:
            cur_end = ln
            cur_hits.update(hits)
        else:
            ranges.append((cur_start, cur_end, sorted(cur_hits)))
            cur_start, cur_end, cur_hits = ln, ln, set(hits)
    ranges.append((cur_start, cur_end, sorted(cur_hits)))
    return float(total_hits), ranges


def explore(query: str, repo_root: str | Path | None = None, max_files: int = 500) -> ExplorerResult:
    """Explore a repo for context relevant to query.

    Returns an ExplorerResult. Never raises. Falls back to empty result on errors.
    """
    result = ExplorerResult(query=query)
    root = Path(repo_root) if repo_root else Path.cwd()
    if not root.is_dir():
        result.warnings.append(f"repo_root is not a directory: {root}")
        return result
    result.repo_root = str(root.resolve())

    ignored = set(DEFAULT_IGNORED_DIRS)
    gitignore_patterns = _read_gitignore(root)

    # Walk the repo (cheap phase: collect candidates, extract symbols)
    files: list[tuple[Path, str, list[dict[str, Any]]]] = []
    seen: set[str] = set()
    total_bytes = 0
    for path in _walk_repo(root, ignored, gitignore_patterns):
        rel = str(path.relative_to(root)).replace("\\", "/")
        if rel in seen:
            continue
        seen.add(rel)
        ext = path.suffix.lower()
        if ext not in TEXT_EXTENSIONS:
            continue
        # Track
        try:
            sz = path.stat().st_size
            total_bytes += sz
        except OSError:
            continue
        # Track metadata
        if _is_config_file(path.name):
            result.config_files.append(rel)
        if _is_test_file(rel):
            result.test_files.append(rel)
        # Extract symbols (cheap)
        symbols = _extract_symbols(path, ext)
        files.append((path, rel, symbols))
        result.scanned_files += 1
        if result.scanned_files >= MAX_FILES_SCAN:
            result.warnings.append(f"repo too large (>{MAX_FILES_SCAN} files); results may be noisy")
            break

    result.scanned_bytes = total_bytes

    # Git recent
    result.recent_files = _git_recent(root)

    # Score
    query_terms = _tokenize(query)
    if not query_terms:
        result.warnings.append("query has no extractable terms")
    scored: list[tuple[float, Path, str, list[dict[str, Any]], list[str]]] = []
    for path, rel, symbols in files:
        s, why = _score_file(rel, symbols, query_terms)
        if s > 0:
            scored.append((s, path, rel, symbols, why))
    # Take top max_files by name/symbol match, then add content score
    scored.sort(key=lambda x: x[0], reverse=True)
    top = scored[:max_files]
    # Add content scoring for top candidates
    final: list[tuple[float, str, list[dict[str, Any]], list[str]]] = []
    for s, path, rel, symbols, why in top:
        cs, ranges = _score_file_contents(path, query_terms)
        total = s + 0.5 * cs
        for r in ranges[:3]:
            result.line_ranges.append({
                "file": rel, "start": r[0], "end": r[1], "matched_terms": r[2],
            })
        for sym in symbols:
            if any(t in sym["name"].lower() for t in query_terms):
                result.symbols.append(sym)
        if total > 0:
            final.append((total, rel, symbols, why))
    final.sort(key=lambda x: x[0], reverse=True)

    # Build top_files (cap at 20)
    for s, rel, symbols, why in final[:20]:
        lang = _detect_language(Path(rel).suffix)
        result.top_files.append({
            "path": rel,
            "score": round(s, 3),
            "why": why[:5],
            "language": lang,
            "symbol_count": len(symbols),
        })

    # Languages from top files
    langs: list[str] = []
    for tf in result.top_files:
        if tf.get("language") and tf["language"] not in langs:
            langs.append(tf["language"])
    # Fallback: scan all files
    if not langs:
        for path, rel, _ in files[:50]:
            lang = _detect_language(path.suffix)
            if lang and lang not in langs:
                langs.append(lang)
                if len(langs) >= 5:
                    break
    result.languages = langs

    # Limit line_ranges and symbols
    result.line_ranges = result.line_ranges[:30]
    result.symbols = result.symbols[:50]

    return result


def format_explorer(result: ExplorerResult, text: bool = True) -> str:
    """Format the explorer result for human reading."""
    lines: list[str] = []
    lines.append("=== Repo Explorer (FastContext) ===")
    lines.append(f"query:    {result.query}")
    lines.append(f"repo:     {result.repo_root}")
    if result.languages:
        lines.append(f"languages: {', '.join(result.languages)}")
    lines.append(f"scanned:  {result.scanned_files} files, {result.scanned_bytes // 1024} KB")
    if result.warnings:
        for w in result.warnings:
            lines.append(f"WARNING:  {w}")
    lines.append("")
    if result.top_files:
        lines.append(f"Top files ({len(result.top_files)}):")
        for tf in result.top_files[:10]:
            why = ", ".join(tf.get("why") or []) or "no explicit match"
            lines.append(f"  - {tf['path']}  (score {tf['score']}, {why})")
    if result.symbols:
        lines.append("")
        lines.append(f"Symbols ({len(result.symbols)}):")
        for s in result.symbols[:20]:
            lines.append(f"  {s['kind']:8s}  {s['name']}    {s['file']}:{s['line']}")
    if result.line_ranges:
        lines.append("")
        lines.append(f"Line ranges ({len(result.line_ranges)}):")
        for r in result.line_ranges[:15]:
            terms = ", ".join(r.get("matched_terms") or [])
            lines.append(f"  {r['file']}:{r['start']}-{r['end']}  ({terms})")
    if result.test_files:
        lines.append("")
        lines.append(f"Test files ({len(result.test_files)}):")
        for t in result.test_files[:10]:
            lines.append(f"  - {t}")
    if result.config_files:
        lines.append("")
        lines.append(f"Config files ({len(result.config_files)}):")
        for c in result.config_files[:10]:
            lines.append(f"  - {c}")
    if result.recent_files:
        lines.append("")
        lines.append(f"Recent git changes ({len(result.recent_files)}):")
        for r in result.recent_files[:10]:
            lines.append(f"  - {r}")
    if not result.top_files and not result.symbols and not result.line_ranges:
        lines.append("No matches found in repo.")
    return "\n".join(lines)


def save_explorer(result: ExplorerResult, path: str | Path) -> None:
    """Save the explorer result to a JSON file."""
    import json
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(result.to_dict(), indent=2, ensure_ascii=False), encoding="utf-8")

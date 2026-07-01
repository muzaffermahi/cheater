"""Safe patch engine for Cheater.

Design:
  - Pure stdlib
  - Replaces exact text in a file (find unique substring, replace with new)
  - Previews as unified diff before applying
  - Snapshots to git if the repo is a git repo, else writes .bak file
  - Forbidden paths: .git, data/cards, data/indexes, _archive, venv, caches
  - Tracks applied patches so they can be undone in reverse order

Public API:
  PatchProposal(path, old, new, description="")    -- a proposed edit
  preview(proposal) -> str                          -- unified diff
  apply(proposal) -> str (snapshot_id)              -- apply, returns id for undo
  undo(snapshot_id) -> bool                         -- undo by id (LIFO)
  reject(proposal) -> None                         -- discard
  list_snapshots() -> list[dict]                   -- show what can be undone

Limitations: exact-text replace only. No multi-file refactors, no AST.
For complex edits, use multiple replace_exact() calls.
"""
from __future__ import annotations

import difflib
import json
import os
import re
import shutil
import subprocess
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

FORBIDDEN_PATH_PATTERNS: tuple[str, ...] = (
    r"(?:^|/)\.git(?:/|$)",
    r"(?:^|/)data/cards(?:/|$)",
    r"(?:^|/)data/indexes(?:/|$)",
    r"(?:^|/)data/raw(?:/|$)",
    r"(?:^|/)data/eval_tasks(?:/|$)",
    r"(?:^|/)_archive(?:/|$)",
    r"(?:^|/)_swe_workspace(?:/|$)",
    r"(?:^|/)venv(?:/|$)",
    r"(?:^|/)\.venv(?:/|$)",
    r"(?:^|/)__pycache__(?:/|$)",
    r"(?:^|/)node_modules(?:/|$)",
    r"(?:^|/)dist(?:/|$)",
    r"(?:^|/)build(?:/|$)",
    r"(?:^|/)target(?:/|$)",
    r"(?:^|/)\.cheater/sessions(?:/|$)",  # don't edit session files
)


@dataclass
class PatchProposal:
    """A proposed file edit."""
    path: str
    old: str
    new: str
    description: str = ""
    allow_forbidden: bool = False  # if True, skip the forbidden-path check
    proposal_id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])


@dataclass
class Snapshot:
    """A snapshot of a file before a patch was applied. Used for undo."""
    snapshot_id: str
    path: str
    backup_path: str | None  # None if using git
    git_stash_ref: str | None
    created_at: float
    proposal_id: str


_SNAPSHOTS: list[Snapshot] = []


def is_forbidden(path: str) -> bool:
    """Check if a path matches a forbidden pattern."""
    p = path.replace("\\", "/")
    for pat in FORBIDDEN_PATH_PATTERNS:
        if re.search(pat, p):
            return True
    return False


def _validate_path(path: str, allow_forbidden: bool = False) -> None:
    if not allow_forbidden and is_forbidden(path):
        raise PermissionError(
            f"Refusing to edit forbidden path: {path}\n"
            f"  (forbidden dirs: .git, data/cards, data/indexes, _archive, venv, caches, sessions)"
        )
    p = Path(path)
    if p.exists() and p.is_dir():
        raise PermissionError(f"Refusing to edit a directory: {path}")


def _is_git_repo(path: str) -> bool:
    cur = Path(path).resolve()
    for parent in [cur, *cur.parents]:
        if (parent / ".git").exists():
            return True
        if parent == parent.parent:  # root
            break
    return False


def _git_snapshot(repo_root: Path, path: str) -> str | None:
    """Try to use git stash to snapshot a file. Returns ref or None."""
    try:
        # Use git stash push with a path-specific include
        # This is best-effort: if it fails, we fall back to .bak
        out = subprocess.run(
            ["git", "stash", "push", "--include-untracked", "-m", f"cheater-snapshot-{time.time()}", "--", path],
            cwd=str(repo_root),
            capture_output=True,
            text=True,
            timeout=10,
        )
        if out.returncode == 0 and "No local changes" not in out.stdout:
            return "stash"
    except (OSError, subprocess.TimeoutExpired, FileNotFoundError):
        pass
    return None


def _git_pop(repo_root: Path) -> bool:
    """Try to pop the most recent stash. Returns True on success."""
    try:
        out = subprocess.run(
            ["git", "stash", "pop"],
            cwd=str(repo_root),
            capture_output=True,
            text=True,
            timeout=10,
        )
        return out.returncode == 0
    except (OSError, subprocess.TimeoutExpired, FileNotFoundError):
        return False


def _find_repo_root(path: str) -> Path | None:
    cur = Path(path).resolve()
    for parent in [cur, *cur.parents]:
        if (parent / ".git").exists():
            return parent
        if parent == parent.parent:
            break
    return None


def preview(proposal: PatchProposal, context: int = 3) -> str:
    """Render a unified-diff preview of the proposed edit."""
    _validate_path(proposal.path, proposal.allow_forbidden)
    p = Path(proposal.path)
    if not p.is_file():
        # New file
        return f"--- (new file) {proposal.path}\n+++ {proposal.path}\n{_preview_new_file(proposal)}"
    try:
        text = p.read_text(encoding="utf-8", errors="ignore")
    except OSError as e:
        return f"ERROR reading {proposal.path}: {e}"
    occurrences = text.count(proposal.old)
    if occurrences == 0:
        return f"ERROR: old text not found in {proposal.path}\n--- old text ---\n{proposal.old[:200]}\n--- end ---"
    if occurrences > 1:
        return f"ERROR: old text matches {occurrences} times in {proposal.path}; must be unique."
    new_text = text.replace(proposal.old, proposal.new, 1)
    diff = difflib.unified_diff(
        text.splitlines(keepends=True),
        new_text.splitlines(keepends=True),
        fromfile=f"a/{proposal.path}",
        tofile=f"b/{proposal.path}",
        n=context,
    )
    out = "".join(diff)
    if not out:
        out = "(no textual change)"
    return out


def _preview_new_file(proposal: PatchProposal) -> str:
    """Preview the contents of a new file."""
    lines = proposal.new.splitlines(keepends=True)
    return "".join(f"+{l}" for l in lines)


def apply(proposal: PatchProposal) -> str:
    """Apply a patch. Returns a snapshot_id for undo.

    Workflow:
      1. Validate path
      2. If file exists, find old text (must be unique)
      3. Snapshot (git stash or .bak)
      4. Write new content
      5. Record snapshot for undo
    """
    _validate_path(proposal.path, proposal.allow_forbidden)
    p = Path(proposal.path)
    if not p.is_file():
        # New file
        p.parent.mkdir(parents=True, exist_ok=True)
        snap = Snapshot(
            snapshot_id=uuid.uuid4().hex[:12],
            path=proposal.path,
            backup_path=None,
            git_stash_ref=None,
            created_at=time.time(),
            proposal_id=proposal.proposal_id,
        )
        _SNAPSHOTS.append(snap)
        p.write_text(proposal.new, encoding="utf-8")
        return snap.snapshot_id
    text = p.read_text(encoding="utf-8")
    occurrences = text.count(proposal.old)
    if occurrences == 0:
        raise ValueError(f"old text not found in {proposal.path}")
    if occurrences > 1:
        raise ValueError(
            f"old text matches {occurrences} times in {proposal.path}; "
            f"provide more context to make it unique."
        )
    # Snapshot
    snap_id = uuid.uuid4().hex[:12]
    backup_path: str | None = None
    git_stash_ref: str | None = None
    repo_root = _find_repo_root(proposal.path)
    if repo_root and _is_git_repo(proposal.path):
        # Use git stash
        stash_ref = _git_snapshot(repo_root, proposal.path)
        if stash_ref is not None:
            git_stash_ref = stash_ref
    if git_stash_ref is None:
        # Use .bak file
        backup = p.with_suffix(p.suffix + ".bak")
        i = 1
        while backup.exists():
            backup = p.with_suffix(p.suffix + f".bak{i}")
            i += 1
        shutil.copy2(p, backup)
        backup_path = str(backup)
    snap = Snapshot(
        snapshot_id=snap_id,
        path=proposal.path,
        backup_path=backup_path,
        git_stash_ref=git_stash_ref,
        created_at=time.time(),
        proposal_id=proposal.proposal_id,
    )
    _SNAPSHOTS.append(snap)
    # Apply
    new_text = text.replace(proposal.old, proposal.new, 1)
    p.write_text(new_text, encoding="utf-8")
    return snap_id


def undo(snapshot_id: str | None = None) -> bool:
    """Undo the most recent patch (or by id). Returns True on success.

    Note: If git stash was used, we try to pop the most recent stash (only
    works if the user hasn't created other stashes in between). Otherwise
    we restore from the .bak file.
    """
    if not _SNAPSHOTS:
        return False
    if snapshot_id is None:
        snap = _SNAPSHOTS.pop()
    else:
        for i, s in enumerate(_SNAPSHOTS):
            if s.snapshot_id == snapshot_id:
                snap = _SNAPSHOTS.pop(i)
                break
        else:
            return False
    p = Path(snap.path)
    if snap.backup_path:
        try:
            shutil.copy2(snap.backup_path, p)
            try:
                os.unlink(snap.backup_path)
            except OSError:
                pass
            return True
        except OSError:
            return False
    if snap.git_stash_ref:
        repo_root = _find_repo_root(snap.path)
        if repo_root and _git_pop(repo_root):
            return True
    return False


def reject(proposal: PatchProposal) -> None:
    """Discard a proposal (no-op; for symmetry)."""
    return None


def list_snapshots() -> list[dict[str, Any]]:
    """List pending snapshots (most recent first)."""
    return [
        {
            "snapshot_id": s.snapshot_id,
            "path": s.path,
            "created_at": s.created_at,
            "proposal_id": s.proposal_id,
            "via": "git" if s.git_stash_ref else ("bak" if s.backup_path else "new"),
        }
        for s in reversed(_SNAPSHOTS)
    ]


def make_replace(path: str, old: str, new: str, description: str = "", allow_forbidden: bool = False) -> PatchProposal:
    """Convenience: build a replace proposal."""
    return PatchProposal(path=path, old=old, new=new, description=description, allow_forbidden=allow_forbidden)


def make_create(path: str, content: str, description: str = "", allow_forbidden: bool = False) -> PatchProposal:
    """Convenience: build a create-file proposal (old is empty)."""
    return PatchProposal(path=path, old="", new=content, description=description, allow_forbidden=allow_forbidden)


def save_snapshots(path: str | Path) -> None:
    """Persist snapshots to disk so they survive across CLI invocations.

    Stored in .cheater/patch_snapshots.json in the project root.
    """
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    data = [
        {
            "snapshot_id": s.snapshot_id,
            "path": s.path,
            "backup_path": s.backup_path,
            "git_stash_ref": s.git_stash_ref,
            "created_at": s.created_at,
            "proposal_id": s.proposal_id,
        }
        for s in _SNAPSHOTS
    ]
    p.write_text(json.dumps(data, indent=2), encoding="utf-8")


def load_snapshots(path: str | Path) -> None:
    """Load snapshots from a JSON file. Replaces the in-memory list."""
    p = Path(path)
    if not p.is_file():
        return
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    _SNAPSHOTS.clear()
    for item in data:
        _SNAPSHOTS.append(Snapshot(
            snapshot_id=item["snapshot_id"],
            path=item["path"],
            backup_path=item.get("backup_path"),
            git_stash_ref=item.get("git_stash_ref"),
            created_at=item.get("created_at", 0.0),
            proposal_id=item.get("proposal_id", ""),
        ))

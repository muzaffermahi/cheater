"""Canonical v1 memory-card schema, validation, and normalization.

A memory card is the unit Cheater retrieves to help a coding agent fix a bug.
Cards are validated before indexing: unusable cards are retained (so failures
are visible) but excluded from the default index.

Field rules:
  - id                 : str, required, stable/deterministic when possible.
  - source             : str, required (where the card came from).
  - repo               : str | None
  - language           : str | None
  - bug_type           : str | None
  - symptom            : str, required for usable=true
  - root_cause         : str | None
  - fix_pattern        : str, required for usable=true
  - failed_approaches  : list[str]
  - key_files          : list[str]
  - test_signal        : str | None
  - search_keywords    : list[str]
  - embedding_text     : str, required for usable=true (the retrieval text)
  - usable             : bool, required
  - schema_version     : str, auto-set to "v1"
  - quality_score      : float 0-1, set by quality.py after build
  - quality_reasons    : list[str], reasons that lowered quality_score
  - quality_tier       : str, "high"|"medium"|"low"|"junk"

Optional fields missing from input are normalized to None or [].
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Any, Iterator

from cheater import SCHEMA_VERSION

REQUIRED_FIELDS: tuple[str, ...] = ("id", "source", "usable")
USABLE_REQUIRED_FIELDS: tuple[str, ...] = ("symptom", "fix_pattern", "embedding_text")

STRING_FIELDS: tuple[str, ...] = (
    "id", "source", "repo", "language", "bug_type", "symptom",
    "root_cause", "fix_pattern", "test_signal", "embedding_text",
)
LIST_FIELDS: tuple[str, ...] = (
    "failed_approaches", "key_files", "search_keywords", "quality_reasons",
)
FLOAT_FIELDS: tuple[str, ...] = ("quality_score",)

ALL_FIELDS: tuple[str, ...] = REQUIRED_FIELDS + USABLE_REQUIRED_FIELDS + (
    "repo", "language", "bug_type", "root_cause",
    "failed_approaches", "key_files", "test_signal",
    "search_keywords",
)


def stable_id(*parts: str) -> str:
    """Deterministic id from stable source parts (e.g. source::instance_id)."""
    raw = "::".join(str(p) for p in parts if p is not None)
    return "card_" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


@dataclass
class ValidationResult:
    ok: bool
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def _as_str(value: Any) -> str | None:
    if value is None:
        return None
    s = str(value).strip()
    return s or None


def _as_str_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        items = [value]
    elif isinstance(value, (list, tuple)):
        items = list(value)
    else:
        items = [value]
    return [str(i).strip() for i in items if str(i).strip()]


def _as_float(value: Any, default: float | None = None) -> float | None:
    if value is None:
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def normalize_card(raw: dict[str, Any]) -> dict[str, Any]:
    """Coerce a raw record into canonical v1 shape with normalized nulls/[]."""
    card: dict[str, Any] = {}
    for f in STRING_FIELDS:
        card[f] = _as_str(raw.get(f))
    for f in LIST_FIELDS:
        card[f] = _as_str_list(raw.get(f))
    for f in FLOAT_FIELDS:
        card[f] = _as_float(raw.get(f))
    usable = raw.get("usable")
    if isinstance(usable, str):
        usable = usable.strip().lower() in ("true", "1", "yes", "y")
    card["usable"] = bool(usable) if usable is not None else False
    card["schema_version"] = SCHEMA_VERSION
    return card


def validate_card(card: dict[str, Any]) -> ValidationResult:
    """Validate a normalized card. Returns ok=False with field-level errors."""
    errors: list[str] = []
    warnings: list[str] = []

    for f in REQUIRED_FIELDS:
        if f not in card or card[f] is None or card[f] == "":
            errors.append(f"missing required field: {f}")

    if isinstance(card.get("id"), str) and not card["id"].strip():
        errors.append("id must be a non-empty string")

    usable = card.get("usable")
    if not isinstance(usable, bool):
        errors.append("usable must be a boolean")
    elif usable:
        for f in USABLE_REQUIRED_FIELDS:
            val = card.get(f)
            if not (isinstance(val, str) and val.strip()):
                errors.append(f"usable=true requires non-empty: {f}")

    if not isinstance(card.get("search_keywords"), list):
        errors.append("search_keywords must be a list")

    if card.get("embedding_text") is not None:
        if not isinstance(card["embedding_text"], str):
            errors.append("embedding_text must be a string")

    return ValidationResult(ok=not errors, errors=errors, warnings=warnings)


def normalize_and_validate(raw: dict[str, Any]) -> tuple[dict[str, Any], ValidationResult]:
    card = normalize_card(raw)
    return card, validate_card(card)


def iter_valid_cards(cards: list[dict[str, Any]]) -> Iterator[dict[str, Any]]:
    """Yield only usable=true cards from a list of normalized cards."""
    for c in cards:
        if c.get("usable") is True:
            yield c

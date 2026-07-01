from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field, asdict
from datetime import datetime
from typing import Any


def sha256_digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def json_dumps_stable(value: Any) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, default=str)


def compute_provenance_hash(record: dict[str, Any]) -> str:
    stable = json_dumps_stable(record)
    return sha256_digest(stable)


@dataclass
class NormalizedRecord:
    normalized_id: str
    source_dataset: str
    source_split: str
    source_row_index: int
    instance_id: str
    repo: str
    language: str = ""
    base_commit: str = ""
    created_at: str = ""
    problem_statement: str = ""
    issue_url: str = ""
    pr_url: str = ""
    commit_url: str = ""
    patch: str = ""
    test_patch: str = ""
    fail_to_pass: list[str] = field(default_factory=list)
    pass_to_pass: list[str] = field(default_factory=list)
    changed_files: list[str] = field(default_factory=list)
    install_config: dict[str, Any] = field(default_factory=dict)
    environment_info: dict[str, Any] = field(default_factory=dict)
    dataset_license: str = "Unknown"
    repo_license: str = "Unknown"
    raw_metadata: dict[str, Any] = field(default_factory=dict)
    raw_sha256: str = ""
    patch_sha256: str = ""
    test_patch_sha256: str = ""
    contamination_scope: str = "unknown"
    quarantine_status: str = "none"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> NormalizedRecord:
        return cls(**{k: v for k, v in value.items() if k in cls.__dataclass_fields__})


@dataclass
class MemoryCard:
    card_id: str
    source_normalized_id: str
    source_dataset: str
    source_instance_id: str
    source_repo: str
    source_base_commit: str = ""
    source_issue_url: str = ""
    source_pr_url: str = ""
    source_commit_url: str = ""
    source_license_dataset: str = "Unknown"
    source_license_repo: str = "Unknown"
    task_type: str = "unknown"
    language: str = ""
    title: str = ""
    symptoms: str = ""
    error_signature: str = ""
    root_cause_summary: str = ""
    fix_pattern_summary: str = ""
    changed_files: list[str] = field(default_factory=list)
    changed_symbols: list[str] = field(default_factory=list)
    failing_tests: list[str] = field(default_factory=list)
    passing_tests_guard: list[str] = field(default_factory=list)
    card_text_bm25: str = ""
    card_text_dense: str = ""
    patch: str = ""
    test_patch: str = ""
    provenance_hash: str = ""
    contamination_scope: str = "unknown"
    human_review_status: str = "unreviewed"
    quality_score: float = 0.0
    created_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> MemoryCard:
        return cls(**{k: v for k, v in value.items() if k in cls.__dataclass_fields__})


def make_normalized_id(
    source_dataset: str, instance_id: str, source_row_index: int
) -> str:
    raw = f"{source_dataset}::{instance_id}::{source_row_index}"
    return f"norm_{sha256_digest(raw)[:16]}"


def make_card_id(normalized_id: str) -> str:
    return f"card_{sha256_digest(normalized_id)[:16]}"

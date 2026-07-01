from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from .memory_schema import (
    NormalizedRecord,
    make_normalized_id,
    sha256_digest,
)


def _safe_str(value: Any, default: str = "") -> str:
    if value is None:
        return default
    return str(value)


def _safe_list(value: Any, default: list[str] | None = None) -> list[str]:
    if value is None:
        return default or []
    if isinstance(value, list):
        return [str(item) for item in value]
    return [str(value)]


def _safe_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    return {}


def _extract_repo_from_instance_id(instance_id: str) -> str:
    parts = instance_id.split("-")
    if len(parts) >= 2:
        return "-".join(parts[:-1])
    return instance_id


def _extract_language_from_repo(repo: str) -> str:
    repo_lower = repo.lower()
    lang_map = {
        "python": "Python",
        "django": "Python",
        "flask": "Python",
        "astropy": "Python",
        "sympy": "Python",
        "pytest": "Python",
        "numpy": "Python",
        "scikit": "Python",
        "pandas": "Python",
        "geopandas": "Python",
        "dvc": "Python",
        "matplotlib": "Python",
    }
    for key, lang in lang_map.items():
        if key in repo_lower:
            return lang
    python_keywords = [
        "py",
        "pypi",
        "flake8",
        "pylint",
        "mypy",
        "black",
        "isort",
        "pip",
        "tox",
        "cookiecutter",
        "dask",
        "ray",
        "celery",
    ]
    for kw in python_keywords:
        if kw in repo_lower:
            return "Python"
    javascript_keywords = ["js", "node", "npm", "react", "angular", "vue", "typescript"]
    for kw in javascript_keywords:
        if kw in repo_lower:
            return "JavaScript"
    java_keywords = ["java", "maven", "gradle", "spring"]
    for kw in java_keywords:
        if kw in repo_lower:
            return "Java"
    rust_keywords = ["rust", "cargo", "crates"]
    for kw in rust_keywords:
        if kw in repo_lower:
            return "Rust"
    return "Unknown"


def _compute_patch_sha256(patch: str) -> str:
    return sha256_digest(patch) if patch.strip() else ""


class DatasetNormalizer:
    dataset_id: str = ""

    def normalize(self, row: dict[str, Any], row_index: int) -> NormalizedRecord | None:
        raise NotImplementedError


class SweRenchNormalizer(DatasetNormalizer):
    dataset_id = "nebius/SWE-rebench"

    def normalize(self, row: dict[str, Any], row_index: int) -> NormalizedRecord | None:
        instance_id = _safe_str(row.get("instance_id"))
        if not instance_id:
            return None
        repo = _safe_str(row.get("repo")) or _extract_repo_from_instance_id(instance_id)
        patch = _safe_str(row.get("patch"))
        test_patch = _safe_str(row.get("test_patch"))
        raw = dict(row)
        normalized_id = make_normalized_id(self.dataset_id, instance_id, row_index)
        fail_to_pass = _safe_list(row.get("FAIL_TO_PASS"))
        pass_to_pass = _safe_list(row.get("PASS_TO_PASS"))
        problem = _safe_str(row.get("problem_statement") or row.get("issue") or "")
        raw["source_normalizer"] = self.dataset_id
        record = NormalizedRecord(
            normalized_id=normalized_id,
            source_dataset=self.dataset_id,
            source_split=_safe_str(row.get("split", "train")),
            source_row_index=row_index,
            instance_id=instance_id,
            repo=repo,
            language=_safe_str(row.get("language"))
            or _extract_language_from_repo(repo),
            base_commit=_safe_str(row.get("base_commit")),
            created_at=_safe_str(row.get("created_at")),
            problem_statement=problem,
            issue_url=_safe_str(row.get("issue_url")),
            pr_url=_safe_str(row.get("pr_url")),
            commit_url=_safe_str(row.get("commit_url")),
            patch=patch,
            test_patch=test_patch,
            fail_to_pass=fail_to_pass,
            pass_to_pass=pass_to_pass,
            changed_files=_safe_list(row.get("changed_files")),
            install_config=_safe_dict(row.get("install_config")),
            environment_info=_safe_dict(row.get("environment_info")),
            dataset_license=_safe_str(row.get("dataset_license", "MIT")),
            repo_license=_safe_str(row.get("repo_license", "Unknown")),
            raw_metadata=raw,
            raw_sha256=sha256_digest(json.dumps(raw, sort_keys=True, default=str)),
            patch_sha256=_compute_patch_sha256(patch),
            test_patch_sha256=_compute_patch_sha256(test_patch),
            contamination_scope=_safe_str(
                row.get("contamination_scope", "swe_bench_derived")
            ),
        )
        return record


class SweRenchV2Normalizer(SweRenchNormalizer):
    dataset_id = "nebius/SWE-rebench-V2"


class SweRenchV2PRsNormalizer(SweRenchNormalizer):
    dataset_id = "nebius/SWE-rebench-V2-PRs"


class MultiSweBenchNormalizer(DatasetNormalizer):
    dataset_id = "ByteDance-Seed/Multi-SWE-bench"

    def normalize(self, row: dict[str, Any], row_index: int) -> NormalizedRecord | None:
        instance_id = _safe_str(row.get("instance_id"))
        if not instance_id:
            return None
        repo = _safe_str(row.get("repo"))
        patch = _safe_str(row.get("patch"))
        test_patch = _safe_str(row.get("test_patch"))
        raw = dict(row)
        normalized_id = make_normalized_id(self.dataset_id, instance_id, row_index)
        fail_to_pass = _safe_list(row.get("FAIL_TO_PASS"))
        pass_to_pass = _safe_list(row.get("PASS_TO_PASS"))
        problem = _safe_str(row.get("problem_statement") or row.get("issue") or "")
        raw["source_normalizer"] = self.dataset_id
        record = NormalizedRecord(
            normalized_id=normalized_id,
            source_dataset=self.dataset_id,
            source_split=_safe_str(row.get("split", "train")),
            source_row_index=row_index,
            instance_id=instance_id,
            repo=repo,
            language=_safe_str(row.get("language"))
            or _safe_str(row.get("programming_language"))
            or _extract_language_from_repo(repo),
            base_commit=_safe_str(row.get("base_commit")),
            created_at=_safe_str(row.get("created_at")),
            problem_statement=problem,
            issue_url=_safe_str(row.get("issue_url")),
            pr_url=_safe_str(row.get("pr_url")),
            commit_url=_safe_str(row.get("commit_url")),
            patch=patch,
            test_patch=test_patch,
            fail_to_pass=fail_to_pass,
            pass_to_pass=pass_to_pass,
            changed_files=_safe_list(row.get("changed_files")),
            install_config=_safe_dict(row.get("install_config")),
            environment_info=_safe_dict(row.get("environment_info")),
            dataset_license=_safe_str(row.get("dataset_license", "Apache-2.0")),
            repo_license=_safe_str(row.get("repo_license", "Unknown")),
            raw_metadata=raw,
            raw_sha256=sha256_digest(json.dumps(raw, sort_keys=True, default=str)),
            patch_sha256=_compute_patch_sha256(patch),
            test_patch_sha256=_compute_patch_sha256(test_patch),
            contamination_scope=_safe_str(
                row.get("contamination_scope", "multi_lang_swe_bench_derived")
            ),
        )
        return record


class MuLocBenchNormalizer(DatasetNormalizer):
    dataset_id = "somethingone/MULocBench"

    def normalize(self, row: dict[str, Any], row_index: int) -> NormalizedRecord | None:
        instance_id = _safe_str(
            row.get("instance_id") or row.get("id") or f"row_{row_index}"
        )
        repo = _safe_str(row.get("repo"))
        patch = _safe_str(row.get("patch") or "")
        test_patch = _safe_str(row.get("test_patch") or "")
        raw = dict(row)
        normalized_id = make_normalized_id(self.dataset_id, instance_id, row_index)
        fail_to_pass = _safe_list(row.get("FAIL_TO_PASS"))
        pass_to_pass = _safe_list(row.get("PASS_TO_PASS"))
        problem = _safe_str(
            row.get("problem_statement") or row.get("bug_description") or ""
        )
        raw["source_normalizer"] = self.dataset_id
        record = NormalizedRecord(
            normalized_id=normalized_id,
            source_dataset=self.dataset_id,
            source_split=_safe_str(row.get("split", "train")),
            source_row_index=row_index,
            instance_id=instance_id,
            repo=repo,
            language=_safe_str(row.get("language"))
            or _extract_language_from_repo(repo),
            base_commit=_safe_str(row.get("base_commit")),
            created_at=_safe_str(row.get("created_at")),
            problem_statement=problem,
            issue_url=_safe_str(row.get("issue_url")),
            pr_url=_safe_str(row.get("pr_url")),
            commit_url=_safe_str(row.get("commit_url")),
            patch=patch,
            test_patch=test_patch,
            fail_to_pass=fail_to_pass,
            pass_to_pass=pass_to_pass,
            changed_files=_safe_list(row.get("changed_files")),
            install_config=_safe_dict(row.get("install_config")),
            environment_info=_safe_dict(row.get("environment_info")),
            dataset_license=_safe_str(row.get("dataset_license", "Unknown")),
            repo_license=_safe_str(row.get("repo_license", "Unknown")),
            raw_metadata=raw,
            raw_sha256=sha256_digest(json.dumps(raw, sort_keys=True, default=str)),
            patch_sha256=_compute_patch_sha256(patch),
            test_patch_sha256=_compute_patch_sha256(test_patch),
            contamination_scope=_safe_str(
                row.get("contamination_scope", "bug_localization")
            ),
        )
        return record


class BenchHoldoutNormalizer(DatasetNormalizer):
    dataset_id = "princeton-nlp/SWE-bench"

    def normalize(self, row: dict[str, Any], row_index: int) -> NormalizedRecord | None:
        return None


class BenchVerifiedHoldoutNormalizer(DatasetNormalizer):
    dataset_id = "princeton-nlp/SWE-bench_Verified"

    def normalize(self, row: dict[str, Any], row_index: int) -> NormalizedRecord | None:
        return None


NORMALIZER_REGISTRY: dict[str, type[DatasetNormalizer]] = {
    "nebius/SWE-rebench": SweRenchNormalizer,
    "nebius/SWE-rebench-V2": SweRenchV2Normalizer,
    "nebius/SWE-rebench-V2-PRs": SweRenchV2PRsNormalizer,
    "ByteDance-Seed/Multi-SWE-bench": MultiSweBenchNormalizer,
    "somethingone/MULocBench": MuLocBenchNormalizer,
    "princeton-nlp/SWE-bench": BenchHoldoutNormalizer,
    "princeton-nlp/SWE-bench_Verified": BenchVerifiedHoldoutNormalizer,
}


def get_normalizer(dataset_id: str) -> DatasetNormalizer:
    cls = NORMALIZER_REGISTRY.get(dataset_id)
    if cls is None:
        raise ValueError(
            f"No normalizer registered for dataset: {dataset_id}. "
            f"Available: {', '.join(sorted(NORMALIZER_REGISTRY))}"
        )
    return cls()

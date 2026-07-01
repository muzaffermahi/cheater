from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class DatasetDef:
    dataset_id: str
    hf_name: str
    role: str
    default_split: str
    license: str
    contamination_scope: str
    priority: int
    enabled_by_default: bool
    quarantined: bool = False
    notes: str = ""

    @classmethod
    def from_value(cls, value: dict[str, Any]) -> DatasetDef:
        return cls(
            dataset_id=str(value.get("dataset_id", "")),
            hf_name=str(value.get("hf_name", "")),
            role=str(value.get("role", "memory_source")),
            default_split=str(value.get("default_split", "train")),
            license=str(value.get("license", "Unknown")),
            contamination_scope=str(value.get("contamination_scope", "unknown")),
            priority=int(value.get("priority", 99)),
            enabled_by_default=bool(value.get("enabled_by_default", False)),
            quarantined=bool(value.get("quarantined", False)),
            notes=str(value.get("notes", "")),
        )


@dataclass
class DatasetRegistry:
    datasets: dict[str, DatasetDef] = field(default_factory=dict)

    @classmethod
    def load(cls, path: str | Path) -> DatasetRegistry:
        p = Path(path).expanduser().resolve()
        raw = json.loads(p.read_text(encoding="utf-8"))
        entries = raw.get("datasets", [])
        datasets: dict[str, DatasetDef] = {}
        for entry in entries:
            ds = DatasetDef.from_value(entry)
            datasets[ds.dataset_id] = ds
        return cls(datasets=datasets)

    def get(self, dataset_id: str) -> DatasetDef | None:
        return self.datasets.get(dataset_id)

    def by_role(self, role: str) -> list[DatasetDef]:
        return [ds for ds in self.datasets.values() if ds.role == role]

    def enabled_sources(self) -> list[DatasetDef]:
        return [
            ds
            for ds in self.datasets.values()
            if ds.enabled_by_default and not ds.quarantined
        ]

    def quarantined(self) -> list[DatasetDef]:
        return [ds for ds in self.datasets.values() if ds.quarantined]

    def holdout_ids(self) -> set[str]:
        return {
            ds.dataset_id
            for ds in self.datasets.values()
            if ds.role == "benchmark_holdout"
        }

    def all_ids(self) -> list[str]:
        return sorted(self.datasets)

    def resolve_ids(
        self,
        requested: list[str] | None = None,
        *,
        all_enabled: bool = False,
        include_quarantined: bool = False,
    ) -> list[DatasetDef]:
        if all_enabled:
            selected = self.enabled_sources()
        elif requested:
            selected = []
            for dataset_id in requested:
                ds = self.get(dataset_id)
                if ds is None:
                    raise ValueError(
                        f"Unknown dataset: {dataset_id}. "
                        f"Available: {', '.join(self.all_ids())}"
                    )
                if ds.quarantined and not include_quarantined:
                    raise ValueError(
                        f"Dataset {dataset_id} is quarantined (benchmark holdout). "
                        "Use --include-quarantined to override."
                    )
                selected.append(ds)
        else:
            selected = []
        return selected

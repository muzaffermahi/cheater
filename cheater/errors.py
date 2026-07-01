"""Shared errors and extension-point base classes.

These are *interfaces only*. Concrete adapters (static analysis, fuzzing,
tree-sitter, large-scale mining, etc.) are future roadmap items and are
NOT implemented here.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Iterator


class CardError(ValueError):
    """Raised for malformed memory cards (JSON, schema, duplicates)."""


class CardSource(ABC):
    """Extension point: a stream of raw records that can become memory cards.

    Implementations may wrap HuggingFace datasets, GitHub issue miners,
    local trajectory dumps, etc. Implementations must stream (yield) and
    must not materialize the full dataset into memory.
    """

    @abstractmethod
    def iter_records(self) -> Iterator[dict[str, Any]]:
        raise NotImplementedError

    @property
    def name(self) -> str:
        return self.__class__.__name__


class IndexBackend(ABC):
    """Extension point: a retrievable index over validated memory cards."""

    @abstractmethod
    def search(self, query: str, top_k: int = 5) -> list[tuple[float, dict[str, Any]]]:
        raise NotImplementedError


class RetrievalBackend(ABC):
    """Extension point: ranking/filtering strategy over an index."""

    @abstractmethod
    def retrieve(self, query: str, top_k: int = 5) -> list[tuple[float, dict[str, Any]]]:
        raise NotImplementedError


class AnalyzerAdapter(ABC):
    """Extension point: future static/dynamic analysis adapters
    (CodeQL, Joern, fuzzing, tree-sitter). Not implemented in this pass."""

    @abstractmethod
    def analyze(self, target: Any) -> dict[str, Any]:
        raise NotImplementedError


class BenchmarkRunner(ABC):
    """Extension point: future agent-helpfulness runners."""

    @abstractmethod
    def run(self, cases: list[dict[str, Any]]) -> dict[str, Any]:
        raise NotImplementedError

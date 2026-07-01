"""Cheater: a Pi-based coding agent distribution.

The public ``cheater`` command is a thin launcher that opens Pi with Cheater's
extension, prompt, skills, slash commands, and theme preloaded. Historical
Python modules remain importable as legacy internals, but they are no longer
the product entry point.
"""

from __future__ import annotations

__version__ = "0.7.0"

SCHEMA_VERSION = "v1"

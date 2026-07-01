"""Local smoke test for SWE-bench Verified astropy__astropy-12907.

The historical checkout cannot be imported directly on this Windows machine because it
requires compiled extension modules. This script imports a compatible installed Astropy
runtime, then loads the exact separability implementation from the prepared checkout under
the ``astropy.modeling`` package namespace. It validates the pure-Python behavior at issue;
it is not a substitute for the official SWE-bench evaluator.
"""

from __future__ import annotations

import argparse
import importlib.util
from pathlib import Path

import numpy as np
from astropy.modeling import models


def load_separable(source: Path):
    source = source.resolve(strict=True)
    spec = importlib.util.spec_from_file_location(
        "astropy.modeling._swebench_separable_12907", source
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load separability module: {source}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "source",
        nargs="?",
        default="astropy/modeling/separable.py",
        help="Path to separable.py in the prepared checkout.",
    )
    args = parser.parse_args()
    separable = load_separable(Path(args.source))

    linear_pair = models.Linear1D(10) & models.Linear1D(5)
    nested = models.Pix2Sky_TAN() & linear_pair
    flat = models.Pix2Sky_TAN() & models.Linear1D(10) & models.Linear1D(5)
    expected = np.array(
        [
            [True, True, False, False],
            [True, True, False, False],
            [False, False, True, False],
            [False, False, False, True],
        ]
    )

    np.testing.assert_array_equal(separable.separability_matrix(flat), expected)
    np.testing.assert_array_equal(separable.separability_matrix(nested), expected)
    print("astropy__astropy-12907 smoke test passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

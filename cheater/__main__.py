"""Cheater console entry point.

Cheater is now solely a Pi wrapper/distribution. Running ``python -m cheater``
or the ``cheater`` console script delegates to the Pi-based launcher.
"""

from __future__ import annotations

import sys
from typing import Sequence

from cheater.pi_launcher import main as launch_pi


def main(argv: Sequence[str] | None = None) -> int:
    return launch_pi(argv)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

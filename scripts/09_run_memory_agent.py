"""Legacy placeholder.

The old memory-agent runner has been retired. Cheater now launches Pi directly
with Cheater resources preloaded:

    cheater
"""

from __future__ import annotations


def main() -> int:
    print("This legacy script is retired. Run: cheater")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())

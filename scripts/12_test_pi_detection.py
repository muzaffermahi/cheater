"""Check the current Cheater Pi wrapper command."""

from __future__ import annotations

from cheater.pi_launcher import main


if __name__ == "__main__":
    raise SystemExit(main(["--doctor"]))

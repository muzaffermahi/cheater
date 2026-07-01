"""audit-cards CLI command."""

from __future__ import annotations

import argparse
import json
import sys

from cheater.audit import audit_files, format_report


def run(args: argparse.Namespace) -> int:
    reports = audit_files(args.cards, with_quality=getattr(args, "quality", False))
    any_fail = False
    for report in reports:
        if not report["passes"]:
            any_fail = True
        if args.json:
            print(json.dumps(report, ensure_ascii=False, indent=2))
        else:
            sys.stderr.write(format_report(report, with_quality=getattr(args, "quality", False)))

    if any_fail and not args.lenient:
        if not args.json:
            sys.stderr.write("Validation FAILED. Use --lenient to exit 0 anyway.\n")
        return 1
    if not args.json:
        sys.stderr.write("All audited files passed validation.\n")
    return 0

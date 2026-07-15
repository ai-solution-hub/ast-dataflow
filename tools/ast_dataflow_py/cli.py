#!/usr/bin/env python3
"""CLI for the Python-corpus column-lineage queries.

Mirrors the TS ast-dataflow CLI envelope so agents can consume both sides
with one mental model:

    python3 tools/ast_dataflow_py/cli.py column-reads \
        --table source_documents --column id [--exclude-tests] [--limit N] [--pretty]

Output: one QueryResponse JSON object on stdout —
{query, args, results[], truncated, totalEstimated?, durationMs, sqlglot}.
Exit 0 on success (including structured errors); exit 2 on malformed args.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

# Support direct-script invocation (`python3 tools/ast_dataflow_py/cli.py`),
# where sys.path[0] is the script dir, not the repo root.
_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from tools.ast_dataflow_py.column_uses import (  # noqa: E402
    HAVE_SQLGLOT,
    scan_tree,
)

DEFAULT_LIMIT = 200
# Python lives under scripts/ in this repo; supabase/migrations SQL files are
# a candidate for a future extension (they are .sql, not .py).
DEFAULT_SCAN_DIRS = ["scripts"]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ast-dataflow-py")
    parser.add_argument(
        "query",
        choices=["column-reads", "column-writes"],
        help="Query to run over the Python corpus",
    )
    parser.add_argument("--table", required=True)
    parser.add_argument("--column", required=True)
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    parser.add_argument("--exclude-tests", action="store_true")
    parser.add_argument("--pretty", action="store_true")
    parser.add_argument(
        "--root",
        default=".",
        help="Repo root to scan from (default: cwd)",
    )
    parser.add_argument(
        "--scan-dir",
        action="append",
        dest="scan_dirs",
        help="Directory (repo-relative) to scan; repeatable. Default: scripts",
    )
    args = parser.parse_args(argv)

    if args.limit < 1:
        print(
            f"Invalid --limit value: {args.limit}. Expected a positive integer.",
            file=sys.stderr,
        )
        return 2
    if not args.table.strip() or not args.column.strip():
        print("--table and --column must be non-empty.", file=sys.stderr)
        return 2

    started = time.monotonic()
    root = Path(args.root).resolve()
    scan_dirs = args.scan_dirs or DEFAULT_SCAN_DIRS

    rows = []
    total = 0
    for row in scan_tree(
        root,
        scan_dirs,
        args.table,
        args.column,
        args.query,
        exclude_tests=args.exclude_tests,
    ):
        total += 1
        if len(rows) < args.limit:
            rows.append(row.to_json())

    response = {
        "query": args.query,
        "args": {
            "table": args.table,
            "column": args.column,
            "limit": args.limit,
            **({"excludeTests": True} if args.exclude_tests else {}),
        },
        "results": rows,
        "truncated": total > len(rows),
        **({"totalEstimated": total} if total > len(rows) else {}),
        "durationMs": int((time.monotonic() - started) * 1000),
        # Callers should treat regex-fallback runs as lower-fidelity: without
        # sqlglot, SQL hits are reported at 'indirect' confidence only.
        "sqlglot": HAVE_SQLGLOT,
    }
    print(json.dumps(response, indent=2 if args.pretty else None))
    return 0


if __name__ == "__main__":
    sys.exit(main())

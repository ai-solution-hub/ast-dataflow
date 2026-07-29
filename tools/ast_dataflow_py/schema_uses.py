"""Bulk column-evidence sweep — the evidence-sidecar producer.

One corpus walk emitting EVERY (table, column, direction) evidence row the
three detectors can attribute — no --table/--column filter. The output is
the v1 evidence-sidecar contract consumed by the TS side's
``schema-coverage --evidence``, closing its "the Python pipeline" blind spot
(id-377 {377.4}); the same envelope serves the initiative-12 census, whose
wiring rule requires Python + declarative evidence next to TS query chains.

Detector deltas vs the per-column queries in ``column_uses``:

- SQL rows REQUIRE sqlglot: with no target column to regex for, the
  fallback cannot enumerate columns, so a sqlglot-less run contributes no
  SQL rows and says so (envelope ``sqlglot: false`` + a caveat count of
  skipped SQL sites).
- Multi-table statements attribute every named column to EVERY table in the
  statement (parity with the per-column queries' membership checks) at
  ``indirect`` confidence instead of ``exact`` — single-table statements
  keep ``exact``.
- ``.rpc()`` payloads are SKIPPED (they are table-blind; attributing
  ``p_*`` params to a guessed table would be fabricated evidence) and
  reported as a caveat count.
- Dynamic supabase-py write payloads emit a table-scoped ``*`` write row at
  ``indirect`` (smoke, mirroring the declarative dynamic-payload rule).

Direction: read rows come from SELECT statements / select() / filters;
write rows from INSERT/UPDATE/DELETE/MERGE statements, write-method
payloads, and the declarative surface. A column named in a write
statement's WHERE/RETURNING still counts as a write-side mention, matching
``column_uses`` (the statement writes the table; the column participates).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import ast

from tools.ast_dataflow_py.column_uses import (
    HAVE_SQLGLOT,
    READ_VERBS,
    SQL_EXEC_METHODS,
    SUPABASE_FILTER_METHODS,
    SUPABASE_WRITE_METHODS,
    WRITE_VERBS,
    _extract_sql_literal,
    collect_module_str_consts,
    _select_tokens,
    _supabase_chain,
    iter_corpus_files,
)
from tools.ast_dataflow_py.declarative_writes import (
    DeclarativeIndex,
    collect_source,
    resolve_uses,
)

Direction = Literal["read", "write"]
Confidence = Literal["exact", "wildcard", "indirect"]

SIDECAR_SCHEMA_VERSION = 1
SIDECAR_SOURCE = "ast-dataflow-py"


@dataclass
class EvidenceRow:
    table: str
    column: str  # "*" = table-scoped (wildcard read / dynamic write)
    direction: Direction
    confidence: Confidence
    method: str
    file: str
    line: int
    source: Literal["sql", "supabase-py", "declarative"]

    def to_json(self) -> dict[str, object]:
        return {
            "table": self.table,
            "column": self.column,
            "direction": self.direction,
            "confidence": self.confidence,
            "method": self.method,
            "file": self.file,
            "line": self.line,
            "source": self.source,
        }


@dataclass
class SweepCaveats:
    """Loud-failure channels — nothing skipped silently."""

    sql_sites_skipped_no_sqlglot: int = 0
    sql_sites_unparsed: int = 0
    sql_sites_unresolved_dynamic: int = 0
    sql_function_source_sites: int = 0
    rpc_payload_sites_skipped: int = 0
    unattributable_declare_row_sites: list[dict[str, object]] = field(
        default_factory=list
    )

    def to_json(self) -> dict[str, object]:
        return {
            "sqlSitesSkippedNoSqlglot": self.sql_sites_skipped_no_sqlglot,
            "sqlSitesUnparsed": self.sql_sites_unparsed,
            "sqlSitesUnresolvedDynamic": self.sql_sites_unresolved_dynamic,
            "sqlFunctionSourceSites": self.sql_function_source_sites,
            "rpcPayloadSitesSkipped": self.rpc_payload_sites_skipped,
            "unattributableDeclareRowSites": self.unattributable_declare_row_sites,
        }


def _literal_dict_key_names(node: ast.expr) -> tuple[list[str], bool]:
    """(literal string keys, has_dynamic) for a dict expression."""
    if not isinstance(node, ast.Dict):
        return ([], True)
    keys: list[str] = []
    dynamic = False
    for key in node.keys:
        if key is None:
            dynamic = True
        elif isinstance(key, ast.Constant) and isinstance(key.value, str):
            keys.append(key.value)
        else:
            dynamic = True
    return (keys, dynamic)


def _sql_statement_rows(
    sql: str, dynamic: bool, caveats: SweepCaveats
) -> list[tuple[str, str, Direction, Confidence, str]]:
    """(table, column|*, direction, confidence, verb) hits for one SQL text."""
    import sqlglot  # local: callers guard on HAVE_SQLGLOT
    import sqlglot.expressions as sqlglot_exp

    hits: list[tuple[str, str, Direction, Confidence, str]] = []
    try:
        statements = sqlglot.parse(sql, read="postgres")
    except Exception:
        caveats.sql_sites_unparsed += 1
        return []
    for stmt in statements:
        if stmt is None:
            continue
        verb = stmt.key.lower()
        if verb in READ_VERBS:
            direction: Direction = "read"
        elif verb in WRITE_VERBS:
            direction = "write"
        else:
            continue
        # Function-valued FROM sources (stored-proc calls like
        # `SELECT ... FROM public.resolve_or_mint_source_identity(...)`)
        # surface as nameless Table nodes — that is the pg_proc surface,
        # not a physical table; skip loudly.
        all_tables = {t.name for t in stmt.find_all(sqlglot_exp.Table)}
        tables = {t for t in all_tables if t.strip()}
        if len(tables) < len(all_tables):
            caveats.sql_function_source_sites += 1
        if not tables:
            continue
        columns = {c.name for c in stmt.find_all(sqlglot_exp.Column)}
        if isinstance(stmt, sqlglot_exp.Insert):
            schema = stmt.this
            if isinstance(schema, sqlglot_exp.Schema):
                columns.update(
                    ident.name
                    for ident in schema.expressions
                    if isinstance(ident, (sqlglot_exp.Identifier, sqlglot_exp.Column))
                )
        # Multi-table statements over-attribute by construction — downgrade.
        base_conf: Confidence = "exact" if len(tables) == 1 else "indirect"
        confidence: Confidence = "indirect" if dynamic else base_conf
        for table in tables:
            for column in columns:
                hits.append((table, column, direction, confidence, verb))
            if direction == "read" and stmt.find(sqlglot_exp.Star) is not None:
                hits.append((table, "*", "read", "wildcard", verb))
    return hits


def _supabase_chain_rows(
    chain: list[tuple[str, ast.Call]],
    rel_path: str,
    caveats: SweepCaveats,
) -> list[EvidenceRow]:
    rows: list[EvidenceRow] = []
    methods = {m for m, _ in chain}

    if "rpc" in methods:
        rpc_call = next(c for m, c in chain if m == "rpc")
        if len(rpc_call.args) >= 2:
            caveats.rpc_payload_sites_skipped += 1
        return []

    from_entry = next((c for m, c in chain if m in {"from_", "table"}), None)
    if from_entry is None or not from_entry.args:
        return []
    table_arg = from_entry.args[0]
    if not (isinstance(table_arg, ast.Constant) and isinstance(table_arg.value, str)):
        return []
    table = table_arg.value

    for method, call in chain:
        if method in SUPABASE_WRITE_METHODS:
            if not call.args:
                continue
            payload = call.args[0]
            elements = payload.elts if isinstance(payload, ast.List) else [payload]
            all_keys: set[str] = set()
            any_dynamic = False
            for element in elements:
                keys, dynamic = _literal_dict_key_names(element)
                all_keys.update(keys)
                any_dynamic = any_dynamic or dynamic
            for key in sorted(all_keys):
                rows.append(
                    EvidenceRow(
                        table=table,
                        column=key,
                        direction="write",
                        confidence="exact",
                        method=method,
                        file=rel_path,
                        line=call.lineno,
                        source="supabase-py",
                    )
                )
            if any_dynamic:
                rows.append(
                    EvidenceRow(
                        table=table,
                        column="*",
                        direction="write",
                        confidence="indirect",
                        method=method,
                        file=rel_path,
                        line=call.lineno,
                        source="supabase-py",
                    )
                )
        elif method == "select":
            if not call.args:
                continue
            select_arg = call.args[0]
            if not (
                isinstance(select_arg, ast.Constant)
                and isinstance(select_arg.value, str)
            ):
                continue
            if select_arg.value == "*":
                rows.append(
                    EvidenceRow(
                        table=table,
                        column="*",
                        direction="read",
                        confidence="wildcard",
                        method="select",
                        file=rel_path,
                        line=call.lineno,
                        source="supabase-py",
                    )
                )
            else:
                for token in _select_tokens(select_arg.value):
                    rows.append(
                        EvidenceRow(
                            table=table,
                            column=token,
                            direction="read",
                            confidence="exact",
                            method="select",
                            file=rel_path,
                            line=call.lineno,
                            source="supabase-py",
                        )
                    )
        elif method in SUPABASE_FILTER_METHODS:
            if not call.args:
                continue
            if method == "match":
                keys, _ = _literal_dict_key_names(call.args[0])
                columns = keys
            elif isinstance(call.args[0], ast.Constant) and isinstance(
                call.args[0].value, str
            ):
                columns = [call.args[0].value]
            else:
                continue
            for column in columns:
                rows.append(
                    EvidenceRow(
                        table=table,
                        column=column,
                        direction="read",
                        confidence="exact",
                        method="filter" if method != "order" else "order",
                        file=rel_path,
                        line=call.lineno,
                        source="supabase-py",
                    )
                )
    return rows


def scan_schema_uses(
    root: Path, scan_dirs: list[str], exclude_tests: bool = False
) -> tuple[list[EvidenceRow], SweepCaveats]:
    """Sweep the corpus; all attributable evidence rows + caveats."""
    rows: list[EvidenceRow] = []
    caveats = SweepCaveats()
    corpus_index = DeclarativeIndex()

    for rel_path, source in iter_corpus_files(root, scan_dirs, exclude_tests):
        try:
            tree = ast.parse(source)
        except SyntaxError:
            continue
        module_consts = collect_module_str_consts(tree)

        file_index = collect_source(source, rel_path)
        if file_index is not None:
            corpus_index.extend(file_index)

        inner_calls: set[int] = set()
        for candidate in ast.walk(tree):
            if (
                isinstance(candidate, ast.Call)
                and isinstance(candidate.func, ast.Attribute)
                and isinstance(candidate.func.value, ast.Call)
            ):
                inner_calls.add(id(candidate.func.value))

        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            if (
                isinstance(node.func, ast.Attribute)
                and node.func.attr in SQL_EXEC_METHODS
                and node.args
            ):
                literal = _extract_sql_literal(node.args[0], module_consts)
                if literal is None:
                    # SQL assembled beyond the const/f-string hops (local
                    # conditional tuple-assigns etc.) — count, never silent.
                    caveats.sql_sites_unresolved_dynamic += 1
                    continue
                if not HAVE_SQLGLOT:
                    caveats.sql_sites_skipped_no_sqlglot += 1
                    continue
                for table, column, direction, confidence, verb in _sql_statement_rows(
                    literal.text, literal.dynamic, caveats
                ):
                    rows.append(
                        EvidenceRow(
                            table=table,
                            column=column,
                            direction=direction,
                            confidence=confidence,
                            method=verb,
                            file=rel_path,
                            line=node.lineno,
                            source="sql",
                        )
                    )
                continue
            if id(node) in inner_calls:
                continue
            chain = _supabase_chain(node)
            if chain:
                rows.extend(_supabase_chain_rows(chain, rel_path, caveats))

    declarative_uses, unresolved = resolve_uses(corpus_index)
    for use in declarative_uses:
        rows.append(
            EvidenceRow(
                table=use.table,
                column=use.columnPath,
                direction="write",
                confidence=use.confidence,
                method=use.method,
                file=use.file,
                line=use.line,
                source="declarative",
            )
        )
    for site in unresolved:
        caveats.unattributable_declare_row_sites.append(
            {"file": site.file, "line": site.line, "receiver": site.receiver}
        )

    return rows, caveats


def build_sidecar(
    rows: list[EvidenceRow], caveats: SweepCaveats, duration_ms: int
) -> dict[str, object]:
    """The v1 evidence-sidecar envelope (schema-coverage --evidence input)."""
    return {
        "schemaVersion": SIDECAR_SCHEMA_VERSION,
        "source": SIDECAR_SOURCE,
        "generatedBy": "schema-uses",
        "sqlglot": HAVE_SQLGLOT,
        "durationMs": duration_ms,
        "rows": [row.to_json() for row in rows],
        "caveats": caveats.to_json(),
    }

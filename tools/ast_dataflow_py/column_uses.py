"""Column read/write detection over the Python pipeline corpus.

The Python sibling of the TypeScript ast-dataflow ``column-reads`` /
``column-writes`` queries. The TS tool answers "which TS code touches
table.column"; this module answers the same question for the Python side,
which reaches the SAME Postgres tables through two access layers the TS
tool cannot see:

1. Raw SQL strings passed to asyncpg (``await conn.execute("UPDATE …")``,
   ``conn.fetch/fetchrow/fetchval/executemany``). Statements are parsed with
   sqlglot when available (exact confidence); a word-boundary regex fallback
   reports ``indirect`` confidence when sqlglot is not importable or the SQL
   is assembled dynamically (f-strings).
2. supabase-py fluent chains (``client.from_("table").update({...})`` — note
   supabase-py uses ``from_``; ``.rpc("fn", {...})`` payload keys).

Deliberately NOT covered: Python symbol queries (callers / references /
importers). Jedi, Pyright, and GitNexus already resolve those; duplicating
them adds nothing (see ID-50 review notes).

Result rows follow the TS QueryResponse row shape: repo-root-relative POSIX
file path, 1-based line/column, ``confidence`` in exact | wildcard | indirect.
"""

from __future__ import annotations

import ast
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator, Literal

try:  # sqlglot is optional — regex fallback below keeps the tool functional.
    import sqlglot  # type: ignore[import-not-found]
    import sqlglot.expressions as sqlglot_exp  # type: ignore[import-not-found]

    HAVE_SQLGLOT = True
except ImportError:  # pragma: no cover - exercised via the fallback tests
    sqlglot = None  # type: ignore[assignment]
    sqlglot_exp = None  # type: ignore[assignment]
    HAVE_SQLGLOT = False

Confidence = Literal["exact", "wildcard", "indirect"]
QueryKind = Literal["column-reads", "column-writes"]

# asyncpg / psycopg call attribute names that take SQL as their first argument.
SQL_EXEC_METHODS = frozenset(
    {"execute", "executemany", "fetch", "fetchrow", "fetchval", "fetch_one"}
)

# SQL statement verbs bucketed by query kind. A column named in a WHERE /
# RETURNING / ON CONFLICT clause of a write statement is still reported under
# column-writes (the statement writes the table; the column participates).
READ_VERBS = frozenset({"select"})
WRITE_VERBS = frozenset({"insert", "update", "delete", "merge"})

# supabase-py chain methods, mirroring the TS tool's method taxonomy.
SUPABASE_WRITE_METHODS = frozenset({"insert", "update", "upsert"})
SUPABASE_FILTER_METHODS = frozenset(
    {
        "eq",
        "neq",
        "gt",
        "gte",
        "lt",
        "lte",
        "like",
        "ilike",
        "is_",
        "in_",
        "contains",
        "contained_by",
        "overlaps",
        "text_search",
        "order",
        "match",
    }
)


@dataclass
class ColumnUseRow:
    file: str
    line: int
    column: int
    confidence: Confidence
    method: str
    columnPath: str
    table: str
    enclosing: str
    source: Literal["sql", "supabase-py"]
    chainMethod: str | None = None

    def to_json(self) -> dict[str, object]:
        row: dict[str, object] = {
            "file": self.file,
            "line": self.line,
            "column": self.column,
            "confidence": self.confidence,
            "method": self.method,
            "columnPath": self.columnPath,
            "table": self.table,
            "enclosing": self.enclosing,
            "source": self.source,
        }
        if self.chainMethod is not None:
            row["chainMethod"] = self.chainMethod
        return row


@dataclass
class _SqlLiteral:
    """A SQL string reachable from a Python call, plus how static it is."""

    text: str
    node: ast.AST
    dynamic: bool  # True when assembled from an f-string (parts joined)


@dataclass
class _EnclosingTracker(ast.NodeVisitor):
    """Assigns 'fn:<name>' / 'method:<Class>.<name>' / 'moduleTopLevel' labels."""

    labels: dict[int, str] = field(default_factory=dict)
    _stack: list[str] = field(default_factory=list)
    _class_stack: list[str] = field(default_factory=list)

    def label_for(self, node: ast.AST) -> str:
        return self.labels.get(id(node), "moduleTopLevel")

    def _current(self) -> str:
        return self._stack[-1] if self._stack else "moduleTopLevel"

    def generic_visit(self, node: ast.AST) -> None:
        self.labels[id(node)] = self._current()
        super().generic_visit(node)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self.labels[id(node)] = self._current()
        self._class_stack.append(node.name)
        super().generic_visit(node)
        self._class_stack.pop()

    def _visit_function(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        self.labels[id(node)] = self._current()
        if self._class_stack:
            label = f"method:{self._class_stack[-1]}.{node.name}"
        else:
            label = f"fn:{node.name}"
        self._stack.append(label)
        super().generic_visit(node)
        self._stack.pop()

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._visit_function(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._visit_function(node)


def _extract_sql_literal(node: ast.expr) -> _SqlLiteral | None:
    """Extract SQL text from a call argument: plain string or f-string."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return _SqlLiteral(text=node.value, node=node, dynamic=False)
    if isinstance(node, ast.JoinedStr):
        # f-string — join static parts, replace interpolations with a
        # placeholder so sqlglot can still usually parse the skeleton.
        parts: list[str] = []
        for value in node.values:
            if isinstance(value, ast.Constant) and isinstance(value.value, str):
                parts.append(value.value)
            else:
                parts.append(" __dyn__ ")
        return _SqlLiteral(text="".join(parts), node=node, dynamic=True)
    return None


_WORD_RE_CACHE: dict[str, re.Pattern[str]] = {}


def _word_re(word: str) -> re.Pattern[str]:
    pattern = _WORD_RE_CACHE.get(word)
    if pattern is None:
        pattern = re.compile(rf"\b{re.escape(word)}\b", re.IGNORECASE)
        _WORD_RE_CACHE[word] = pattern
    return pattern


def _sql_mentions(text: str, name: str) -> bool:
    return bool(_word_re(name).search(text))


def _classify_sql_with_sqlglot(
    sql: str, table: str, column: str
) -> list[tuple[str, Confidence]]:
    """Return (verb, confidence) hits for statements touching table+column.

    Confidence is 'exact' for a parsed statement naming both, 'wildcard' when
    the statement selects * from the table (column presence unconfirmable).
    """
    assert sqlglot is not None and sqlglot_exp is not None  # guarded by HAVE_SQLGLOT
    hits: list[tuple[str, Confidence]] = []
    try:
        statements = sqlglot.parse(sql, read="postgres")
    except Exception:
        return []
    for stmt in statements:
        if stmt is None:
            continue
        tables = {t.name for t in stmt.find_all(sqlglot_exp.Table)}
        if table not in tables:
            continue
        verb = stmt.key.lower()
        columns = {c.name for c in stmt.find_all(sqlglot_exp.Column)}
        # INSERT column lists live in the Schema node, not as Column nodes.
        if isinstance(stmt, sqlglot_exp.Insert):
            schema = stmt.this
            if isinstance(schema, sqlglot_exp.Schema):
                columns.update(
                    ident.name
                    for ident in schema.expressions
                    if isinstance(ident, (sqlglot_exp.Identifier, sqlglot_exp.Column))
                )
        if column in columns:
            hits.append((verb, "exact"))
        elif verb == "select" and stmt.find(sqlglot_exp.Star) is not None:
            hits.append((verb, "wildcard"))
    return hits


def _classify_sql_fallback(
    sql: str, table: str, column: str
) -> list[tuple[str, Confidence]]:
    """Regex fallback when sqlglot is unavailable or parsing failed."""
    if not _sql_mentions(sql, table):
        return []
    lowered = sql.lower()
    verb = "sql"
    for candidate in ("insert", "update", "delete", "merge", "select"):
        if re.search(rf"\b{candidate}\b", lowered):
            verb = candidate
            break
    if _sql_mentions(sql, column):
        return [(verb, "indirect")]
    if verb == "select" and "*" in sql:
        return [(verb, "wildcard")]
    return []


def _classify_sql(
    sql: str, table: str, column: str, dynamic: bool
) -> list[tuple[str, Confidence]]:
    hits: list[tuple[str, Confidence]] = []
    if HAVE_SQLGLOT:
        hits = _classify_sql_with_sqlglot(sql, table, column)
    if not hits:
        hits = _classify_sql_fallback(sql, table, column)
    if dynamic:
        # Dynamically-assembled SQL can never be better than indirect
        # (except wildcard, which is already weaker than indirect for reads).
        hits = [
            (verb, "indirect" if conf == "exact" else conf) for verb, conf in hits
        ]
    return hits


def _verb_matches_kind(verb: str, kind: QueryKind) -> bool:
    if kind == "column-reads":
        return verb in READ_VERBS or verb == "sql"
    return verb in WRITE_VERBS or verb == "sql"


def _dict_has_key(node: ast.expr, column: str) -> tuple[bool, bool]:
    """(has_key, has_dynamic) for a dict literal payload.

    has_dynamic covers ``**spread`` entries and non-constant keys — either
    means the column cannot be ruled out statically.
    """
    if not isinstance(node, ast.Dict):
        return (False, True)  # not a literal — can't rule out
    has_dynamic = False
    for key in node.keys:
        if key is None:  # **spread
            has_dynamic = True
        elif isinstance(key, ast.Constant) and isinstance(key.value, str):
            if key.value == column:
                return (True, has_dynamic)
        else:
            has_dynamic = True
    return (False, has_dynamic)


def _supabase_chain(call: ast.Call) -> list[tuple[str, ast.Call]]:
    """Given the OUTERMOST call of a fluent chain, return (method, call) pairs
    walking inward, e.g. client.from_("t").update({...}).eq("id", 1)."""
    chain: list[tuple[str, ast.Call]] = []
    current: ast.expr = call
    while isinstance(current, ast.Call) and isinstance(current.func, ast.Attribute):
        chain.append((current.func.attr, current))
        current = current.func.value
    return chain


def _select_contains_column(select_str: str, column: str) -> bool:
    stripped = select_str
    prev = None
    while prev != stripped:
        prev = stripped
        stripped = re.sub(r"\([^()]*\)", "", stripped)
    tokens = []
    for raw in stripped.split(","):
        token = raw.strip()
        if ":" in token:
            token = token.split(":", 1)[1].strip()
        token = token.split()[0] if token.split() else ""
        if token:
            tokens.append(token)
    return column in tokens


def scan_python_source(
    source: str,
    rel_path: str,
    table: str,
    column: str,
    kind: QueryKind,
) -> Iterator[ColumnUseRow]:
    """Scan one Python file's source for column uses of table.column."""
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return

    tracker = _EnclosingTracker()
    tracker.visit(tree)

    # Fluent-chain dedupe: ast.walk visits every sub-call of a chain
    # (`.execute()`, `.eq()`, `.update()`, `.from_()` are four Call nodes).
    # Mark every call that is the receiver of another call so only the
    # OUTERMOST call of each chain is processed.
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

        # ── Raw SQL via asyncpg-style calls ─────────────────────────────
        if (
            isinstance(node.func, ast.Attribute)
            and node.func.attr in SQL_EXEC_METHODS
            and node.args
        ):
            literal = _extract_sql_literal(node.args[0])
            if literal is not None:
                for verb, confidence in _classify_sql(
                    literal.text, table, column, literal.dynamic
                ):
                    if not _verb_matches_kind(verb, kind):
                        continue
                    yield ColumnUseRow(
                        file=rel_path,
                        line=node.lineno,
                        column=node.col_offset + 1,
                        confidence=confidence,
                        method=verb,
                        columnPath="*" if confidence == "wildcard" else column,
                        table=table,
                        enclosing=tracker.label_for(node),
                        source="sql",
                    )
            continue

        # ── supabase-py chains ──────────────────────────────────────────
        if id(node) in inner_calls:
            continue  # a sub-call; the outermost call handles this chain
        chain = _supabase_chain(node)
        if not chain:
            continue
        methods = {m for m, _ in chain}

        # .rpc("fn", {column: value}) payload
        if "rpc" in methods:
            rpc_call = next(c for m, c in chain if m == "rpc")
            if len(rpc_call.args) >= 2:
                has_key, has_dynamic = _dict_has_key(rpc_call.args[1], column)
                if has_key or has_dynamic:
                    yield ColumnUseRow(
                        file=rel_path,
                        line=rpc_call.lineno,
                        column=rpc_call.col_offset + 1,
                        confidence="exact" if has_key else "indirect",
                        method="rpc-payload",
                        columnPath=column,
                        table=table,
                        enclosing=tracker.label_for(rpc_call),
                        source="supabase-py",
                    )
            continue

        # Chains must be rooted at .from_("<table>") naming OUR table.
        from_entry = next((c for m, c in chain if m in {"from_", "table"}), None)
        if from_entry is None or not from_entry.args:
            continue
        table_arg = from_entry.args[0]
        if not (
            isinstance(table_arg, ast.Constant) and table_arg.value == table
        ):
            continue

        for method, method_call in chain:
            if method in SUPABASE_WRITE_METHODS and kind == "column-writes":
                if not method_call.args:
                    continue
                payload = method_call.args[0]
                if isinstance(payload, ast.List):
                    elements = payload.elts
                    found = False
                    ruled_out = True
                    for element in elements:
                        has_key, has_dynamic = _dict_has_key(element, column)
                        if has_key:
                            found = True
                            break
                        if has_dynamic:
                            ruled_out = False
                    if not found and ruled_out:
                        continue
                    confidence: Confidence = "exact" if found else "indirect"
                else:
                    has_key, has_dynamic = _dict_has_key(payload, column)
                    if not has_key and not has_dynamic:
                        continue
                    confidence = "exact" if has_key else "indirect"
                yield ColumnUseRow(
                    file=rel_path,
                    line=method_call.lineno,
                    column=method_call.col_offset + 1,
                    confidence=confidence,
                    method=method,
                    columnPath=column,
                    table=table,
                    enclosing=tracker.label_for(method_call),
                    source="supabase-py",
                )
            elif method == "select" and kind == "column-reads":
                if not method_call.args:
                    continue
                select_arg = method_call.args[0]
                if not (
                    isinstance(select_arg, ast.Constant)
                    and isinstance(select_arg.value, str)
                ):
                    continue
                if select_arg.value == "*":
                    yield ColumnUseRow(
                        file=rel_path,
                        line=method_call.lineno,
                        column=method_call.col_offset + 1,
                        confidence="wildcard",
                        method="select",
                        columnPath="*",
                        table=table,
                        enclosing=tracker.label_for(method_call),
                        source="supabase-py",
                    )
                elif _select_contains_column(select_arg.value, column):
                    yield ColumnUseRow(
                        file=rel_path,
                        line=method_call.lineno,
                        column=method_call.col_offset + 1,
                        confidence="exact",
                        method="select",
                        columnPath=column,
                        table=table,
                        enclosing=tracker.label_for(method_call),
                        source="supabase-py",
                    )
            elif method in SUPABASE_FILTER_METHODS and kind == "column-reads":
                if not method_call.args:
                    continue
                if method == "match":
                    has_key, _ = _dict_has_key(method_call.args[0], column)
                    if not has_key:
                        continue
                elif not (
                    isinstance(method_call.args[0], ast.Constant)
                    and method_call.args[0].value == column
                ):
                    continue
                yield ColumnUseRow(
                    file=rel_path,
                    line=method_call.lineno,
                    column=method_call.col_offset + 1,
                    confidence="exact",
                    method="filter" if method != "order" else "order",
                    columnPath=column,
                    table=table,
                    enclosing=tracker.label_for(method_call),
                    source="supabase-py",
                    chainMethod=method if method not in {"order"} else None,
                )


TEST_PATH_MARKERS = ("/tests/", "/test/", "/__tests__/")


def is_test_path(rel_path: str) -> bool:
    normalized = f"/{rel_path}"
    return (
        any(marker in normalized for marker in TEST_PATH_MARKERS)
        or rel_path.startswith("tests/")
        or Path(rel_path).name.startswith("test_")
        or Path(rel_path).name.endswith("_test.py")
    )


def scan_tree(
    root: Path,
    scan_dirs: list[str],
    table: str,
    column: str,
    kind: QueryKind,
    exclude_tests: bool = False,
) -> Iterator[ColumnUseRow]:
    """Scan all .py files under root/<scan_dirs> for column uses."""
    for scan_dir in scan_dirs:
        base = root / scan_dir
        if not base.exists():
            continue
        for path in sorted(base.rglob("*.py")):
            rel = path.relative_to(root).as_posix()
            if exclude_tests and is_test_path(rel):
                continue
            try:
                source = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            yield from scan_python_source(source, rel, table, column, kind)

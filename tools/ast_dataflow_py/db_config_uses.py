"""DB-config evidence producer — the Postgres schema-dump surface.

Three schema surfaces are structurally invisible to every producer that reads
source files: Postgres function/RPC bodies, view definitions, and
catalog-resident triggers and row-level-security policies. They live only in
the database catalog, so ADR 0003 gives this producer an INPUT instead of a
connection: a schema-only ``pg_dump`` (or Supabase CLI ``db dump``) file. An
evidence ref must be openable by a reviewer, and ``db-config.sql:143`` is a
file on disk where ``pg_proc`` oid 16412 is not.

The design record is ``docs/db-config-export.md``; the acceptance corpus
``docs/db-config-acceptance-corpus.md`` is this module's test oracle.

Why this is more than a ``sqlglot.parse(open(dump).read())`` call: sqlglot
parses the dump's structural DDL, but returns an opaque ``Command`` node for
exactly the highest-value classes — plpgsql ``CREATE FUNCTION``,
``CREATE POLICY``, ``CREATE MATERIALIZED VIEW``, ``ENABLE ROW LEVEL SECURITY``,
``DISABLE TRIGGER`` — and PL/pgSQL is not a SQL dialect at all. So this module
splits statements itself (positionally, so refs keep ORIGINAL dump lines),
extracts dollar-quoted bodies, isolates the SQL embedded in procedural
scaffolding, and parses those statements individually.

Confidence follows the design's two-tier rule:

* **Tier 1 — independent objects that EXECUTE access** (function bodies,
  views, policies, triggers) can reach ``exact``, under per-class gates: an
  unambiguous single table binding, and the object actually being enabled.
* **Tier 2 — the column's own structural furniture** (defaults, NOT NULL,
  constraints, indexes, generated expressions) is emitted at ``indirect`` —
  never silence, never ``exact``. A column whose only trace is executed
  structure verdicts ``undecidable`` rather than ``unwired``; emitting nothing
  for furniture was the design's worst v1 defect, because it manufactured
  measured-looking false-dead verdicts.

Unlike ``column_uses``, there is NO regex fallback: a dump producer with no SQL
parser cannot meet the loudness floor, so a missing sqlglot is a loud failure
that writes nothing (corpus I8).
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator, Literal

try:  # sqlglot is REQUIRED here — see the module docstring and corpus I8.
    import sqlglot  # type: ignore[import-not-found]
    import sqlglot.expressions as sqlglot_exp  # type: ignore[import-not-found]

    # sqlglot logs a warning for every construct it degrades to a Command.
    # Those degradations are expected and handled by hand here, so the warnings
    # are noise on a producer whose stdout is the artefact.
    logging.getLogger("sqlglot").setLevel(logging.CRITICAL)
    HAVE_SQLGLOT = True
except ImportError:  # pragma: no cover - exercised by monkeypatch in the tests
    sqlglot = None  # type: ignore[assignment]
    sqlglot_exp = None  # type: ignore[assignment]
    HAVE_SQLGLOT = False

Direction = Literal["read", "write"]
Confidence = Literal["exact", "wildcard", "indirect"]

SIDECAR_SCHEMA_VERSION = 1
SIDECAR_SOURCE = "ast-dataflow-dbconfig"
GENERATED_BY = "db-config-uses"
DEFAULT_TARGET_SCHEMA = "public"

# A dump is recognisable by its header or by containing real statements. This is
# what separates corpus I3 (a CSV — hard failure) from corpus I4 (a valid dump
# that happens to hold no objects — an honest empty measurement).
DUMP_HEADER_MARKER = "PostgreSQL database dump"
DUMP_VERSION_HEADER_PREFIXES = (
    "-- Dumped from database version",
    "-- Dumped by pg_dump version",
)
RECOGNISED_LEADING_KEYWORDS = frozenset(
    {
        "create",
        "alter",
        "comment",
        "set",
        "select",
        "grant",
        "revoke",
        "insert",
        "copy",
        "drop",
        "begin",
        "start",
    }
)

# PL/pgSQL scaffolding that carries no column reference. Skipped AND counted:
# the dominant function language must have a stated position, not a silent one.
PLPGSQL_CONTROL_FLOW_PREFIXES = (
    "raise",
    "null",
    "continue",
    "exit",
    "commit",
    "rollback",
    "get diagnostics",
)

# Languages whose bodies this producer reads. Everything else is counted per
# language and blocks narrowing — it is unmeasured, not measured-empty.
SUPPORTED_BODY_LANGUAGES = frozenset({"sql", "plpgsql"})

TRIGGER_ROW_KEYWORDS = frozenset({"new", "old"})

# `DISABLE TRIGGER ALL` / `USER` name no trigger — they disable the table's whole
# set. Reading one as a trigger NAME silently ignores the disable.
DISABLE_TRIGGER_KEYWORDS = frozenset({"all", "user"})

# PL/pgSQL magic variables. They are bound names, not columns, so they must
# never fabricate a row when they appear inside a single-table statement.
PLPGSQL_BUILTIN_VARIABLES = frozenset(
    {
        "found",
        "row_count",
        "sqlerrm",
        "sqlstate",
        "tg_argv",
        "tg_level",
        "tg_name",
        "tg_nargs",
        "tg_op",
        "tg_relid",
        "tg_table_name",
        "tg_table_schema",
        "tg_when",
    }
)

# Argument-list modes that precede a parameter name rather than being one.
PARAMETER_MODES = frozenset({"IN", "OUT", "INOUT", "VARIADIC"})

# Words that open a TYPE in an argument list, so a parameter leading with one
# is unnamed (`f(timestamp with time zone)`). Reading such a word as a name
# would let it suppress a real column of the same name.
TYPE_LEADING_KEYWORDS = frozenset(
    {
        "bigint",
        "bit",
        "boolean",
        "bytea",
        "char",
        "character",
        "cidr",
        "date",
        "decimal",
        "double",
        "inet",
        "int",
        "integer",
        "interval",
        "json",
        "jsonb",
        "macaddr",
        "money",
        "name",
        "national",
        "nchar",
        "numeric",
        "oid",
        "real",
        "record",
        "setof",
        "smallint",
        "text",
        "time",
        "timestamp",
        "trigger",
        "tsquery",
        "tsvector",
        "uuid",
        "varchar",
        "void",
        "xml",
    }
)

_DOLLAR_TAG_RE = re.compile(r"\$([A-Za-z_][A-Za-z0-9_]*)?\$")
_IDENT_RE = r'(?:"[^"]*"|[A-Za-z_][A-Za-z0-9_$]*)'
_BARE_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
# `NEW.col = expr` / `var = expr` at the very START of a statement. Anchored, so
# a comparison inside a real SQL statement can never match.
_ANCHORED_ASSIGNMENT_RE = re.compile(
    r'^((?:new|old)\s*\.\s*"?[\w$]+"?|"?[A-Za-z_][\w$]*"?)\s*=(?!=)\s*(.*)$',
    re.I | re.S,
)


class DumpFormatError(Exception):
    """The input is not a usable Postgres schema dump.

    Raised rather than degraded: an unrecognisable input must never merge as an
    empty, clean sidecar, because that is exactly how "could not look" is
    converted into "measured" (design §6, ADR 0003).
    """


# ── The positional statement splitter ───────────────────────────────────────
# The #14 survey ruled this splitter load-bearing with no outsourcing option
# (the only alternative splitter is GPL), so its edge cases are first-class:
# corpus §I. Line numbers are ORIGINAL dump lines throughout — a shifted
# dollar-quote boundary silently corrupts every file:line after it, which is
# ref corruption rather than a countable caveat, so it is fatal for the file.


@dataclass(frozen=True)
class Statement:
    """One SQL statement plus the ORIGINAL dump line it starts on."""

    text: str
    start_line: int

    def line_at(self, offset: int) -> int:
        """Original dump line of a character offset inside this statement."""
        return self.start_line + self.text[:offset].count("\n")


# Every CREATE TABLE spelling a dump can carry. A table the dump DEFINES but
# this pattern misses is worse than unknown: its references become countable
# blindness and its furniture rows vanish (corpus A10).
_CREATE_TABLE_RE = (
    r"^\s*create\s+(?:(?:global|local)\s+)?"
    r"(?:temp\w*\s+|unlogged\s+|foreign\s+)?table\b"
)

_BEGIN_ATOMIC_RE = re.compile(r"\bBEGIN\s+ATOMIC\b", re.I)
_END_KEYWORD_RE = re.compile(r"\bEND\b", re.I)


def _inside_atomic_body(buffer: list[str]) -> bool:
    """Is the buffer inside an unterminated PG14+ `BEGIN ATOMIC` body?

    A SQL-standard function body is not dollar-quoted, so its statement
    separators sit at depth 0 and would otherwise split the CREATE FUNCTION
    into pieces. Only CREATE statements can open one, which keeps this off the
    hot path for every other statement in the dump.
    """
    if not buffer or buffer[0] not in "Cc":
        return False
    text = "".join(buffer)
    opens = len(_BEGIN_ATOMIC_RE.findall(text))
    if not opens:
        return False
    return len(_END_KEYWORD_RE.findall(text)) < opens


def split_statements(text: str) -> list[Statement]:
    r"""Split dump text into statements, tracking original line numbers.

    Handles single quotes (with ``''`` doubling and ``E'…\'`` escapes), quoted
    identifiers, dollar quotes with named and nested tags, line and nestable
    block comments, and psql ``\``-meta-command lines — which are SKIPPED but
    still counted, so stripping them never shifts a ref (corpus I1, invariant
    I5).
    """
    statements: list[Statement] = []
    buffer: list[str] = []
    start_line = 0
    index = 0
    line = 1
    depth = 0
    length = len(text)

    def flush() -> None:
        nonlocal buffer, start_line
        collected = "".join(buffer).strip()
        if collected:
            statements.append(Statement(text=collected, start_line=start_line))
        buffer = []
        start_line = 0

    while index < length:
        char = text[index]

        if char == "\n":
            line += 1
            if buffer:
                buffer.append(char)
            index += 1
            continue

        # psql meta-command (\restrict, \unrestrict, \connect): a whole line of
        # non-SQL that crashes a naive whole-file parse. Skipped, still counted.
        if char == "\\" and not buffer and (index == 0 or text[index - 1] == "\n"):
            newline = text.find("\n", index)
            index = length if newline == -1 else newline
            continue

        if text.startswith("--", index):
            newline = text.find("\n", index)
            index = length if newline == -1 else newline
            continue

        if text.startswith("/*", index):
            nesting = 1
            index += 2
            consumed_newlines = 0
            while index < length and nesting:
                if text.startswith("/*", index):
                    nesting += 1
                    index += 2
                elif text.startswith("*/", index):
                    nesting -= 1
                    index += 2
                else:
                    if text[index] == "\n":
                        line += 1
                        consumed_newlines += 1
                    index += 1
            # The comment TEXT is dropped but its newlines are not: offsets
            # inside a statement are what `Statement.line_at` counts, so a
            # swallowed newline silently pulls every later ref upward.
            if buffer and consumed_newlines:
                buffer.append("\n" * consumed_newlines)
            continue

        if not buffer and char.isspace():
            index += 1
            continue

        if not buffer:
            start_line = line

        # Dollar quote. `$1` is a PARAMETER, never a tag — the tag pattern
        # requires an identifier or nothing between the dollars.
        if char == "$":
            match = _DOLLAR_TAG_RE.match(text, index)
            if match:
                tag = match.group(0)
                close = text.find(tag, match.end())
                if close == -1:
                    raise DumpFormatError(
                        f"unterminated dollar-quoted string {tag} opened at line {line}"
                    )
                chunk = text[index : close + len(tag)]
                buffer.append(chunk)
                line += chunk.count("\n")
                index = close + len(tag)
                continue

        if char == "'":
            escapes = index > 0 and text[index - 1] in "Ee"
            cursor = index + 1
            while cursor < length:
                current = text[cursor]
                if escapes and current == "\\":
                    cursor += 2
                    continue
                if current == "'":
                    if cursor + 1 < length and text[cursor + 1] == "'":
                        cursor += 2
                        continue
                    break
                cursor += 1
            chunk = text[index : cursor + 1]
            buffer.append(chunk)
            line += chunk.count("\n")
            index = cursor + 1
            continue

        if char == '"':
            cursor = index + 1
            while cursor < length:
                if text[cursor] == '"':
                    if cursor + 1 < length and text[cursor + 1] == '"':
                        cursor += 2
                        continue
                    break
                cursor += 1
            chunk = text[index : cursor + 1]
            buffer.append(chunk)
            line += chunk.count("\n")
            index = cursor + 1
            continue

        if char == "(":
            depth += 1
        elif char == ")":
            depth = max(0, depth - 1)
        elif char == ";" and depth == 0 and not _inside_atomic_body(buffer):
            flush()
            index += 1
            continue

        buffer.append(char)
        index += 1

    flush()
    return statements


# ── Identifiers ─────────────────────────────────────────────────────────────


def fold_identifier(raw: str) -> str:
    """Apply Postgres identifier semantics: unquoted folds, quoted is verbatim.

    Pinned by corpus I6 so the merge against the target repo's generated types
    is deterministic — sqlglot normalises identifiers, generated types do not.
    """
    stripped = raw.strip()
    if stripped.startswith('"') and stripped.endswith('"') and len(stripped) >= 2:
        return stripped[1:-1].replace('""', '"')
    return stripped.lower()


def _identifier_name(node) -> str:
    """Fold a sqlglot Identifier / Column / Table name by its quoting."""
    if not isinstance(node, sqlglot_exp.Expression):
        return ""
    if isinstance(node, sqlglot_exp.Identifier):
        return node.name if node.quoted else node.name.lower()
    inner = node.args.get("this")
    if isinstance(inner, sqlglot_exp.Identifier):
        return inner.name if inner.quoted else inner.name.lower()
    name = getattr(node, "name", "") or ""
    return name.lower()


def _table_schema(node) -> str:
    return _identifier_name(node.args.get("db")) if hasattr(node, "args") else ""


def _split_qualified(raw: str) -> tuple[str, str]:
    """`"public"."jobs"` / `public.jobs` / `jobs` -> (schema-or-'', name)."""
    parts: list[str] = []
    current = ""
    in_quotes = False
    for char in raw.strip():
        if char == '"':
            in_quotes = not in_quotes
            current += char
        elif char == "." and not in_quotes:
            parts.append(current)
            current = ""
        else:
            current += char
    parts.append(current)
    parts = [part for part in parts if part.strip()]
    if len(parts) >= 2:
        return fold_identifier(parts[-2]), fold_identifier(parts[-1])
    return "", fold_identifier(parts[0]) if parts else ""


# ── Catalog ─────────────────────────────────────────────────────────────────


@dataclass
class ColumnInfo:
    name: str
    line: int
    not_null: bool = False
    default_expr: object | None = None
    generated_expr: object | None = None


@dataclass
class TableInfo:
    schema: str
    name: str
    line: int
    columns: list[ColumnInfo] = field(default_factory=list)
    checks: list[object] = field(default_factory=list)

    @property
    def identity(self) -> str:
        return f"{self.schema}.{self.name}"


@dataclass
class ViewInfo:
    schema: str
    name: str
    line: int
    select: object
    materialized: bool = False

    @property
    def identity(self) -> str:
        return f"{self.schema}.{self.name}"


@dataclass
class FunctionInfo:
    schema: str
    name: str
    line: int
    language: str
    body: str
    body_line: int
    returns_trigger: bool
    parameters: frozenset[str] = frozenset()

    @property
    def identity(self) -> str:
        return f"{self.schema}.{self.name}"


@dataclass
class TriggerInfo:
    name: str
    schema: str
    table: str
    timing: str
    events: set[str]
    event_columns: list[str]
    when_expr: object | None
    function: str
    line: int
    enabled: bool = True

    @property
    def identity(self) -> str:
        return f"{self.schema}.{self.table}.{self.name}"


@dataclass
class PolicyInfo:
    name: str
    schema: str
    table: str
    using_expr: str | None
    check_expr: str | None
    line: int

    @property
    def identity(self) -> str:
        return f"{self.schema}.{self.table}.{self.name}"


@dataclass
class IndexInfo:
    name: str
    schema: str
    table: str
    columns: list[str]
    predicate: object | None
    line: int


@dataclass
class ConstraintInfo:
    kind: str  # foreign-key | primary-key | unique-constraint
    name: str
    schema: str
    table: str
    columns: list[str]
    ref_schema: str = ""
    ref_table: str = ""
    ref_columns: list[str] = field(default_factory=list)
    line: int = 0


@dataclass
class Catalog:
    tables: dict[str, TableInfo] = field(default_factory=dict)
    views: dict[str, ViewInfo] = field(default_factory=dict)
    functions: list[FunctionInfo] = field(default_factory=list)
    triggers: list[TriggerInfo] = field(default_factory=list)
    policies: list[PolicyInfo] = field(default_factory=list)
    indexes: list[IndexInfo] = field(default_factory=list)
    constraints: list[ConstraintInfo] = field(default_factory=list)
    partitions: dict[str, str] = field(default_factory=dict)  # child -> parent
    rls_enabled: set[str] = field(default_factory=set)
    disabled_triggers: set[tuple[str, str]] = field(default_factory=set)
    disabled_trigger_tables: set[str] = field(default_factory=set)
    schemas_seen: set[str] = field(default_factory=set)


# ── Caveats — exactly the corpus vocabulary, no more and no fewer ───────────


@dataclass
class DumpCaveats:
    """Loud-failure channels.

    An unknown caveat key is an unreviewed blindness channel; a missing one is a
    silent blindness. Both are floor violations, so the vocabulary is closed.
    """

    unparsed_statements: list[dict[str, object]] = field(default_factory=list)
    plpgsql_statement_accounting: list[dict[str, object]] = field(default_factory=list)
    dynamic_sql: int = 0
    unsupported_language_bodies: dict[str, int] = field(default_factory=dict)
    unresolved_table_names: dict[str, int] = field(default_factory=dict)
    ambiguous_column_bindings: list[dict[str, object]] = field(default_factory=list)
    multi_table_bound_functions: dict[str, list[str]] = field(default_factory=dict)
    disabled_objects: list[dict[str, str]] = field(default_factory=list)
    out_of_scope_objects: list[dict[str, str]] = field(default_factory=list)
    out_of_scope_references: int = 0
    partition_attribution: dict[str, str] = field(default_factory=dict)
    positional_insert: int = 0
    unbound_trigger_functions: list[str] = field(default_factory=list)

    def to_json(self) -> dict[str, object]:
        return {
            "unparsedStatements": self.unparsed_statements,
            "plpgsqlStatementAccounting": self.plpgsql_statement_accounting,
            "dynamicSql": self.dynamic_sql,
            "unsupportedLanguageBodies": dict(
                sorted(self.unsupported_language_bodies.items())
            ),
            "unresolvedTableNames": dict(sorted(self.unresolved_table_names.items())),
            "ambiguousColumnBindings": self.ambiguous_column_bindings,
            "multiTableBoundFunctions": {
                key: sorted(value)
                for key, value in sorted(self.multi_table_bound_functions.items())
            },
            "disabledObjects": self.disabled_objects,
            "outOfScopeSchemaObjects": {
                "objects": self.out_of_scope_objects,
                "references": self.out_of_scope_references,
            },
            "partitionAttribution": dict(sorted(self.partition_attribution.items())),
            "positionalInsert": self.positional_insert,
            "unboundTriggerFunctions": sorted(self.unbound_trigger_functions),
        }


@dataclass(frozen=True)
class EvidenceRow:
    table: str
    column: str  # "*" = table-scoped
    direction: Direction
    confidence: Confidence
    method: str
    file: str
    line: int
    source: str

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


@dataclass(frozen=True)
class Resolution:
    """A table reference resolved against the dump-local catalog."""

    table: str = ""  # the bare name the sidecar row carries
    identity: str = ""  # schema.name
    method_suffix: str = ""  # e.g. ";partition:public.orders_2024"
    ok: bool = False
    out_of_scope: bool = False


UNRESOLVED = Resolution()


# ── The producer ────────────────────────────────────────────────────────────


class DumpAnalyser:
    """Two passes over one dump: build the catalog, then extract evidence."""

    def __init__(self, dump_path: Path, target_schema: str) -> None:
        self.path = dump_path
        self.file = str(dump_path)
        self.target_schema = target_schema.lower()
        self.text = dump_path.read_text(encoding="utf-8", errors="replace")
        self.catalog = Catalog()
        self.caveats = DumpCaveats()
        self.rows: list[EvidenceRow] = []
        self._seen: set[EvidenceRow] = set()
        self._view_chase: list[str] = []
        # One table reference resolved twice inside ONE statement is one
        # reference, not two — otherwise `UPDATE ledger … WHERE id = …` counts
        # `ledger` twice in `unresolvedTableNames` (corpus A8).
        self._resolution_cache: dict[tuple[str, str], Resolution] = {}

    # ── entry point ─────────────────────────────────────────────────────────

    def run(self) -> dict[str, object]:
        statements = split_statements(self.text)
        self._require_dump_shape(statements)
        for statement in statements:
            self._catalogue(statement)
        self._require_target_schema_present()
        self._extract_evidence()
        return self._sidecar()

    def _require_target_schema_present(self) -> None:
        """A `--schema` that matches nothing the dump defines is a hard error.

        The discriminator is "the dump HAS objects, just not in your schema" —
        a dump with no objects at all stays corpus I4's honest empty sidecar.
        A typo'd schema quietly producing a clean empty sidecar is exactly the
        "could not look" / "measured" confusion the loudness floor forbids.
        """
        found = self.catalog.schemas_seen
        if not found or self.target_schema in found:
            return
        raise DumpFormatError(
            f"--schema {self.target_schema!r} matched no objects in {self.file}. "
            f"The dump defines objects in: {', '.join(sorted(found))}."
        )

    def _require_dump_shape(self, statements: list[Statement]) -> None:
        if DUMP_HEADER_MARKER in self.text:
            return
        for statement in statements:
            leading = statement.text.split(None, 1)[0].lower() if statement.text else ""
            if leading in RECOGNISED_LEADING_KEYWORDS:
                return
        raise DumpFormatError(
            f"{self.file} contains no recognisable Postgres dump statements. "
            "Expected plain pg_dump or Supabase CLI `db dump` output."
        )

    def _new_resolution_scope(self) -> None:
        self._resolution_cache = {}

    # ── pass 1: the catalog ─────────────────────────────────────────────────

    def _catalogue(self, statement: Statement) -> None:
        head = statement.text[:200].lower()
        if re.match(r"^\s*create\s+(or\s+replace\s+)?(function|procedure)\b", head):
            self._catalogue_function(statement)
        elif re.match(r"^\s*create\s+policy\b", head):
            self._catalogue_policy(statement)
        elif re.match(r"^\s*create\s+(or\s+replace\s+)?(materialized\s+)?view\b", head):
            self._catalogue_view(statement)
        elif re.match(r"^\s*create\s+(unique\s+)?index\b", head):
            self._catalogue_index(statement)
        elif re.match(_CREATE_TABLE_RE, head):
            self._catalogue_table(statement)
        elif re.match(r"^\s*create\s+(constraint\s+)?trigger\b", head):
            self._catalogue_trigger(statement)
        elif re.match(r"^\s*alter\s+table\b", head):
            self._catalogue_alter_table(statement)

    def _parse_one(self, text: str):
        try:
            parsed = sqlglot.parse_one(text, read="postgres")
        except Exception:
            return None
        if parsed is None or isinstance(parsed, sqlglot_exp.Command):
            return None
        return parsed

    def _record_out_of_scope(self, kind: str, name: str) -> None:
        # Only EXECUTING classes count here. A table residing in another schema
        # is simply outside the target surface, but a function, view, policy or
        # trigger residing there may still touch a target-schema column, so
        # excluding it produces SILENCE on that column — blindness that gates
        # narrowing rather than being merely counted (design §4, corpus G1).
        self.caveats.out_of_scope_objects.append({"kind": kind, "name": name})

    def _in_scope(self, schema: str) -> bool:
        return (schema or self.target_schema) == self.target_schema

    # -- tables

    def _catalogue_table(self, statement: Statement) -> None:
        # sqlglot degrades CREATE FOREIGN TABLE to an opaque Command, so the
        # foreign spelling is normalised to the plain one: the column list is
        # the part this producer needs, and the SERVER/OPTIONS tail is not.
        text = statement.text
        if re.match(r"^\s*create\s+foreign\s+table\b", text[:60], re.I):
            text = re.sub(r"\bforeign\s+table\b", "TABLE", text, count=1, flags=re.I)
            text = re.sub(r"\)\s*SERVER\b.*$", ")", text, flags=re.I | re.S)
        parsed = self._parse_one(text)
        if parsed is None:
            return
        target = parsed.find(sqlglot_exp.Schema) or parsed.this
        table_node = target.this if isinstance(target, sqlglot_exp.Schema) else target
        if not isinstance(table_node, sqlglot_exp.Table):
            return
        schema = _table_schema(table_node) or self.target_schema
        self.catalog.schemas_seen.add(schema)
        name = _identifier_name(table_node)

        partition_of = parsed.find(sqlglot_exp.PartitionedOfProperty)
        if partition_of is not None and isinstance(partition_of.this, sqlglot_exp.Table):
            parent = partition_of.this
            parent_schema = _table_schema(parent) or self.target_schema
            self.catalog.partitions[f"{schema}.{name}"] = (
                f"{parent_schema}.{_identifier_name(parent)}"
            )

        if not self._in_scope(schema):
            return

        info = TableInfo(schema=schema, name=name, line=statement.start_line)
        if isinstance(target, sqlglot_exp.Schema):
            for entry in target.expressions:
                if isinstance(entry, sqlglot_exp.ColumnDef):
                    info.columns.append(self._column_info(entry, statement, info))
                elif isinstance(entry, sqlglot_exp.Constraint):
                    for constraint in entry.expressions:
                        self._table_level_constraint(info, entry, constraint, statement)
                elif isinstance(entry, sqlglot_exp.PrimaryKey):
                    self._add_constraint(
                        "primary-key",
                        f"{name}_pkey",
                        schema,
                        name,
                        [_identifier_name(i) for i in entry.expressions],
                        statement,
                    )
        self.catalog.tables[info.identity] = info

    def _column_info(
        self, node: sqlglot_exp.ColumnDef, statement: Statement, table: TableInfo
    ) -> ColumnInfo:
        name = _identifier_name(node.this)
        info = ColumnInfo(name=name, line=_line_of_column(statement, name))
        for constraint in node.constraints or []:
            kind = constraint.kind
            if isinstance(kind, sqlglot_exp.NotNullColumnConstraint):
                info.not_null = True
            elif isinstance(kind, sqlglot_exp.DefaultColumnConstraint):
                info.default_expr = kind.this
            elif isinstance(kind, sqlglot_exp.ComputedColumnConstraint):
                info.generated_expr = kind.this
            elif isinstance(kind, sqlglot_exp.CheckColumnConstraint):
                table.checks.append(kind.this)
        return info

    def _table_level_constraint(
        self,
        table: TableInfo,
        wrapper: sqlglot_exp.Constraint,
        constraint,
        statement: Statement,
    ) -> None:
        constraint_name = _identifier_name(wrapper.this) or f"{table.name}_constraint"
        if isinstance(constraint, sqlglot_exp.CheckColumnConstraint):
            table.checks.append(constraint.this)
        elif isinstance(constraint, sqlglot_exp.PrimaryKey):
            self._add_constraint(
                "primary-key",
                constraint_name,
                table.schema,
                table.name,
                [_identifier_name(i) for i in constraint.expressions],
                statement,
            )
        elif isinstance(constraint, sqlglot_exp.UniqueColumnConstraint):
            self._add_constraint(
                "unique-constraint",
                constraint_name,
                table.schema,
                table.name,
                _schema_identifiers(constraint.this),
                statement,
            )
        elif isinstance(constraint, sqlglot_exp.ForeignKey):
            self._foreign_key(
                constraint, constraint_name, table.schema, table.name, statement
            )

    def _add_constraint(
        self,
        kind: str,
        name: str,
        schema: str,
        table: str,
        columns: list[str],
        statement: Statement,
    ) -> None:
        if not columns:
            return
        self.catalog.constraints.append(
            ConstraintInfo(
                kind=kind,
                name=name,
                schema=schema,
                table=table,
                columns=columns,
                line=statement.start_line,
            )
        )

    def _foreign_key(
        self,
        node: sqlglot_exp.ForeignKey,
        name: str,
        schema: str,
        table: str,
        statement: Statement,
    ) -> None:
        reference = node.args.get("reference")
        ref_schema = ref_table = ""
        ref_columns: list[str] = []
        if isinstance(reference, sqlglot_exp.Expression):
            inner = reference.this
            if isinstance(inner, sqlglot_exp.Schema):
                ref_node = inner.this
                ref_columns = [_identifier_name(i) for i in inner.expressions]
            else:
                ref_node = inner
            if isinstance(ref_node, sqlglot_exp.Table):
                ref_schema = _table_schema(ref_node) or self.target_schema
                ref_table = _identifier_name(ref_node)
        self.catalog.constraints.append(
            ConstraintInfo(
                kind="foreign-key",
                name=name,
                schema=schema,
                table=table,
                columns=[_identifier_name(i) for i in node.expressions],
                ref_schema=ref_schema,
                ref_table=ref_table,
                ref_columns=ref_columns,
                line=statement.start_line,
            )
        )

    # -- views

    def _catalogue_view(self, statement: Statement) -> None:
        # pg_dump emits matviews in a form sqlglot degrades to a Command, so the
        # producer normalises the two spellings into one before parsing.
        materialized = bool(
            re.search(r"\bmaterialized\s+view\b", statement.text[:120], re.I)
        )
        normalised = re.sub(
            r"\bmaterialized\s+view\b", "VIEW", statement.text, count=1, flags=re.I
        )
        normalised = re.sub(
            r"\bwith\s+no\s+data\s*$", "", normalised, flags=re.I
        ).strip()
        parsed = self._parse_one(normalised)
        if parsed is None:
            return
        target = parsed.this
        table_node = target.this if isinstance(target, sqlglot_exp.Schema) else target
        if not isinstance(table_node, sqlglot_exp.Table):
            return
        schema = _table_schema(table_node) or self.target_schema
        self.catalog.schemas_seen.add(schema)
        name = _identifier_name(table_node)
        if not self._in_scope(schema):
            self._record_out_of_scope("view", f"{schema}.{name}")
            return
        self.catalog.views[f"{schema}.{name}"] = ViewInfo(
            schema=schema,
            name=name,
            line=statement.start_line,
            select=parsed.expression,
            materialized=materialized,
        )

    # -- functions

    def _catalogue_function(self, statement: Statement) -> None:
        match = re.search(
            rf"\b(?:function|procedure)\s+((?:{_IDENT_RE}\s*\.\s*)?{_IDENT_RE})",
            statement.text,
            re.I,
        )
        if match is None:
            return
        schema, name = _split_qualified(match.group(1))
        schema = schema or self.target_schema
        self.catalog.schemas_seen.add(schema)

        # The Supabase variant quotes the language name: LANGUAGE "sql".
        language_match = re.search(
            r"\blanguage\s+(\"?)([A-Za-z0-9_]+)\1", statement.text, re.I
        )
        language = (language_match.group(2) if language_match else "sql").lower()
        returns_trigger = bool(
            re.search(r"\breturns\s+trigger\b", statement.text, re.I)
        )

        body, body_offset = _extract_body(statement.text)
        if body is None:
            return

        if not self._in_scope(schema):
            self._record_out_of_scope("function", f"{schema}.{name}")
            return

        self.catalog.functions.append(
            FunctionInfo(
                schema=schema,
                name=name,
                line=statement.start_line,
                language=language,
                body=body,
                body_line=statement.line_at(body_offset),
                returns_trigger=returns_trigger,
                parameters=_parameter_names(statement.text, match.end()),
            )
        )

    # -- triggers

    def _catalogue_trigger(self, statement: Statement) -> None:
        parsed = self._parse_one(statement.text)
        if parsed is None:
            return
        properties = parsed.find(sqlglot_exp.TriggerProperties)
        if properties is None:
            return
        table_node = properties.args.get("table")
        if not isinstance(table_node, sqlglot_exp.Table):
            return
        schema = _table_schema(table_node) or self.target_schema
        self.catalog.schemas_seen.add(schema)
        table = _identifier_name(table_node)
        name = _identifier_name(parsed.this)

        events: set[str] = set()
        event_columns: list[str] = []
        for event in properties.args.get("events") or []:
            events.add(str(event.this).upper())
            for column in event.args.get("columns") or []:
                event_columns.append(_identifier_name(column))

        execute = properties.args.get("execute")
        function = ""
        if isinstance(execute, sqlglot_exp.Expression):
            function_node = execute.this
            if isinstance(function_node, sqlglot_exp.Dot):
                function = (
                    f"{_identifier_name(function_node.this)}."
                    f"{_identifier_name(function_node.expression)}"
                )
            else:
                function = f"{self.target_schema}.{_identifier_name(function_node)}"

        if not self._in_scope(schema):
            self._record_out_of_scope("trigger", f"{schema}.{table}.{name}")
            return

        self.catalog.triggers.append(
            TriggerInfo(
                name=name,
                schema=schema,
                table=table,
                timing=str(properties.args.get("timing") or "").upper(),
                events=events,
                event_columns=event_columns,
                when_expr=properties.args.get("when"),
                function=function,
                line=statement.start_line,
            )
        )

    # -- policies

    def _catalogue_policy(self, statement: Statement) -> None:
        match = re.search(
            rf"\bpolicy\s+({_IDENT_RE})\s+on\s+((?:{_IDENT_RE}\s*\.\s*)?{_IDENT_RE})",
            statement.text,
            re.I,
        )
        if match is None:
            return
        name = fold_identifier(match.group(1))
        schema, table = _split_qualified(match.group(2))
        schema = schema or self.target_schema
        self.catalog.schemas_seen.add(schema)
        if not self._in_scope(schema):
            self._record_out_of_scope("policy", f"{schema}.{table}.{name}")
            return
        self.catalog.policies.append(
            PolicyInfo(
                name=name,
                schema=schema,
                table=table,
                using_expr=_balanced_after(statement.text, r"\busing\b"),
                check_expr=_balanced_after(statement.text, r"\bwith\s+check\b"),
                line=statement.start_line,
            )
        )

    # -- indexes

    def _catalogue_index(self, statement: Statement) -> None:
        parsed = self._parse_one(statement.text)
        if parsed is None:
            return
        index = parsed.this
        if not isinstance(index, sqlglot_exp.Index):
            return
        table_node = index.args.get("table")
        if not isinstance(table_node, sqlglot_exp.Table):
            return
        schema = _table_schema(table_node) or self.target_schema
        self.catalog.schemas_seen.add(schema)
        if not self._in_scope(schema):
            return
        params = index.args.get("params")
        columns: list[str] = []
        predicate = None
        if isinstance(params, sqlglot_exp.Expression):
            for ordered in params.args.get("columns") or []:
                node = (
                    ordered.this
                    if isinstance(ordered, sqlglot_exp.Ordered)
                    else ordered
                )
                if isinstance(node, sqlglot_exp.Column):
                    columns.append(_identifier_name(node))
            predicate = params.args.get("where")
        self.catalog.indexes.append(
            IndexInfo(
                name=_identifier_name(index.this),
                schema=schema,
                table=_identifier_name(table_node),
                columns=columns,
                predicate=predicate,
                line=statement.start_line,
            )
        )

    # -- alter table

    def _catalogue_alter_table(self, statement: Statement) -> None:
        text = statement.text
        target = re.search(
            rf"\balter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?"
            rf"((?:{_IDENT_RE}\s*\.\s*)?{_IDENT_RE})",
            text,
            re.I,
        )
        if target is None:
            return
        schema, table = _split_qualified(target.group(1))
        schema = schema or self.target_schema
        identity = f"{schema}.{table}"

        if re.search(r"\benable\s+row\s+level\s+security\b", text, re.I):
            self.catalog.rls_enabled.add(identity)
            return
        attach = re.search(
            rf"\battach\s+partition\s+((?:{_IDENT_RE}\s*\.\s*)?{_IDENT_RE})", text, re.I
        )
        if attach is not None:
            # The form pg_dump has emitted since PostgreSQL 12, and therefore
            # the one real dumps contain (corpus H2).
            child_schema, child = _split_qualified(attach.group(1))
            self.catalog.partitions[f"{child_schema or self.target_schema}.{child}"] = (
                identity
            )
            return
        disabled = re.search(rf"\bdisable\s+trigger\s+({_IDENT_RE})", text, re.I)
        if disabled is not None:
            target_name = fold_identifier(disabled.group(1))
            if target_name in DISABLE_TRIGGER_KEYWORDS:
                # ALL and USER are KEYWORDS. Recording one as a trigger NAME
                # leaves every real trigger enabled and exact, so the disable is
                # silently ignored (corpus C13).
                self.catalog.disabled_trigger_tables.add(identity)
            else:
                self.catalog.disabled_triggers.add((identity, target_name))
            return
        if not self._in_scope(schema):
            return

        parsed = self._parse_one(text)
        if not isinstance(parsed, sqlglot_exp.Alter):
            return
        for action in parsed.args.get("actions") or []:
            if isinstance(action, sqlglot_exp.AlterColumn):
                self._alter_column_default(action, identity, statement)
            elif isinstance(action, sqlglot_exp.AddConstraint):
                for wrapper in action.expressions:
                    if isinstance(wrapper, sqlglot_exp.Constraint):
                        self._added_constraint(wrapper, schema, table, statement)

    def _alter_column_default(
        self, action: sqlglot_exp.AlterColumn, identity: str, statement: Statement
    ) -> None:
        default = action.args.get("default")
        if not isinstance(default, sqlglot_exp.Expression):
            return
        info = self.catalog.tables.get(identity)
        if info is None:
            return
        column = _identifier_name(action.this)
        for existing in info.columns:
            if existing.name == column:
                existing.default_expr = default
                return
        info.columns.append(
            ColumnInfo(name=column, line=statement.start_line, default_expr=default)
        )

    def _added_constraint(
        self,
        wrapper: sqlglot_exp.Constraint,
        schema: str,
        table: str,
        statement: Statement,
    ) -> None:
        name = _identifier_name(wrapper.this)
        for constraint in wrapper.expressions:
            if isinstance(constraint, sqlglot_exp.ForeignKey):
                self._foreign_key(constraint, name, schema, table, statement)
            elif isinstance(constraint, sqlglot_exp.PrimaryKey):
                self._add_constraint(
                    "primary-key",
                    name,
                    schema,
                    table,
                    [_identifier_name(i) for i in constraint.expressions],
                    statement,
                )
            elif isinstance(constraint, sqlglot_exp.UniqueColumnConstraint):
                self._add_constraint(
                    "unique-constraint",
                    name,
                    schema,
                    table,
                    _schema_identifiers(constraint.this),
                    statement,
                )
            elif isinstance(constraint, sqlglot_exp.CheckColumnConstraint):
                info = self.catalog.tables.get(f"{schema}.{table}")
                if info is not None:
                    info.checks.append(constraint.this)

    # ── resolution ──────────────────────────────────────────────────────────

    def resolve(
        self, schema: str, name: str, *, count_unresolved: bool = True
    ) -> Resolution:
        """Resolve a table reference against the dump-local catalog.

        The sidecar row has no schema field, so an `auth.users` row would land on
        `public.users` as false-live evidence: references outside the target
        schema are excluded and counted (corpus G1/G2), and an unqualified name
        resolves against the TARGET schema only (corpus G3).
        """
        if not name:
            return UNRESOLVED
        key = (schema, name)
        cached = self._resolution_cache.get(key)
        if cached is not None:
            return cached
        resolution = self._resolve_uncached(schema, name, count_unresolved)
        self._resolution_cache[key] = resolution
        return resolution

    def _resolve_uncached(
        self, schema: str, name: str, count_unresolved: bool
    ) -> Resolution:
        if schema and schema != self.target_schema:
            self.caveats.out_of_scope_references += 1
            return Resolution(out_of_scope=True)
        identity = f"{self.target_schema}.{name}"

        parent = self.catalog.partitions.get(identity)
        if parent is not None:
            # Evidence against `orders_2024_01` must reach the parent `orders` or
            # it dies in `evidenceUnknownTables` and the parent reads unwired
            # (ratification note 3).
            self.caveats.partition_attribution[identity] = parent
            parent_schema, _, parent_name = parent.partition(".")
            if parent_schema == self.target_schema:
                return Resolution(
                    table=parent_name,
                    identity=parent,
                    method_suffix=f";partition:{identity}",
                    ok=True,
                )

        if identity in self.catalog.tables or identity in self.catalog.views:
            return Resolution(table=name, identity=identity, ok=True)

        if count_unresolved:
            self.caveats.unresolved_table_names[name] = (
                self.caveats.unresolved_table_names.get(name, 0) + 1
            )
        return UNRESOLVED

    # ── row emission ────────────────────────────────────────────────────────

    def emit(
        self,
        resolution: Resolution,
        column: str,
        direction: Direction,
        confidence: Confidence,
        method: str,
        line: int,
        source: str,
    ) -> None:
        if not resolution.ok or not column:
            return
        # Rows never name a view as `table`: the consumer merges bare names
        # against the target repo's generated types, where no view sits.
        view = self.catalog.views.get(resolution.identity)
        if view is not None:
            self._emit_through_view(
                view, column, direction, confidence, method, line, source
            )
            return
        row = EvidenceRow(
            table=resolution.table,
            column=column,
            direction=direction,
            confidence=confidence,
            method=method + resolution.method_suffix,
            file=self.file,
            line=line,
            source=source,
        )
        if row not in self._seen:
            self._seen.add(row)
            self.rows.append(row)

    def _emit_through_view(
        self,
        view: ViewInfo,
        column: str,
        direction: Direction,
        confidence: Confidence,
        method: str,
        line: int,
        source: str,
    ) -> None:
        """Chase a reference to a view through to its base tables (corpus D4)."""
        if view.identity in self._view_chase:
            return  # cycle-safe
        self._view_chase.append(view.identity)
        try:
            mapping = self._view_column_sources(view)
            if column == "*":
                targets = sorted({ref for refs in mapping.values() for ref in refs})
            else:
                targets = mapping.get(column, [])
            if targets:
                for source_schema, source_table, source_column in targets:
                    self.emit(
                        self.resolve(
                            source_schema, source_table, count_unresolved=False
                        ),
                        "*" if column == "*" else source_column,
                        direction,
                        confidence,
                        method,
                        line,
                        source,
                    )
                return
            # The view cannot map this output column to a source column — a
            # retained star projection, or an expression. Degrade to a
            # table-scoped row on each base table: silence would call those
            # columns untouched (corpus D6).
            degraded: Confidence = "wildcard" if direction == "read" else "indirect"
            for base_schema, base_table in self._view_base_tables(view):
                self.emit(
                    self.resolve(base_schema, base_table, count_unresolved=False),
                    "*",
                    direction,
                    degraded,
                    method,
                    line,
                    source,
                )
        finally:
            self._view_chase.pop()

    def _view_base_tables(self, view: ViewInfo) -> list[tuple[str, str]]:
        """(schema, table) for the tables each output branch of a view reads."""
        bases: list[tuple[str, str]] = []
        for branch in _output_selects(view.select):
            for _, schema, table in self._scope_for(branch):
                if (schema, table) not in bases:
                    bases.append((schema, table))
        return bases

    def _view_column_sources(
        self, view: ViewInfo
    ) -> dict[str, list[tuple[str, str, str]]]:
        """output column -> [(schema, table, source column)] for one view.

        A set operation contributes EVERY branch's source for one output column,
        which is what makes the D4 chase survive a UNION (corpus D5).
        """
        mapping: dict[str, list[tuple[str, str, str]]] = {}
        for branch in _output_selects(view.select):
            scope = self._scope_for(branch)
            for projection in branch.expressions:
                alias = None
                node = projection
                if isinstance(projection, sqlglot_exp.Alias):
                    alias = _identifier_name(projection.args.get("alias"))
                    node = projection.this
                for column_node in _columns_of(node):
                    name = _identifier_name(column_node)
                    schema, table = self._bind_column(column_node, scope)
                    if not table:
                        continue
                    entry = (schema, table, name)
                    bucket = mapping.setdefault(alias or name, [])
                    if entry not in bucket:
                        bucket.append(entry)
        return mapping

    # ── statement-level evidence ────────────────────────────────────────────

    def _scope_for(self, node) -> list[tuple[str, str, str]]:
        """(alias, schema, table) for the tables bound at THIS query level.

        Scope is per-SELECT. A nested subquery binds its own tables, so folding
        them into the outer scope binds an OUTER unqualified column to the
        SUBQUERY's table — false-live evidence there and silence on the table
        the column really belongs to (corpus E5).
        """
        scope: list[tuple[str, str, str]] = []
        for table_node in _walk_local(node, (sqlglot_exp.Select,)):
            if not isinstance(table_node, sqlglot_exp.Table):
                continue
            name = _identifier_name(table_node)
            if not name:
                continue
            alias_node = table_node.args.get("alias")
            alias = _identifier_name(alias_node) if alias_node else ""
            scope.append((alias or name, _table_schema(table_node), name))
        return scope

    def _is_known_column(self, resolution: Resolution, name: str) -> bool:
        """Does the resolved table declare this column in the dump's catalog?"""
        if not resolution.ok:
            return False
        table = self.catalog.tables.get(resolution.identity)
        if table is not None:
            return any(column.name == name for column in table.columns)
        view = self.catalog.views.get(resolution.identity)
        if view is not None:
            return name in self._view_column_sources(view)
        return False

    def _bind_column(self, column_node, scope) -> tuple[str, str]:
        """Bind a column to (schema, table) using its qualifier and the scope."""
        qualifier_node = column_node.args.get("table")
        qualifier = _identifier_name(qualifier_node) if qualifier_node else ""
        if qualifier:
            for alias, schema, table in scope:
                if qualifier in (alias, table):
                    return schema, table
            return "", qualifier
        if len(scope) == 1:
            _, schema, table = scope[0]
            return schema, table
        return "", ""

    def _emit_statement(self, parsed, ctx: "EvidenceContext") -> None:
        """Emit read/write rows for one parsed SQL statement."""
        if isinstance(parsed, sqlglot_exp.Insert):
            self._emit_insert(parsed, ctx)
        elif isinstance(parsed, sqlglot_exp.Update):
            self._emit_update(parsed, ctx)
        elif isinstance(parsed, sqlglot_exp.Delete):
            self._emit_delete(parsed, ctx)
        else:
            self._emit_reads(parsed, ctx)

    def _target_of(self, parsed) -> tuple[str, str, list[str]]:
        target = parsed.this
        columns: list[str] = []
        if isinstance(target, sqlglot_exp.Schema):
            columns = [_identifier_name(i) for i in target.expressions]
            target = target.this
        if not isinstance(target, sqlglot_exp.Table):
            return "", "", columns
        return _table_schema(target), _identifier_name(target), columns

    def _emit_insert(self, parsed, ctx: "EvidenceContext") -> None:
        schema, table, columns = self._target_of(parsed)
        if not table:
            return
        resolution = self.resolve(schema, table)
        if columns:
            for column in columns:
                self.emit(
                    resolution,
                    column,
                    "write",
                    ctx.cap("exact"),
                    ctx.method,
                    ctx.line,
                    ctx.source,
                )
        elif resolution.ok:
            # v1 does NOT join the table def to recover positional columns;
            # upgrading that attribution is a later measured change (corpus A4).
            self.caveats.positional_insert += 1
            self.emit(
                resolution, "*", "write", "indirect", ctx.method, ctx.line, ctx.source
            )
        source = parsed.expression
        if not isinstance(source, sqlglot_exp.Expression):
            return
        if isinstance(source, sqlglot_exp.Values):
            # `INSERT … VALUES (NEW.id, NEW.total)` is the dominant audit-trigger
            # idiom: the tuple carries the SOURCE table's reads, so skipping it
            # keeps the writes and silently loses every read (corpus C12).
            self._emit_column_reads(
                _columns_of(source), self._scope_for(parsed), ctx
            )
            return
        self._emit_reads(source, ctx)

    def _emit_update(self, parsed, ctx: "EvidenceContext") -> None:
        schema, table, _ = self._target_of(parsed)
        if not table:
            return
        resolution = self.resolve(schema, table)
        scope = self._scope_for(parsed)
        for assignment in parsed.expressions:
            if isinstance(assignment, sqlglot_exp.EQ) and isinstance(
                assignment.this, sqlglot_exp.Column
            ):
                self.emit(
                    resolution,
                    _identifier_name(assignment.this),
                    "write",
                    ctx.cap("exact"),
                    ctx.method,
                    ctx.line,
                    ctx.source,
                )
                self._emit_column_reads(
                    _columns_of(assignment.args.get("expression")), scope, ctx
                )
        for key in ("where", "from"):
            self._emit_column_reads(_columns_of(parsed.args.get(key)), scope, ctx)

    def _emit_delete(self, parsed, ctx: "EvidenceContext") -> None:
        self._emit_column_reads(
            _columns_of(parsed.args.get("where")), self._scope_for(parsed), ctx
        )

    def _emit_reads(self, parsed, ctx: "EvidenceContext") -> None:
        # Each SELECT level is processed with its OWN scope and its OWN columns,
        # so a set operation's branches and a subquery's tables never bleed into
        # one another (corpus D5, E5).
        levels = _selects_of(parsed)
        if not levels:
            self._emit_column_reads(_columns_of(parsed), self._scope_for(parsed), ctx)
            return
        outer = self._scope_for(parsed)
        for select in levels:
            scope = self._scope_for(select) or outer
            columns = [
                node
                for node in _walk_local(select, (sqlglot_exp.Select,))
                if isinstance(node, sqlglot_exp.Column)
            ]
            self._emit_column_reads(columns, scope, ctx)
            # A star in PROJECTION position is a read of every column;
            # `count(*)` is not (corpus A5 vs B2).
            if not any(isinstance(x, sqlglot_exp.Star) for x in select.expressions):
                continue
            if len(scope) == 1:
                _, schema, table = scope[0]
                self.emit(
                    self.resolve(schema, table),
                    "*",
                    "read",
                    "wildcard",
                    ctx.method,
                    ctx.line,
                    ctx.source,
                )

    def _emit_column_reads(self, columns, scope, ctx: "EvidenceContext") -> None:
        for column_node in columns:
            name = _identifier_name(column_node)
            qualifier_node = column_node.args.get("table")
            qualifier = _identifier_name(qualifier_node) if qualifier_node else ""

            # Trigger-record references attribute through the function's
            # bindings, never through the statement scope.
            if ctx.record is not None:
                if qualifier in TRIGGER_ROW_KEYWORDS:
                    ctx.record.emit_read(self, name, qualifier, ctx)
                    continue
                if not qualifier and name.lower() in TRIGGER_ROW_KEYWORDS:
                    # `to_jsonb(NEW)` — a whole-row use. Never silence (C10).
                    ctx.record.emit_read(self, "*", name.lower(), ctx)
                    continue

            schema, table = self._bind_column(column_node, scope)
            # CATALOG-FIRST. An unqualified identifier that names a known column
            # of a candidate table IS that column, even when a parameter shadows
            # it — suppressing it would be evidence suppression, which fails in
            # the false-dead direction. Only a non-column that names a bound
            # parameter or DECLAREd variable is a variable, and a bound variable
            # is not blindness, so it emits no row and no caveat (corpus B6-B8).
            # The check spans EVERY candidate table, because the ambiguous path
            # below emits one row per candidate and would otherwise fabricate on
            # all of them at once (corpus B10).
            if not qualifier and fold_identifier(name) in ctx.variables:
                if table:
                    candidates = [self.resolve(schema, table)]
                else:
                    candidates = [
                        self.resolve(
                            candidate_schema, candidate, count_unresolved=False
                        )
                        for _, candidate_schema, candidate in scope
                    ]
                if not any(
                    self._is_known_column(candidate, name) for candidate in candidates
                ):
                    continue
            if table:
                resolution = self.resolve(schema, table)
                self.emit(
                    resolution,
                    name,
                    "read",
                    ctx.cap("exact"),
                    ctx.method,
                    ctx.line,
                    ctx.source,
                )
                continue
            if ctx.implicit_table is not None:
                self.emit(
                    ctx.implicit_table,
                    name,
                    "read",
                    ctx.cap("exact"),
                    ctx.method,
                    ctx.line,
                    ctx.source,
                )
            elif len(scope) > 1:
                # Mis-binding `id` in a join is the G8 failure by another route:
                # never exact, and always said out loud.
                self.caveats.ambiguous_column_bindings.append(
                    {
                        "object": ctx.method,
                        "line": ctx.line,
                        "column": name,
                        "tables": sorted({t for _, _, t in scope}),
                    }
                )
                for _, candidate_schema, candidate in scope:
                    self.emit(
                        self.resolve(
                            candidate_schema, candidate, count_unresolved=False
                        ),
                        name,
                        "read",
                        "indirect",
                        ctx.method,
                        ctx.line,
                        ctx.source,
                    )
            # An unqualified identifier with no table context at all is a
            # PL/pgSQL VARIABLE, not a column: no row, and no caveat either.

    # ── pass 2: evidence per object class ───────────────────────────────────

    def _extract_evidence(self) -> None:
        bindings = self._trigger_bindings()
        for function in self.catalog.functions:
            self._function_evidence(function, bindings.get(function.identity, []))
        for trigger in self.catalog.triggers:
            self._trigger_evidence(trigger)
        for view in self.catalog.views.values():
            self._view_evidence(view)
        for policy in self.catalog.policies:
            self._policy_evidence(policy)
        self._furniture_evidence()

    def _trigger_bindings(self) -> dict[str, list[TriggerInfo]]:
        bindings: dict[str, list[TriggerInfo]] = {}
        for trigger in self.catalog.triggers:
            table_identity = f"{trigger.schema}.{trigger.table}"
            trigger.enabled = (
                table_identity,
                trigger.name,
            ) not in self.catalog.disabled_triggers and (
                table_identity not in self.catalog.disabled_trigger_tables
            )
            bindings.setdefault(trigger.function, []).append(trigger)
        return bindings

    # -- function bodies

    def _function_evidence(
        self, function: FunctionInfo, triggers: list[TriggerInfo]
    ) -> None:
        if function.language not in SUPPORTED_BODY_LANGUAGES:
            self.caveats.unsupported_language_bodies[function.language] = (
                self.caveats.unsupported_language_bodies.get(function.language, 0) + 1
            )
            return

        record = TriggerRecordBinding.build(self, function, triggers)
        ctx = EvidenceContext(
            method=f"function-body:{function.identity}",
            source="function-body",
            line=function.body_line,
            confidence_cap=record.confidence_cap,
            record=record,
            variables=(
                function.parameters
                | _declared_variables(function.body)
                | PLPGSQL_BUILTIN_VARIABLES
            ),
        )
        if function.language == "sql":
            self._sql_body_evidence(function, ctx)
        else:
            self._plpgsql_body_evidence(function, ctx)

        if record.unbound and record.referenced:
            # Blindness attributable to no table: it can carry no row, so it is
            # counted, and it blocks narrowing (corpus C11, design §6).
            if function.identity not in self.caveats.unbound_trigger_functions:
                self.caveats.unbound_trigger_functions.append(function.identity)

    def _sql_body_evidence(
        self, function: FunctionInfo, ctx: "EvidenceContext"
    ) -> None:
        for statement in split_statements(function.body):
            line = function.body_line + statement.start_line - 1
            self._parse_and_emit(statement.text, ctx.at(line), function.identity)

    def _plpgsql_body_evidence(
        self, function: FunctionInfo, ctx: "EvidenceContext"
    ) -> None:
        isolated = parsed_count = control_flow = 0
        for unit in isolate_plpgsql(function.body, function.body_line):
            if unit.kind == "control-flow":
                control_flow += 1
                continue
            if unit.kind == "dynamic":
                # `EXECUTE` of a constructed string: smoke, never attribution.
                self.caveats.dynamic_sql += 1
                control_flow += 1
                continue
            if unit.kind == "record-write":
                isolated += 1
                parsed_count += 1
                if ctx.record is not None:
                    ctx.record.emit_write(self, unit.text, ctx.at(unit.line))
                continue
            isolated += 1
            text = unit.text if unit.kind == "statement" else f"SELECT {unit.text}"
            if self._parse_and_emit(
                text, ctx.at(unit.line), function.identity, unit.text
            ):
                parsed_count += 1
        self.caveats.plpgsql_statement_accounting.append(
            {
                "object": function.identity,
                "isolated": isolated,
                "parsed": parsed_count,
                "controlFlowSkipped": control_flow,
            }
        )

    def _parse_and_emit(
        self,
        text: str,
        ctx: "EvidenceContext",
        object_identity: str,
        raw: str | None = None,
    ) -> bool:
        self._new_resolution_scope()
        try:
            statements = sqlglot.parse(text, read="postgres")
        except Exception:
            statements = None
        # An opaque `Command` is sqlglot saying it did not understand the
        # statement, which is the same blindness as a ParseError.
        usable = [
            statement
            for statement in (statements or [])
            if statement is not None
            and not isinstance(statement, sqlglot_exp.Command)
        ]
        if not usable:
            self._unparsed(raw if raw is not None else text, ctx, object_identity)
            return False
        for statement in usable:
            self._emit_statement(statement, ctx)
        return True

    def _unparsed(
        self, text: str, ctx: "EvidenceContext", object_identity: str
    ) -> None:
        """Record an isolated-but-unparseable statement, loudly.

        Where the blindness is attributable to a TABLE it becomes a table-scoped
        `*` row so those columns land in `undecidable` rather than `unwired`
        (design §6 rule 2, corpus B5).
        """
        self.caveats.unparsed_statements.append(
            {"object": object_identity, "line": ctx.line, "statement": _condense(text)}
        )
        target = re.search(
            rf"\b(insert\s+into|update|delete\s+from|from)\s+"
            rf"((?:{_IDENT_RE}\s*\.\s*)?{_IDENT_RE})",
            text,
            re.I,
        )
        if target is None:
            return
        verb = re.sub(r"\s+", " ", target.group(1).lower())
        schema, table = _split_qualified(target.group(2))
        direction: Direction = "read" if verb == "from" else "write"
        self.emit(
            self.resolve(schema, table),
            "*",
            direction,
            "indirect",
            ctx.method,
            ctx.line,
            ctx.source,
        )

    # -- triggers

    def _trigger_evidence(self, trigger: TriggerInfo) -> None:
        self._new_resolution_scope()
        resolution = self.resolve(trigger.schema, trigger.table, count_unresolved=False)
        if not resolution.ok:
            return
        if not trigger.enabled:
            self.caveats.disabled_objects.append(
                {
                    "kind": "trigger",
                    "object": trigger.identity,
                    "reason": "disabled-trigger",
                }
            )
        confidence: Confidence = "exact" if trigger.enabled else "indirect"

        when = trigger.when_expr
        if isinstance(when, sqlglot_exp.Expression):
            # A WHEN clause is evaluated at fire time — a genuine read.
            method = f"trigger-when:{trigger.identity}"
            for column_node in _columns_of(when):
                self.emit(
                    resolution,
                    _identifier_name(column_node),
                    "read",
                    confidence,
                    method,
                    trigger.line,
                    "trigger",
                )

        # `UPDATE OF col` is a FIRING CONDITION, not an access: it fires on the
        # column's mention in a SET list and reads nothing (design §4).
        for column in trigger.event_columns:
            self.emit(
                resolution,
                column,
                "read",
                "indirect",
                f"trigger-event:{trigger.identity}",
                trigger.line,
                "trigger",
            )

    # -- views

    def _view_evidence(self, view: ViewInfo) -> None:
        if not isinstance(view.select, sqlglot_exp.Expression):
            return
        self._new_resolution_scope()
        self._emit_reads(
            view.select,
            EvidenceContext(
                method=f"view-definition:{view.identity}",
                source="view",
                line=view.line,
            ),
        )

    # -- policies

    def _policy_evidence(self, policy: PolicyInfo) -> None:
        self._new_resolution_scope()
        resolution = self.resolve(policy.schema, policy.table, count_unresolved=False)
        if not resolution.ok:
            return
        # A policy on a table without ENABLE ROW LEVEL SECURITY never executes.
        enabled = f"{policy.schema}.{policy.table}" in self.catalog.rls_enabled
        if not enabled:
            self.caveats.disabled_objects.append(
                {"kind": "policy", "object": policy.identity, "reason": "rls-disabled"}
            )
        ctx = EvidenceContext(
            method=f"rls-policy:{policy.identity}",
            source="policy",
            line=policy.line,
            confidence_cap="exact" if enabled else "indirect",
            implicit_table=resolution,
        )
        for expression in (policy.using_expr, policy.check_expr):
            if not expression:
                continue
            parsed = self._parse_one(f"SELECT {expression}")
            if parsed is not None:
                self._emit_reads(parsed, ctx)

    # -- furniture (tier 2)

    def _furniture_evidence(self) -> None:
        self._new_resolution_scope()
        for table in self.catalog.tables.values():
            # Routed through resolve() rather than constructed directly, so a
            # partition CHILD's own furniture reaches the parent too. Under the
            # ATTACH form the child carries a full column list, and a row naming
            # it would die in `evidenceUnknownTables` (ratification note 3).
            resolution = self.resolve(
                table.schema, table.name, count_unresolved=False
            )
            for column in table.columns:
                self._column_furniture(resolution, table, column)
            for check in table.checks:
                for column_node in _columns_of(check):
                    self.emit(
                        resolution,
                        _identifier_name(column_node),
                        "read",
                        "indirect",
                        f"check-constraint:{table.identity}",
                        table.line,
                        "furniture",
                    )

        for index in self.catalog.indexes:
            resolution = self.resolve(index.schema, index.table, count_unresolved=False)
            # The index — not its table — is the object a drops ledger would
            # drop, so it is the identity the ref carries.
            method = f"index:{index.schema}.{index.name}"
            for column in index.columns:
                self.emit(
                    resolution,
                    column,
                    "read",
                    "indirect",
                    method,
                    index.line,
                    "furniture",
                )
            for column_node in _columns_of(index.predicate):
                self.emit(
                    resolution,
                    _identifier_name(column_node),
                    "read",
                    "indirect",
                    method,
                    index.line,
                    "furniture",
                )

        for constraint in self.catalog.constraints:
            self._constraint_furniture(constraint)

    def _column_furniture(
        self, resolution: Resolution, table: TableInfo, column: ColumnInfo
    ) -> None:
        if column.default_expr is not None:
            # A column populated only by its own DEFAULT under NOT NULL is
            # executed structure: "I looked and I cannot tell" is the only
            # verdict that does not break every insert the day a drops ledger
            # trusts an `unwired`.
            self.emit(
                resolution,
                column.name,
                "write",
                "indirect",
                f"column-default:{table.identity}",
                column.line,
                "furniture",
            )
        elif column.generated_expr is not None:
            self.emit(
                resolution,
                column.name,
                "write",
                "indirect",
                f"generated-column:{table.identity}",
                column.line,
                "furniture",
            )
        elif column.not_null:
            # §4 lists "its NOT NULL" as tier 2: every insert must supply the
            # column, so `undecidable` is the honest verdict for a column with
            # no other trace. A NOT NULL column that HAS a default is already
            # carried by its column-default row, which is why this is an `elif`
            # rather than a second row (corpus F1 vs F9).
            self.emit(
                resolution,
                column.name,
                "read",
                "indirect",
                f"not-null:{table.identity}.{column.name}",
                column.line,
                "furniture",
            )
        if column.generated_expr is not None:
            for source_column in _columns_of(column.generated_expr):
                self.emit(
                    resolution,
                    _identifier_name(source_column),
                    "read",
                    "indirect",
                    f"generated-column:{table.identity}",
                    column.line,
                    "furniture",
                )

    def _constraint_furniture(self, constraint: ConstraintInfo) -> None:
        resolution = self.resolve(
            constraint.schema, constraint.table, count_unresolved=False
        )
        if constraint.kind == "foreign-key":
            method = f"foreign-key:{constraint.schema}.{constraint.table}"
        else:
            method = f"{constraint.kind}:{constraint.schema}.{constraint.name}"
        for column in constraint.columns:
            self.emit(
                resolution,
                column,
                "read",
                "indirect",
                method,
                constraint.line,
                "furniture",
            )
        # The one furniture class whose rows land on a DIFFERENT table than the
        # object that owns them (ratification note 5).
        if constraint.kind == "foreign-key" and constraint.ref_table:
            referenced = self.resolve(
                constraint.ref_schema, constraint.ref_table, count_unresolved=False
            )
            for column in constraint.ref_columns:
                self.emit(
                    referenced,
                    column,
                    "read",
                    "indirect",
                    method,
                    constraint.line,
                    "furniture",
                )

    # ── output ──────────────────────────────────────────────────────────────

    def _sidecar(self) -> dict[str, object]:
        headers = [
            line.strip()
            for line in self.text.splitlines()
            if line.strip().startswith(DUMP_VERSION_HEADER_PREFIXES)
        ]
        mtime = datetime.fromtimestamp(self.path.stat().st_mtime, tz=timezone.utc)
        rows = sorted(
            self.rows,
            key=lambda row: (
                row.table,
                row.column,
                row.direction,
                row.method,
                row.line,
            ),
        )
        return {
            "schemaVersion": SIDECAR_SCHEMA_VERSION,
            "source": SIDECAR_SOURCE,
            "generatedBy": GENERATED_BY,
            "sqlglot": True,
            # A plain dump carries no timestamp, so snapshot identity is the
            # file's mtime plus the version header lines (design §7).
            "snapshot": {
                "path": self.file,
                "mtimeIso": mtime.isoformat(),
                "headers": headers,
            },
            # Caveats count what was SEEN and are silent about what was never in
            # the file, so the inventory is what stops a truncated or
            # under-privileged dump from merging clean (design §6 rule 1).
            "objectsFound": {
                "tables": len(self.catalog.tables),
                "functions": len(self.catalog.functions),
                "views": len(self.catalog.views),
                "policies": len(self.catalog.policies),
                "triggers": len(self.catalog.triggers),
            },
            "rows": [row.to_json() for row in rows],
            "caveats": self.caveats.to_json(),
        }


# ── Trigger-record attribution ──────────────────────────────────────────────


@dataclass
class TriggerRecordBinding:
    """How a function body's NEW./OLD. references reach a table, if at all."""

    tables: list[Resolution] = field(default_factory=list)
    new_available: bool = False
    old_available: bool = False
    writable: bool = False  # a BEFORE / INSTEAD OF binding exists
    confidence: Confidence = "exact"
    confidence_cap: Confidence = "exact"
    unbound: bool = True
    referenced: bool = False

    @classmethod
    def build(
        cls,
        analyser: "DumpAnalyser",
        function: FunctionInfo,
        triggers: list[TriggerInfo],
    ) -> "TriggerRecordBinding":
        binding = cls()
        if not triggers:
            return binding
        binding.unbound = False

        identities: dict[str, Resolution] = {}
        for trigger in triggers:
            analyser._new_resolution_scope()
            resolution = analyser.resolve(
                trigger.schema, trigger.table, count_unresolved=False
            )
            if resolution.ok:
                identities[resolution.identity] = resolution
            # `NEW` exists for INSERT/UPDATE and `OLD` for UPDATE/DELETE —
            # attribution is per trigger event (corpus C9).
            if trigger.events & {"INSERT", "UPDATE"}:
                binding.new_available = True
                if trigger.timing in {"BEFORE", "INSTEAD OF"}:
                    binding.writable = True
            if trigger.events & {"UPDATE", "DELETE"}:
                binding.old_available = True
        binding.tables = list(identities.values())

        if all(not trigger.enabled for trigger in triggers):
            # A disabled trigger never fires, so the tier-1 "when it runs"
            # condition fails — the trigger analogue of the RLS gate. The
            # disabled TRIGGER is what `disabledObjects` records (once, from
            # _trigger_evidence); the function's rows are only capped.
            binding.confidence = "indirect"
            binding.confidence_cap = "indirect"

        if len(binding.tables) > 1:
            # Attributing one body's NEW.order_no as exact to every bound table
            # is attribution invariant in the thing it attributes — G8's
            # fingerprint on the SQL side.
            binding.confidence = "indirect"
            analyser.caveats.multi_table_bound_functions[function.identity] = [
                resolution.identity for resolution in binding.tables
            ]
        return binding

    def available(self, qualifier: str) -> bool:
        if qualifier == "new":
            return self.new_available
        if qualifier == "old":
            return self.old_available
        return self.new_available or self.old_available

    def emit_read(
        self,
        analyser: "DumpAnalyser",
        column: str,
        qualifier: str,
        ctx: "EvidenceContext",
    ) -> None:
        self.referenced = True
        if not self.available(qualifier):
            return  # NEW is null in DELETE triggers and OLD in INSERT triggers
        confidence = self.confidence
        if column == "*" and confidence == "exact":
            confidence = "wildcard"
        for resolution in self.tables:
            analyser.emit(
                resolution, column, "read", confidence, ctx.method, ctx.line, ctx.source
            )

    def emit_write(
        self, analyser: "DumpAnalyser", column: str, ctx: "EvidenceContext"
    ) -> None:
        self.referenced = True
        # `NEW.col := …` in an AFTER trigger is inert and must not emit a write.
        if not self.writable or not self.new_available:
            return
        for resolution in self.tables:
            analyser.emit(
                resolution,
                column,
                "write",
                self.confidence,
                ctx.method,
                ctx.line,
                ctx.source,
            )


@dataclass
class EvidenceContext:
    """Where a row came from, and how strong it is allowed to be."""

    method: str
    source: str
    line: int
    confidence_cap: Confidence = "exact"
    implicit_table: Resolution | None = None
    record: TriggerRecordBinding | None = None
    # Parameter and DECLAREd variable names bound by the containing function.
    variables: frozenset[str] = frozenset()

    def cap(self, confidence: Confidence) -> Confidence:
        if self.confidence_cap == "indirect" and confidence == "exact":
            return "indirect"
        return confidence

    def at(self, line: int) -> "EvidenceContext":
        return EvidenceContext(
            method=self.method,
            source=self.source,
            line=line,
            confidence_cap=self.confidence_cap,
            implicit_table=self.implicit_table,
            record=self.record,
            variables=self.variables,
        )


# ── PL/pgSQL isolation ──────────────────────────────────────────────────────


@dataclass(frozen=True)
class PlpgsqlUnit:
    kind: str  # statement | expression | control-flow | dynamic | record-write
    text: str
    line: int


def isolate_plpgsql(body: str, body_line: int) -> list[PlpgsqlUnit]:
    """Split a PL/pgSQL body into parseable SQL units plus skipped scaffolding.

    PL/pgSQL is not a SQL dialect, so the producer isolates the embedded SQL
    from the procedural frame and parses each piece individually. Control flow
    is skipped AND counted (design §6) — and an IF CONDITION is not control
    flow: `IF NEW.title IS DISTINCT FROM OLD.title` is a genuine read.
    """
    units: list[PlpgsqlUnit] = []
    in_declarations = False
    for fragment in split_statements(body):
        text = fragment.text.strip()
        line = body_line + fragment.start_line - 1
        if not text:
            continue
        lowered = text.lower()
        if lowered.startswith("declare"):
            in_declarations = True
            text = text[len("declare") :].strip()
            if not text:
                units.append(PlpgsqlUnit("control-flow", "declare", line))
                continue
        elif re.match(r"^begin\b", lowered):
            in_declarations = False

        if in_declarations:
            # A declaration is scaffolding, but its initialiser may still carry
            # column refs in expression position.
            units.append(PlpgsqlUnit("control-flow", text, line))
            assignment = _split_assignment(text)
            if assignment is not None and assignment[1]:
                units.append(PlpgsqlUnit("expression", assignment[1], line))
            continue

        units.extend(_decompose(text, line))
    return units


def _decompose(text: str, base_line: int) -> Iterator[PlpgsqlUnit]:
    """Strip leading control-flow prefixes, yielding the SQL units inside.

    Each unit carries the line where IT starts, not the line of the fragment
    that contains it — `BEGIN` and the statement under it are usually on
    different lines, and a ref that names the block opener instead of the
    statement is a ref pointing at the wrong place.
    """
    original = text.strip()
    remaining = original
    guard = 0
    while remaining and guard < 20:
        guard += 1
        # `remaining` is always a suffix of `original`, so the consumed prefix
        # is what separates the unit's line from the fragment's.
        line = base_line + original[: len(original) - len(remaining)].count("\n")
        lowered = remaining.lower()

        if re.match(r"^begin\b", lowered):
            yield PlpgsqlUnit("control-flow", "begin", line)
            remaining = remaining[len("begin") :].strip()
            continue
        if re.match(r"^end\b", lowered):
            yield PlpgsqlUnit("control-flow", remaining, line)
            return
        if re.match(r"^(loop|else)\b", lowered):
            keyword = "loop" if lowered.startswith("loop") else "else"
            yield PlpgsqlUnit("control-flow", keyword, line)
            remaining = remaining[len(keyword) :].strip()
            continue
        if re.match(r"^(if|elsif|elseif|while|when)\b", lowered):
            keyword_length = len(re.match(r"^\w+", remaining).group(0))
            condition, rest = _split_on_keyword(remaining, ("then", "loop"))
            condition = condition[keyword_length:].strip()
            yield PlpgsqlUnit("control-flow", "if", line)
            if condition:
                yield PlpgsqlUnit("expression", condition, line)
            remaining = rest.strip()
            continue
        if re.match(r"^exception\b", lowered):
            # `EXCEPTION` opens the handler section; the arms that follow are
            # `WHEN … THEN <statement>` and the statement is real executing SQL.
            # Swallowing the whole fragment loses every write in the handler,
            # and error-log tables are written from nowhere else (corpus B9).
            yield PlpgsqlUnit("control-flow", "exception", line)
            remaining = remaining[len("exception") :].strip()
            continue
        if re.match(r"^case\b", lowered):
            yield PlpgsqlUnit("control-flow", remaining, line)
            return
        if re.match(r"^execute\b", lowered):
            yield PlpgsqlUnit("dynamic", remaining, line)
            return
        if re.match(r"^perform\b", lowered):
            yield PlpgsqlUnit("expression", remaining[len("perform") :].strip(), line)
            return
        if re.match(r"^return\s+query\b", lowered):
            yield PlpgsqlUnit(
                "statement", remaining[len("return query") :].strip(), line
            )
            return
        if re.match(r"^return\b", lowered):
            operand = remaining[len("return") :].strip()
            # `RETURN NEW;` is the mandatory trigger boilerplate, not a whole-row
            # read: treating it as one would make every trigger-bound table
            # collect a spurious `*` read from a statement that reads nothing.
            if not operand or _BARE_NAME_RE.match(operand):
                yield PlpgsqlUnit("control-flow", "return", line)
            else:
                yield PlpgsqlUnit("expression", operand, line)
            return
        if any(
            re.match(rf"^{re.escape(prefix)}\b", lowered)
            for prefix in PLPGSQL_CONTROL_FLOW_PREFIXES
        ):
            yield PlpgsqlUnit("control-flow", remaining, line)
            return

        assignment = _split_assignment(remaining)
        if assignment is not None:
            target, value = assignment
            record = re.match(r"^(new|old)\s*\.\s*(\"?[\w$]+\"?)$", target, re.I)
            if record is not None:
                yield PlpgsqlUnit(
                    "record-write", fold_identifier(record.group(2)), line
                )
            else:
                yield PlpgsqlUnit("control-flow", f"assign {target}", line)
            if value:
                yield PlpgsqlUnit("expression", value, line)
            return

        yield PlpgsqlUnit("statement", remaining, line)
        return


def _split_assignment(text: str) -> tuple[str, str] | None:
    """Split `target := value` at depth 0, respecting quotes and parens."""
    depth = 0
    index = 0
    length = len(text)
    while index < length:
        char = text[index]
        if char in "'\"":
            index = _skip_quoted(text, index, char)
            continue
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        elif char == ":" and depth == 0 and text.startswith(":=", index):
            return text[:index].strip(), text[index + 2 :].strip()
        index += 1
    # PL/pgSQL accepts `=` as an assignment operator too, and pg_dump preserves
    # whichever the author wrote. Only the ANCHORED form counts — a statement
    # cannot begin with a comparison — so `UPDATE t SET a = 1` is untouched
    # while `NEW.updated_at = now()` is the write it really is (corpus C14).
    anchored = _ANCHORED_ASSIGNMENT_RE.match(text)
    if anchored is not None:
        return anchored.group(1).strip(), anchored.group(2).strip()
    return None


def _split_on_keyword(text: str, keywords: tuple[str, ...]) -> tuple[str, str]:
    """Split at the first depth-0 occurrence of any keyword."""
    depth = 0
    index = 0
    length = len(text)
    while index < length:
        char = text[index]
        if char in "'\"":
            index = _skip_quoted(text, index, char)
            continue
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        elif depth == 0:
            for keyword in keywords:
                end = index + len(keyword)
                if (
                    text[index:end].lower() == keyword
                    and (index == 0 or not _is_word_char(text[index - 1]))
                    and (end >= length or not _is_word_char(text[end]))
                ):
                    return text[:index], text[end:]
        index += 1
    return text, ""


def _skip_quoted(text: str, index: int, quote: str) -> int:
    """Index just past the quoted run starting at `index`."""
    length = len(text)
    index += 1
    while index < length:
        if text[index] == quote:
            if index + 1 < length and text[index + 1] == quote:
                index += 2
                continue
            return index + 1
        index += 1
    return index


def _is_word_char(char: str) -> bool:
    return char.isalnum() or char == "_"


# ── small helpers ───────────────────────────────────────────────────────────


def _extract_body(text: str) -> tuple[str | None, int]:
    """The function body plus its offset within the statement.

    Three spellings: dollar-quoted (the pg_dump default), the PG14+ SQL-standard
    `BEGIN ATOMIC … END` form, and a single-quoted literal. The atomic form is
    checked first because its body is plain SQL that may itself contain a
    dollar-quoted literal.
    """
    atomic = _BEGIN_ATOMIC_RE.search(text)
    if atomic is not None:
        end = None
        for candidate in _END_KEYWORD_RE.finditer(text, atomic.end()):
            end = candidate
        stop = end.start() if end is not None else len(text)
        return text[atomic.end() : stop], atomic.end()
    for match in _DOLLAR_TAG_RE.finditer(text):
        tag = match.group(0)
        close = text.find(tag, match.end())
        if close == -1:
            continue
        return text[match.end() : close], match.end()
    literal = re.search(r"\bas\s+'", text, re.I)
    if literal is not None:
        start = literal.end()
        end = text.find("'", start)
        if end != -1:
            return text[start:end], start
    return None, 0


def _parameter_names(text: str, start: int) -> frozenset[str]:
    """Named parameters of a CREATE FUNCTION argument list.

    A parameter is `[IN|OUT|INOUT|VARIADIC] name type [DEFAULT expr]`, but the
    name is OPTIONAL — `f(uuid)` and `f(timestamp with time zone)` declare
    types only. Reading the leading word of an unnamed parameter as a name
    would let a type keyword suppress a real column, so a leading word that is
    a type keyword is treated as the type it is.
    """
    open_paren = text.find("(", start)
    if open_paren == -1:
        return frozenset()
    depth = 0
    index = open_paren
    while index < len(text):
        char = text[index]
        if char in "'\"":
            index = _skip_quoted(text, index, char)
            continue
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                break
        index += 1
    else:
        return frozenset()

    names: set[str] = set()
    for argument in _split_top_level(text[open_paren + 1 : index], ","):
        words = argument.split()
        if len(words) < 2:
            continue  # a bare type, so this parameter has no name
        if words[0].upper() in PARAMETER_MODES:
            words = words[1:]
            if len(words) < 2:
                continue
        candidate = words[0]
        if candidate.lower() in TYPE_LEADING_KEYWORDS:
            continue
        if candidate.startswith('"') or _BARE_NAME_RE.match(candidate):
            names.add(fold_identifier(candidate))
    return frozenset(names)


def _declared_variables(body: str) -> frozenset[str]:
    """Variable names bound by a PL/pgSQL body's DECLARE sections."""
    names: set[str] = set()
    in_declarations = False
    for fragment in split_statements(body):
        text = fragment.text.strip()
        lowered = text.lower()
        if lowered.startswith("declare"):
            in_declarations = True
            text = text[len("declare") :].strip()
            if not text:
                continue
        elif re.match(r"^begin\b", lowered):
            in_declarations = False
            continue
        if not in_declarations:
            continue
        words = text.split()
        if words and (words[0].startswith('"') or _BARE_NAME_RE.match(words[0])):
            names.add(fold_identifier(words[0]))
    return frozenset(names)


def _split_top_level(text: str, separator: str) -> list[str]:
    """Split on a separator that is not inside parens or quotes."""
    parts: list[str] = []
    depth = 0
    current = 0
    index = 0
    while index < len(text):
        char = text[index]
        if char in "'\"":
            index = _skip_quoted(text, index, char)
            continue
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        elif char == separator and depth == 0:
            parts.append(text[current:index].strip())
            current = index + 1
        index += 1
    parts.append(text[current:].strip())
    return [part for part in parts if part]


def _balanced_after(text: str, keyword_pattern: str) -> str | None:
    """The parenthesised expression following a keyword, parens balanced."""
    match = re.search(keyword_pattern, text, re.I)
    if match is None:
        return None
    index = match.end()
    while index < len(text) and text[index].isspace():
        index += 1
    if index >= len(text) or text[index] != "(":
        return None
    depth = 0
    start = index
    while index < len(text):
        if text[index] == "(":
            depth += 1
        elif text[index] == ")":
            depth -= 1
            if depth == 0:
                return text[start : index + 1]
        index += 1
    return None


def _schema_identifiers(node) -> list[str]:
    """Column names inside a `Schema(expressions=[Identifier, …])` wrapper."""
    if not isinstance(node, sqlglot_exp.Schema):
        return []
    return [_identifier_name(identifier) for identifier in node.expressions]


def _set_operation_types() -> tuple[type, ...]:
    """The set-operation node types this sqlglot build exposes."""
    names = ("SetOperation", "Union", "Except", "Intersect")
    found = tuple(
        getattr(sqlglot_exp, name) for name in names if hasattr(sqlglot_exp, name)
    )
    return found or (sqlglot_exp.Union,)


def _output_selects(node) -> list:
    """The SELECTs whose projections form a query's OUTPUT columns.

    A plain SELECT is its own output; a set operation's output is every branch;
    a subquery wrapper delegates. Nested subqueries in a FROM are NOT output —
    they belong to their own level.
    """
    if not isinstance(node, sqlglot_exp.Expression):
        return []
    if isinstance(node, sqlglot_exp.Select):
        return [node]
    if isinstance(node, sqlglot_exp.Subquery):
        return _output_selects(node.this)
    if isinstance(node, _set_operation_types()):
        return _output_selects(node.this) + _output_selects(node.args.get("expression"))
    return []


def _walk_local(root, stop: tuple[type, ...]):
    """Yield nodes under `root` without descending into `stop` node types.

    This is what makes scope per-SELECT: a nested query's contents belong to
    that query level, not to the one enclosing it.
    """
    if not isinstance(root, sqlglot_exp.Expression):
        return
    stack = [root]
    while stack:
        node = stack.pop()
        yield node
        for value in node.args.values():
            items = value if isinstance(value, list) else [value]
            for item in items:
                if isinstance(item, sqlglot_exp.Expression) and not isinstance(
                    item, stop
                ):
                    stack.append(item)


def _columns_of(node) -> list:
    # sqlglot uses False (not None) as the default for absent optional args —
    # `TriggerProperties["when"]` on a trigger with no WHEN clause, for one.
    if not isinstance(node, sqlglot_exp.Expression):
        return []
    if isinstance(node, sqlglot_exp.Column):
        return [node]
    return list(node.find_all(sqlglot_exp.Column))


def _selects_of(node) -> list:
    if not isinstance(node, sqlglot_exp.Expression):
        return []
    if isinstance(node, sqlglot_exp.Select):
        return [node] + [s for s in node.find_all(sqlglot_exp.Select) if s is not node]
    return list(node.find_all(sqlglot_exp.Select))


def _line_of_column(statement: Statement, name: str) -> int:
    """The dump line a column definition sits on, for a precise furniture ref."""
    target = name.lower()
    for offset, raw in enumerate(statement.text.splitlines()):
        token = raw.strip()
        if not token:
            continue
        word = re.split(r'[\s",(]', token.lstrip('"'), maxsplit=1)[0]
        if word.lower() == target:
            return statement.start_line + offset
    return statement.start_line


def _condense(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()[:200]


# ── public entry point ──────────────────────────────────────────────────────


def produce_sidecar(
    dump_path: Path, target_schema: str = DEFAULT_TARGET_SCHEMA
) -> dict[str, object]:
    """Analyse one schema dump and return the v1 evidence sidecar.

    Raises ``DumpFormatError`` when sqlglot is unavailable (corpus I8) or the
    input is not a Postgres dump (corpus I3) — never an empty sidecar, which
    would convert "could not look" into "measured".
    """
    if not HAVE_SQLGLOT:
        raise DumpFormatError(
            "db-config-uses requires sqlglot, which is not importable. A dump "
            "producer with no SQL parser cannot meet the loudness floor, so "
            "there is no regex fallback: install sqlglot and re-run."
        )
    path = Path(dump_path)
    if not path.exists():
        raise DumpFormatError(f"dump file not found: {path}")
    if not path.is_file():
        raise DumpFormatError(f"--dump must name a file, not a directory: {path}")
    try:
        return DumpAnalyser(path, target_schema).run()
    except OSError as error:
        # Unreadable, mid-read failure, bad encoding — a caller gets a
        # structured producer error, never a traceback.
        raise DumpFormatError(f"could not read {path}: {error}") from error

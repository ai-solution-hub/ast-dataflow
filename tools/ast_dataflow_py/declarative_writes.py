"""Declarative (data-declared) write detection over the Python corpus.

The cocoindex postgres connector expresses the pipeline's Postgres writes as
DATA, not code: `TableSchema(columns={...})` constants, bound to a table name
by `mount_table_target(ctx, "<table>", SCHEMA)`, written through
`target.declare_row(row={...})`. None of those sites contain SQL or a
supabase-py chain, so the raw-SQL and fluent-chain detectors in
``column_uses`` never fire on them — the pipeline's PRIMARY write path was
invisible to both ast-dataflow sides (id-377 {377.4}).

Three collection passes per file, then a corpus-level resolution step:

1. ``TableSchema(...)`` constructions — const name (or inline), declared
   column names with per-key line numbers.
2. ``mount_table_target(...)`` calls — the (target variable, table string,
   schema reference) three-way binding.
3. ``.declare_row(...)`` calls — receiver name, row-payload dict keys.

declare_row receivers resolve to a table via a ladder (strongest first):

- R1 the receiver name is bound by a ``mount_table_target`` assignment
  anywhere in the corpus — the binding's table wins. (Module-scope
  assignments and same-named helper params intentionally share this path:
  the corpus convention is ``<abbrev>_target`` on both sides.)
- R2 no name match: payload-key containment against mounted schemas — the
  keys must be a subset of exactly ONE mounted schema's columns; that
  schema's table wins at ``indirect`` confidence.
- R3 unresolvable -> the site is returned as unattributable (surfaced in
  response caveats, never silently dropped).

Payloads that are NOT a literal dict at the call site (``row=row`` where the
dict was built earlier — flow.py's entity_relationships dedup map) fall back
to same-enclosing-scope dict literals whose keys are a subset of the
resolved table's declared columns (>=2 literal keys, direct payloads of
other sites excluded); matched keys are emitted at ``indirect`` confidence.
A resolved site with no recoverable keys at all emits one table-scoped
``declare_row`` row with ``columnPath: "*"`` — dynamic declarative writes
are smoke, never silence.

Verdict semantics (deliberate — no new confidence tier): a ``declare_row``
payload key is real write evidence (``exact`` when the binding is
unambiguous); a ``TableSchema`` column declaration alone is INTENT, not
proof — flow.py declares several source_documents columns "for schema
completeness" that the producer leaves NULL — so declaration-only rows are
emitted at ``indirect`` confidence (method ``table-schema``), which the
schema-coverage verdict engine maps to `undecidable`, never
`wired`/`write-only`.
"""

from __future__ import annotations

import ast
from dataclasses import dataclass, field
from typing import Callable, Iterator, Literal

Confidence = Literal["exact", "wildcard", "indirect"]

# The connector's constructor / binder / writer names. Collected by NAME
# (attribute or bare), not by import resolution: the corpus imports them
# through a compatibility shim (_coco_api) whose indirection an ast-level
# scan cannot follow, and the names are distinctive enough that a false
# positive would itself be a schema-shaped declaration worth reporting.
SCHEMA_CTORS = frozenset({"TableSchema"})
MOUNT_CALLS = frozenset({"mount_table_target"})
ROW_WRITE_METHODS = frozenset({"declare_row"})


@dataclass
class SchemaDecl:
    """One TableSchema(...) construction."""

    name: str | None  # assigned const name; None for inline constructions
    file: str
    line: int
    columns: dict[str, int]  # column name -> 1-based line of its key
    dynamic: bool  # non-literal keys / **spread in the columns dict


@dataclass
class MountBinding:
    """One mount_table_target(...) call."""

    target_var: str | None  # assignment target; None when not assigned to a name
    table: str | None  # literal table-name arg; None when dynamic
    schema_candidates: tuple[str, ...]  # Name args (ctx handles resolve away)
    inline_columns: dict[str, int] | None  # for inline TableSchema args
    file: str
    line: int


@dataclass
class DeclareRowSite:
    """One .declare_row(...) call."""

    receiver: str | None  # bare-name receiver; None for complex receivers
    keys: dict[str, int]  # literal payload key -> line
    dynamic: bool  # **spread / computed keys / non-literal payload
    file: str
    line: int
    enclosing: str


@dataclass
class DictLiteral:
    """A dict literal with >=2 literal string keys — payload-fallback pool."""

    enclosing: str
    file: str
    keys: dict[str, int]  # key -> line


@dataclass
class DeclarativeIndex:
    """Corpus-level collection result."""

    schemas: list[SchemaDecl] = field(default_factory=list)
    mounts: list[MountBinding] = field(default_factory=list)
    rows: list[DeclareRowSite] = field(default_factory=list)
    dict_literals: list[DictLiteral] = field(default_factory=list)

    def extend(self, other: "DeclarativeIndex") -> None:
        self.schemas.extend(other.schemas)
        self.mounts.extend(other.mounts)
        self.rows.extend(other.rows)
        self.dict_literals.extend(other.dict_literals)


@dataclass
class DeclarativeUse:
    """One resolved declarative column-write evidence row."""

    file: str
    line: int
    column: int  # 1-based col offset of the site
    confidence: Confidence
    method: Literal["table-schema", "declare_row"]
    columnPath: str
    table: str
    enclosing: str

    def to_json(self) -> dict[str, object]:
        return {
            "file": self.file,
            "line": self.line,
            "column": self.column,
            "confidence": self.confidence,
            "method": self.method,
            "columnPath": self.columnPath,
            "table": self.table,
            "enclosing": self.enclosing,
            "source": "declarative",
        }


def _call_name(node: ast.expr) -> str | None:
    """Bare or attribute call name: TableSchema(...) or x.TableSchema(...)."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def _literal_dict_keys(node: ast.expr | None) -> tuple[dict[str, int], bool]:
    """(literal string keys -> line, has_dynamic) for a dict expression."""
    if not isinstance(node, ast.Dict):
        return ({}, True)
    keys: dict[str, int] = {}
    dynamic = False
    for key in node.keys:
        if key is None:  # **spread
            dynamic = True
        elif isinstance(key, ast.Constant) and isinstance(key.value, str):
            keys[key.value] = key.lineno
        else:
            dynamic = True
    return (keys, dynamic)


def _columns_dict(call: ast.Call) -> tuple[dict[str, int], bool]:
    """(column -> key line, dynamic) from a TableSchema columns={...} arg."""
    for kw in call.keywords:
        if kw.arg == "columns":
            return _literal_dict_keys(kw.value)
    if call.args:  # positional columns dict
        return _literal_dict_keys(call.args[0])
    return ({}, True)


def _unwrap_await(node: ast.expr) -> ast.expr:
    return node.value if isinstance(node, ast.Await) else node


class _Collector(ast.NodeVisitor):
    """Single-file collection of schemas, mounts, and declare_row sites."""

    def __init__(
        self, rel_path: str, enclosing_of: Callable[[ast.AST], str]
    ) -> None:
        self.rel_path = rel_path
        self.enclosing_of = enclosing_of
        self.index = DeclarativeIndex()
        # Assigned-construction Call nodes, so visit_Call skips them instead
        # of re-collecting them as inline/unassigned.
        self._assigned_calls: set[int] = set()
        # Dict nodes consumed as a direct declare_row payload or a
        # TableSchema columns arg — excluded from the payload-fallback pool.
        self._consumed_dicts: set[int] = set()

    def _mark_columns_dict_consumed(self, call: ast.Call) -> None:
        for kw in call.keywords:
            if kw.arg == "columns" and isinstance(kw.value, ast.Dict):
                self._consumed_dicts.add(id(kw.value))
        if call.args and isinstance(call.args[0], ast.Dict):
            self._consumed_dicts.add(id(call.args[0]))

    def _record_schema(self, call: ast.Call, assigned_name: str | None) -> None:
        self._mark_columns_dict_consumed(call)
        columns, dynamic = _columns_dict(call)
        self.index.schemas.append(
            SchemaDecl(
                name=assigned_name,
                file=self.rel_path,
                line=call.lineno,
                columns=columns,
                dynamic=dynamic,
            )
        )

    def _record_mount(self, call: ast.Call, target_var: str | None) -> None:
        table: str | None = None
        candidates: list[str] = []
        inline_columns: dict[str, int] | None = None
        for arg in list(call.args) + [kw.value for kw in call.keywords]:
            if (
                table is None
                and isinstance(arg, ast.Constant)
                and isinstance(arg.value, str)
            ):
                table = arg.value
            elif isinstance(arg, ast.Name):
                candidates.append(arg.id)
            elif isinstance(arg, ast.Attribute):
                # Cross-module schema refs (`flow.RECORD_EMBEDDINGS_SCHEMA`,
                # server.py's closure mount) — candidate by attribute name;
                # resolution matches it against corpus-collected decls.
                candidates.append(arg.attr)
            elif isinstance(arg, ast.Call) and _call_name(arg.func) in SCHEMA_CTORS:
                self._mark_columns_dict_consumed(arg)
                inline_columns, _ = _columns_dict(arg)
                self._assigned_calls.add(id(arg))
        self.index.mounts.append(
            MountBinding(
                target_var=target_var,
                table=table,
                schema_candidates=tuple(candidates),
                inline_columns=inline_columns,
                file=self.rel_path,
                line=call.lineno,
            )
        )

    def _handle_assign_value(self, value: ast.expr, target: str | None) -> bool:
        call = _unwrap_await(value)
        if not isinstance(call, ast.Call):
            return False
        name = _call_name(call.func)
        if name in SCHEMA_CTORS:
            self._record_schema(call, target)
            self._assigned_calls.add(id(call))
            return True
        if name in MOUNT_CALLS:
            self._record_mount(call, target)
            self._assigned_calls.add(id(call))
            return True
        return False

    def visit_Assign(self, node: ast.Assign) -> None:
        target = (
            node.targets[0].id
            if len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)
            else None
        )
        self._handle_assign_value(node.value, target)
        self.generic_visit(node)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        if node.value is not None:
            target = node.target.id if isinstance(node.target, ast.Name) else None
            self._handle_assign_value(node.value, target)
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        name = _call_name(node.func)
        if name in SCHEMA_CTORS:
            if id(node) not in self._assigned_calls:
                self._record_schema(node, None)
        elif name in MOUNT_CALLS:
            if id(node) not in self._assigned_calls:
                self._record_mount(node, None)
        elif name in ROW_WRITE_METHODS and isinstance(node.func, ast.Attribute):
            receiver = (
                node.func.value.id
                if isinstance(node.func.value, ast.Name)
                else None
            )
            payload: ast.expr | None = None
            for kw in node.keywords:
                if kw.arg == "row":
                    payload = kw.value
            if payload is None and node.args:
                payload = node.args[0]
            if isinstance(payload, ast.Dict):
                self._consumed_dicts.add(id(payload))
            keys, dynamic = _literal_dict_keys(payload)
            self.index.rows.append(
                DeclareRowSite(
                    receiver=receiver,
                    keys=keys,
                    dynamic=dynamic,
                    file=self.rel_path,
                    line=node.lineno,
                    enclosing=self.enclosing_of(node),
                )
            )
        self.generic_visit(node)

    def visit_Dict(self, node: ast.Dict) -> None:
        if id(node) not in self._consumed_dicts:
            keys, _ = _literal_dict_keys(node)
            if len(keys) >= 2:
                self.index.dict_literals.append(
                    DictLiteral(
                        enclosing=self.enclosing_of(node),
                        file=self.rel_path,
                        keys=keys,
                    )
                )
        self.generic_visit(node)


def collect_source(source: str, rel_path: str) -> DeclarativeIndex | None:
    """Collect declarative sites from one file's source; None on syntax error.

    Imports the enclosing-label tracker from column_uses so labels match the
    other detectors' ``fn:``/``method:``/``moduleTopLevel`` convention.
    """
    from tools.ast_dataflow_py.column_uses import _EnclosingTracker

    try:
        tree = ast.parse(source)
    except SyntaxError:
        return None
    tracker = _EnclosingTracker()
    tracker.visit(tree)
    collector = _Collector(rel_path, tracker.label_for)
    collector.visit(tree)
    return collector.index


def _mounted_columns(
    mount: MountBinding, schemas: dict[str, list[SchemaDecl]]
) -> tuple[dict[str, int], str] | None:
    """(columns, declaring file) for a mount, resolving its schema ref.

    Same-file declarations win over other files (two files may reuse a
    schema const name); a cross-file candidate resolves only when unique.
    """
    for candidate in mount.schema_candidates:
        decls = schemas.get(candidate)
        if not decls:
            continue
        same_file = [d for d in decls if d.file == mount.file]
        if len(same_file) == 1:
            return (same_file[0].columns, same_file[0].file)
        if len(decls) == 1:
            return (decls[0].columns, decls[0].file)
        return None  # ambiguous const name — refuse to guess
    if mount.inline_columns is not None:
        return (mount.inline_columns, mount.file)
    return None


@dataclass
class ResolvedTarget:
    table: str
    confidence: Confidence


def _schema_by_name(index: DeclarativeIndex) -> dict[str, list[SchemaDecl]]:
    by_name: dict[str, list[SchemaDecl]] = {}
    for schema in index.schemas:
        if schema.name is not None:
            by_name.setdefault(schema.name, []).append(schema)
    return by_name


def _resolve_receiver(
    site: DeclareRowSite, index: DeclarativeIndex
) -> ResolvedTarget | None:
    """R1/R2 resolution of a declare_row receiver to a table."""
    schemas = _schema_by_name(index)

    # R1: mounts whose target var matches the receiver name.
    name_tables = {
        m.table
        for m in index.mounts
        if site.receiver is not None
        and m.target_var == site.receiver
        and m.table is not None
    }
    if name_tables:
        if len(name_tables) == 1:
            return ResolvedTarget(table=next(iter(name_tables)), confidence="exact")
        # Same var name mounted to different tables somewhere in the corpus —
        # ambiguous; fall through to shape to disambiguate, else indirect on
        # the alphabetically-first candidate is WRONG, so report via shape or
        # give up to the unattributable channel.
    else:
        name_tables = set()

    # R2: payload keys ⊆ exactly one mounted schema's columns.
    shape_tables: set[str] = set()
    if site.keys:
        key_set = set(site.keys)
        for mount in index.mounts:
            if mount.table is None:
                continue
            resolved = _mounted_columns(mount, schemas)
            if resolved is None:
                continue
            columns, _ = resolved
            if columns and key_set <= set(columns):
                shape_tables.add(mount.table)

    if name_tables:
        agreeing = name_tables & shape_tables
        if len(agreeing) == 1:
            return ResolvedTarget(table=next(iter(agreeing)), confidence="indirect")
        return None
    if len(shape_tables) == 1:
        return ResolvedTarget(
            table=next(iter(shape_tables)), confidence="indirect"
        )
    return None


def resolve_uses(
    index: DeclarativeIndex,
) -> tuple[list[DeclarativeUse], list[DeclareRowSite]]:
    """All declarative evidence rows + unresolvable declare_row sites.

    Per resolved declare_row payload key: one ``declare_row`` row at the
    resolution's confidence. Dynamic payload parts (``**spread``, computed
    keys) contribute nothing — the literal keys are still certain, and the
    unknown remainder is invisible either way. Per mounted schema column:
    one ``table-schema`` declaration row at ``indirect``.
    """
    uses: list[DeclarativeUse] = []
    unresolved: list[DeclareRowSite] = []
    schemas = _schema_by_name(index)

    seen_decl: set[tuple[str, str, str, int]] = set()
    for mount in index.mounts:
        if mount.table is None:
            continue
        resolved = _mounted_columns(mount, schemas)
        if resolved is None:
            continue
        columns, decl_file = resolved
        for column_name, line in columns.items():
            # Two mounts of one schema const would duplicate rows — dedupe
            # on the declaration coordinates.
            dedupe_key = (mount.table, column_name, decl_file, line)
            if dedupe_key in seen_decl:
                continue
            seen_decl.add(dedupe_key)
            uses.append(
                DeclarativeUse(
                    file=decl_file,
                    line=line,
                    column=1,
                    confidence="indirect",
                    method="table-schema",
                    columnPath=column_name,
                    table=mount.table,
                    enclosing="moduleTopLevel",
                )
            )

    table_columns: dict[str, set[str]] = {}
    for mount in index.mounts:
        if mount.table is None:
            continue
        resolved_cols = _mounted_columns(mount, schemas)
        if resolved_cols is not None:
            table_columns.setdefault(mount.table, set()).update(resolved_cols[0])

    for site in index.rows:
        resolved_target = _resolve_receiver(site, index)
        if resolved_target is None:
            unresolved.append(site)
            continue
        emitted = False
        for key, line in site.keys.items():
            emitted = True
            uses.append(
                DeclarativeUse(
                    file=site.file,
                    line=line,
                    column=1,
                    confidence=resolved_target.confidence,
                    method="declare_row",
                    columnPath=key,
                    table=resolved_target.table,
                    enclosing=site.enclosing,
                )
            )
        if not site.keys and site.dynamic:
            # row=<var> payload: fall back to same-enclosing-scope dict
            # literals whose keys fit the target's declared columns.
            target_cols = table_columns.get(resolved_target.table, set())
            fallback_keys: dict[str, int] = {}
            for candidate in index.dict_literals:
                if (
                    candidate.file == site.file
                    and candidate.enclosing == site.enclosing
                    and target_cols
                    and set(candidate.keys) <= target_cols
                ):
                    fallback_keys.update(candidate.keys)
            for key, line in fallback_keys.items():
                emitted = True
                uses.append(
                    DeclarativeUse(
                        file=site.file,
                        line=line,
                        column=1,
                        confidence="indirect",
                        method="declare_row",
                        columnPath=key,
                        table=resolved_target.table,
                        enclosing=site.enclosing,
                    )
                )
        if not emitted:
            # Resolved table, unrecoverable columns — table-scoped smoke.
            uses.append(
                DeclarativeUse(
                    file=site.file,
                    line=site.line,
                    column=1,
                    confidence="indirect",
                    method="declare_row",
                    columnPath="*",
                    table=resolved_target.table,
                    enclosing=site.enclosing,
                )
            )

    return uses, unresolved


def iter_declarative_writes(
    index: DeclarativeIndex,
    table: str | None = None,
    column: str | None = None,
) -> Iterator[DeclarativeUse]:
    """Resolved declarative rows, optionally filtered to one table/column."""
    uses, _ = resolve_uses(index)
    for use in uses:
        if table is not None and use.table != table:
            continue
        if column is not None and use.columnPath != column:
            continue
        yield use

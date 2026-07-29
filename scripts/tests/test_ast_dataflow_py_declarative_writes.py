"""Tests for tools/ast_dataflow_py declarative-write detection + bulk sweep.

The declarative detector closes the flow.py blind spot: writes declared as
DATA (TableSchema consts bound by mount_table_target, written via
declare_row) rather than as SQL or fluent chains. The bulk `schema-uses`
sweep emits the v1 evidence-sidecar the TS schema-coverage --evidence flag
consumes.
"""

from __future__ import annotations

import json
from pathlib import Path

from tools.ast_dataflow_py.cli import main as cli_main
from tools.ast_dataflow_py.column_uses import scan_python_source
from tools.ast_dataflow_py.declarative_writes import (
    collect_source,
    resolve_uses,
)
from tools.ast_dataflow_py.schema_uses import build_sidecar, scan_schema_uses

REPO_ROOT = Path(__file__).resolve().parents[2]

BASIC = """
SCHEMA = TableSchema(
    columns={
        "id": ColumnDef(type="uuid", nullable=False),
        "name": ColumnDef(type="text", nullable=False),
        "spare": ColumnDef(type="text", nullable=True),
    },
    primary_key=("id",),
)

async def mount(ctx):
    target = await mount_table_target(ctx, "widgets", SCHEMA)
    return target

def write(target):
    target.declare_row(row={"id": make_id(), "name": "x"})
"""


def _uses(source: str):
    index = collect_source(source, "scripts/example.py")
    assert index is not None
    return resolve_uses(index)


class TestDeclarativeResolution:
    def test_literal_payload_keys_are_exact_write_evidence(self):
        uses, unresolved = _uses(BASIC)
        assert unresolved == []
        rows = [u for u in uses if u.method == "declare_row"]
        assert {(u.table, u.columnPath, u.confidence) for u in rows} == {
            ("widgets", "id", "exact"),
            ("widgets", "name", "exact"),
        }

    def test_declared_but_never_written_column_is_indirect_only(self):
        # 'spare' is in the TableSchema but no declare_row payload — the
        # declaration is intent, not proof, so it must never appear at
        # exact confidence (schema-coverage maps indirect -> undecidable).
        uses, _ = _uses(BASIC)
        spare = [u for u in uses if u.columnPath == "spare"]
        assert len(spare) == 1
        assert spare[0].method == "table-schema"
        assert spare[0].confidence == "indirect"

    def test_param_receiver_resolves_via_mount_var_name_match(self):
        # flow.py's re_target pattern: the helper receives the target as a
        # parameter named identically to the mount-site variable.
        uses, unresolved = _uses(BASIC)
        assert unresolved == []
        assert any(
            u.method == "declare_row" and u.enclosing == "fn:write" for u in uses
        )

    def test_dedup_map_payload_falls_back_to_scope_dict_literals(self):
        source = BASIC + """
def write_many(target, items):
    dedup = {}
    for item in items:
        dedup[item.key] = {"id": item.id, "name": item.name}
    for row in dedup.values():
        target.declare_row(row=row)
"""
        uses, unresolved = _uses(source)
        assert unresolved == []
        fallback = [
            u
            for u in uses
            if u.method == "declare_row" and u.enclosing == "fn:write_many"
        ]
        assert {(u.columnPath, u.confidence) for u in fallback} == {
            ("id", "indirect"),
            ("name", "indirect"),
        }

    def test_dynamic_payload_with_no_scope_dict_emits_table_smoke(self):
        source = BASIC + """
def write_opaque(target, payload):
    target.declare_row(row=payload)
"""
        uses, unresolved = _uses(source)
        assert unresolved == []
        smoke = [
            u
            for u in uses
            if u.method == "declare_row" and u.enclosing == "fn:write_opaque"
        ]
        assert [(u.columnPath, u.confidence) for u in smoke] == [("*", "indirect")]

    def test_unresolvable_receiver_is_reported_not_dropped(self):
        source = """
def write(mystery):
    mystery.declare_row(row={"a": 1, "b": 2})
"""
        uses, unresolved = _uses(source)
        assert uses == []
        assert len(unresolved) == 1
        assert unresolved[0].receiver == "mystery"

    def test_same_var_name_mounted_to_two_tables_refuses_to_guess(self):
        source = """
A = TableSchema(columns={"x": ColumnDef(type="text", nullable=False)})
B = TableSchema(columns={"y": ColumnDef(type="text", nullable=False)})

async def mount_a(ctx):
    target = await mount_table_target(ctx, "alpha", A)

async def mount_b(ctx):
    target = await mount_table_target(ctx, "beta", B)

def write(target):
    target.declare_row(row={"z": 1, "w": 2})
"""
        uses, unresolved = _uses(source)
        assert [u for u in uses if u.method == "declare_row"] == []
        assert len(unresolved) == 1

    def test_ambiguous_name_disambiguated_by_payload_shape(self):
        source = """
A = TableSchema(columns={"x": ColumnDef(type="text", nullable=False), "x2": ColumnDef(type="text", nullable=False)})
B = TableSchema(columns={"y": ColumnDef(type="text", nullable=False), "y2": ColumnDef(type="text", nullable=False)})

async def mount_a(ctx):
    target = await mount_table_target(ctx, "alpha", A)

async def mount_b(ctx):
    target = await mount_table_target(ctx, "beta", B)

def write(target):
    target.declare_row(row={"y": 1, "y2": 2})
"""
        uses, unresolved = _uses(source)
        assert unresolved == []
        rows = [u for u in uses if u.method == "declare_row"]
        assert {(u.table, u.columnPath, u.confidence) for u in rows} == {
            ("beta", "y", "indirect"),
            ("beta", "y2", "indirect"),
        }


class TestModuleConstSql:
    """SQL passed by module-constant name — the l_records convention."""

    def test_const_name_first_arg_resolves_to_exact_sql(self):
        source = (
            '_SQL_LOAD = "SELECT id FROM source_documents WHERE id = $1"\n'
            "async def load(conn):\n"
            "    return await conn.fetchrow(_SQL_LOAD)\n"
        )
        rows = list(
            scan_python_source(
                source, "scripts/example.py", "source_documents", "id",
                "column-reads",
            )
        )
        assert len(rows) == 1
        assert rows[0].confidence == "exact"
        assert rows[0].method == "select"

    def test_fstring_over_resolvable_const_stays_exact(self):
        # f"{_SQL_X} LIMIT $2" — every part statically known, so the text
        # is exact, not dynamic.
        source = (
            '_SQL_BASE = "SELECT id FROM source_documents"\n'
            "async def load(conn, n):\n"
            '    sql = f"{_SQL_BASE} LIMIT $1"\n'
            "    return await conn.fetch(f\"{_SQL_BASE} LIMIT $1\")\n"
        )
        rows = list(
            scan_python_source(
                source, "scripts/example.py", "source_documents", "id",
                "column-reads",
            )
        )
        assert len(rows) == 1
        assert rows[0].confidence == "exact"

    def test_unresolvable_name_arg_yields_no_rows(self):
        source = (
            "async def load(conn, sql):\n"
            "    return await conn.fetch(sql)\n"
        )
        rows = list(
            scan_python_source(
                source, "scripts/example.py", "source_documents", "id",
                "column-reads",
            )
        )
        assert rows == []


class TestColumnWritesIntegration:
    def test_column_writes_includes_declarative_rows(self):
        rows = list(
            scan_python_source(
                BASIC, "scripts/example.py", "widgets", "name", "column-writes"
            )
        )
        assert {(r.source, r.method) for r in rows} == {
            ("declarative", "table-schema"),
            ("declarative", "declare_row"),
        }

    def test_column_reads_never_emits_declarative_rows(self):
        rows = list(
            scan_python_source(
                BASIC, "scripts/example.py", "widgets", "name", "column-reads"
            )
        )
        assert rows == []


class TestRealCorpus:
    """Pin the detector against the repo's actual primary write surface.

    These assert the flow.py contract this tool exists to see; if flow.py's
    write topology changes, these SHOULD fail and be updated deliberately.
    """

    def test_flow_py_mounts_resolve_completely(self):
        source = (REPO_ROOT / "scripts/cocoindex_pipeline/flow.py").read_text()
        index = collect_source(source, "scripts/cocoindex_pipeline/flow.py")
        assert index is not None
        mounted = {m.table for m in index.mounts if m.table}
        assert mounted == {
            "q_a_extractions",
            "source_documents",
            "entity_mentions",
            "entity_relationships",
            "content_chunks",
            "reference_items",
            "record_embeddings",
        }
        uses, unresolved = resolve_uses(index)
        assert unresolved == []
        # The entity_relationships dedup-map payload (row=row) must be
        # recovered via the scope-dict fallback.
        er = {
            u.columnPath
            for u in uses
            if u.table == "entity_relationships" and u.method == "declare_row"
        }
        assert "source_entity" in er and "target_entity" in er


class TestSchemaUsesSweep:
    def test_sidecar_envelope_shape(self):
        rows, caveats = scan_schema_uses(REPO_ROOT, ["scripts"], exclude_tests=True)
        sidecar = build_sidecar(rows, caveats, duration_ms=1)
        assert sidecar["schemaVersion"] == 1
        assert sidecar["source"] == "ast-dataflow-py"
        assert isinstance(sidecar["rows"], list) and sidecar["rows"]
        first = sidecar["rows"][0]
        assert set(first) == {
            "table",
            "column",
            "direction",
            "confidence",
            "method",
            "file",
            "line",
            "source",
        }

    def test_sweep_covers_all_three_sources(self):
        rows, _ = scan_schema_uses(REPO_ROOT, ["scripts"], exclude_tests=True)
        assert {r.source for r in rows} == {"sql", "supabase-py", "declarative"}

    def test_rpc_payloads_are_skipped_loudly(self):
        _, caveats = scan_schema_uses(REPO_ROOT, ["scripts"], exclude_tests=True)
        assert caveats.rpc_payload_sites_skipped >= 1

    def test_l_records_const_sql_reads_are_visible(self):
        # The l_records read layer passes ALL its SQL as module constants —
        # invisible before the const-resolution hop.
        rows, caveats = scan_schema_uses(REPO_ROOT, ["scripts"], exclude_tests=True)
        lrec = [
            r
            for r in rows
            if r.file == "scripts/cocoindex_pipeline/sources/l_records.py"
        ]
        assert {r.table for r in lrec} >= {"source_documents", "q_a_pairs"}
        # The conditional tuple-assign sites stay dynamic — caveated, small.
        assert caveats.sql_sites_unresolved_dynamic <= 5

    def test_stored_proc_from_source_never_emits_empty_table(self, tmp_path):
        # Live-caught defect (S510): `SELECT ... FROM public.some_proc(...)`
        # yields a NAMELESS sqlglot Table node; rows with table="" violated
        # the sidecar contract and failed the TS consumer's row validation.
        pkg = tmp_path / "pkg"
        pkg.mkdir()
        (pkg / "proc.py").write_text(
            "async def mint(conn):\n"
            "    return await conn.fetchrow(\n"
            '        "SELECT source_document_id, was_minted "\n'
            '        "FROM public.resolve_or_mint_source_identity($1, $2)"\n'
            "    )\n"
        )
        rows, caveats = scan_schema_uses(tmp_path, ["pkg"])
        assert all(r.table.strip() for r in rows)
        assert caveats.sql_function_source_sites == 1

    def test_cli_schema_uses_emits_sidecar(self, capsys):
        exit_code = cli_main(
            ["schema-uses", "--exclude-tests", "--root", str(REPO_ROOT)]
        )
        assert exit_code == 0
        sidecar = json.loads(capsys.readouterr().out)
        assert sidecar["schemaVersion"] == 1
        assert sidecar["generatedBy"] == "schema-uses"

    def test_cli_schema_uses_rejects_table_flag(self):
        exit_code = cli_main(["schema-uses", "--table", "widgets"])
        assert exit_code == 2

    def test_cli_column_queries_still_require_table_and_column(self):
        exit_code = cli_main(["column-writes", "--table", "widgets"])
        assert exit_code == 2

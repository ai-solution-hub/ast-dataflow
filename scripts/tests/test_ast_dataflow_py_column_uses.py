"""Tests for tools/ast_dataflow_py — Python-corpus column lineage.

The module is the Python sibling of the TS ast-dataflow column-reads /
column-writes queries: raw-SQL (asyncpg) and supabase-py chain detection.
sqlglot is optional; where confidence depends on its presence the assertions
branch on HAVE_SQLGLOT so the suite passes in both environments (CI installs
sqlglot; the local sandbox may not have it).
"""

from __future__ import annotations

import json

from tools.ast_dataflow_py.cli import main as cli_main
from tools.ast_dataflow_py.column_uses import (
    HAVE_SQLGLOT,
    is_test_path,
    scan_python_source,
    scan_tree,
)


def rows_for(source: str, kind: str, table: str = "source_documents", column: str = "id"):
    return list(scan_python_source(source, "scripts/example.py", table, column, kind))


# ── Raw SQL (asyncpg-style) ──────────────────────────────────────────────────


class TestRawSql:
    def test_update_statement_is_a_write_hit(self):
        source = (
            "async def touch(conn):\n"
            '    await conn.execute("UPDATE public.source_documents SET id = $1")\n'
        )
        rows = rows_for(source, "column-writes")
        assert len(rows) == 1
        row = rows[0]
        assert row.method == "update"
        assert row.enclosing == "fn:touch"
        assert row.source == "sql"
        if HAVE_SQLGLOT:
            assert row.confidence == "exact"
        else:
            assert row.confidence == "indirect"

    def test_select_statement_is_a_read_hit(self):
        source = (
            "async def load(conn):\n"
            '    return await conn.fetchrow("SELECT id FROM source_documents WHERE id = $1")\n'
        )
        rows = rows_for(source, "column-reads")
        assert len(rows) == 1
        assert rows[0].method == "select"

    def test_select_star_reports_wildcard(self):
        source = (
            "async def load_all(conn):\n"
            '    return await conn.fetch("SELECT * FROM source_documents")\n'
        )
        rows = rows_for(source, "column-reads", column="nonexistent_col")
        assert len(rows) == 1
        assert rows[0].confidence == "wildcard"
        assert rows[0].columnPath == "*"

    def test_fstring_sql_is_downgraded_to_indirect(self):
        source = (
            "async def touch(conn, table_suffix):\n"
            '    await conn.execute(f"UPDATE source_documents SET id = {table_suffix}")\n'
        )
        rows = rows_for(source, "column-writes")
        assert len(rows) == 1
        assert rows[0].confidence == "indirect"

    def test_other_table_is_not_reported(self):
        source = (
            "async def touch(conn):\n"
            '    await conn.execute("UPDATE other_table SET id = $1")\n'
        )
        assert rows_for(source, "column-writes") == []

    def test_insert_column_list_is_detected(self):
        source = (
            "async def insert(conn):\n"
            '    await conn.execute("INSERT INTO source_documents (id, name) VALUES ($1, $2)")\n'
        )
        rows = rows_for(source, "column-writes")
        assert len(rows) == 1
        assert rows[0].method == "insert"


# ── supabase-py chains ───────────────────────────────────────────────────────


class TestSupabaseChains:
    def test_update_dict_with_key_is_exact(self):
        source = (
            "def run(client):\n"
            '    client.from_("source_documents").update({"id": "x"}).eq("name", "y").execute()\n'
        )
        rows = [r for r in rows_for(source, "column-writes") if r.source == "supabase-py"]
        assert len(rows) == 1
        assert rows[0].method == "update"
        assert rows[0].confidence == "exact"
        assert rows[0].enclosing == "fn:run"

    def test_update_dict_spread_cannot_be_ruled_out(self):
        source = (
            "def run(client, payload):\n"
            '    client.from_("source_documents").update({**payload}).execute()\n'
        )
        rows = [r for r in rows_for(source, "column-writes") if r.source == "supabase-py"]
        assert len(rows) == 1
        assert rows[0].confidence == "indirect"

    def test_update_dict_without_key_is_excluded(self):
        source = (
            "def run(client):\n"
            '    client.from_("source_documents").update({"name": "y"}).execute()\n'
        )
        rows = [r for r in rows_for(source, "column-writes") if r.source == "supabase-py"]
        assert rows == []

    def test_insert_list_with_identifier_element_is_indirect(self):
        source = (
            "def run(client, row):\n"
            '    client.from_("source_documents").insert([row]).execute()\n'
        )
        rows = [r for r in rows_for(source, "column-writes") if r.source == "supabase-py"]
        assert len(rows) == 1
        assert rows[0].confidence == "indirect"

    def test_select_list_and_wildcard(self):
        source = (
            "def run(client):\n"
            '    client.from_("source_documents").select("id, name").execute()\n'
            '    client.from_("source_documents").select("*").execute()\n'
        )
        rows = [r for r in rows_for(source, "column-reads") if r.source == "supabase-py"]
        methods = {(r.method, r.confidence) for r in rows}
        assert ("select", "exact") in methods
        assert ("select", "wildcard") in methods

    def test_filter_methods_report_column(self):
        source = (
            "def run(client, ids):\n"
            '    client.from_("source_documents").select("name").eq("id", "x").execute()\n'
            '    client.from_("source_documents").select("name").in_("id", ids).order("id").execute()\n'
        )
        rows = [r for r in rows_for(source, "column-reads") if r.source == "supabase-py"]
        chain_methods = {r.chainMethod for r in rows if r.method == "filter"}
        assert "eq" in chain_methods
        assert "in_" in chain_methods
        assert any(r.method == "order" for r in rows)

    def test_rpc_payload_key(self):
        source = (
            "def run(client):\n"
            '    client.rpc("claim_next_job", {"id": "x"}).execute()\n'
        )
        rows = rows_for(source, "column-reads")
        assert len(rows) == 1
        assert rows[0].method == "rpc-payload"
        assert rows[0].confidence == "exact"

    def test_wrong_table_chain_is_excluded(self):
        source = (
            "def run(client):\n"
            '    client.from_("form_templates").update({"id": "x"}).execute()\n'
        )
        assert [r for r in rows_for(source, "column-writes") if r.source == "supabase-py"] == []

    def test_method_on_class_gets_method_label(self):
        source = (
            "class Worker:\n"
            "    def claim(self, client):\n"
            '        client.from_("source_documents").update({"id": "x"}).execute()\n'
        )
        rows = [r for r in rows_for(source, "column-writes") if r.source == "supabase-py"]
        assert rows[0].enclosing == "method:Worker.claim"


# ── Tree scanning + CLI ──────────────────────────────────────────────────────


class TestScanTreeAndCli:
    def test_is_test_path_markers(self):
        assert is_test_path("scripts/tests/test_foo.py")
        assert is_test_path("scripts/tests/oq/test_bar.py")
        assert not is_test_path("scripts/cocoindex_pipeline/flow.py")

    def test_scan_tree_exclude_tests(self, tmp_path):
        pkg = tmp_path / "scripts"
        (pkg / "tests").mkdir(parents=True)
        (pkg / "prod.py").write_text(
            'async def touch(conn):\n    await conn.execute("UPDATE t SET c = 1")\n'
        )
        (pkg / "tests" / "test_x.py").write_text(
            'async def touch(conn):\n    await conn.execute("UPDATE t SET c = 1")\n'
        )
        all_rows = list(scan_tree(tmp_path, ["scripts"], "t", "c", "column-writes"))
        prod_rows = list(
            scan_tree(tmp_path, ["scripts"], "t", "c", "column-writes", exclude_tests=True)
        )
        assert len(all_rows) == 2
        assert len(prod_rows) == 1
        assert prod_rows[0].file == "scripts/prod.py"

    def test_cli_envelope(self, tmp_path, capsys):
        pkg = tmp_path / "scripts"
        pkg.mkdir()
        (pkg / "prod.py").write_text(
            'async def touch(conn):\n    await conn.execute("UPDATE t SET c = 1")\n'
        )
        exit_code = cli_main(
            [
                "column-writes",
                "--table",
                "t",
                "--column",
                "c",
                "--root",
                str(tmp_path),
            ]
        )
        assert exit_code == 0
        payload = json.loads(capsys.readouterr().out)
        assert payload["query"] == "column-writes"
        assert payload["truncated"] is False
        assert isinstance(payload["sqlglot"], bool)
        assert len(payload["results"]) == 1
        assert payload["results"][0]["file"] == "scripts/prod.py"

    def test_cli_rejects_bad_limit(self, capsys):
        exit_code = cli_main(
            ["column-reads", "--table", "t", "--column", "c", "--limit", "0"]
        )
        assert exit_code == 2
        assert "Invalid --limit" in capsys.readouterr().err

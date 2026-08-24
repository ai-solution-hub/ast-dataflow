"""The DB-config acceptance corpus, executed.

`docs/db-config-acceptance-corpus.md` is the test oracle for the `db-config-uses`
producer (design: `docs/db-config-export.md`; contract: ADR 0003 + `docs/SIDECAR.md`).
Every lettered case A1-I8 below is one test named so the corpus id is greppable, and
every global invariant I1-I5 is a sweep over EVERY fixture's output.

Fixtures are pg_dump-style SQL snippets held as module constants; expectations are
sidecar rows `(table, column, direction, confidence, method)` plus caveat and
inventory fields, in the style of the existing declarative-writes tests.

Two `I` namespaces exist in the corpus and are kept apart here: the global invariants
are `test_invariant_I1..I5`, the artefact-level cases are `test_I1..I8_*` in
`TestIArtefactLevel`.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

pytest.importorskip("sqlglot")

from tools.ast_dataflow_py.cli import main as cli_main  # noqa: E402
from tools.ast_dataflow_py.db_config_uses import (  # noqa: E402
    DumpFormatError,
    produce_sidecar,
)

# ── Fixture scaffolding ─────────────────────────────────────────────────────
# A pg_dump plain-format header. Every fixture carries it: corpus I4 pins that a
# headers-only dump is VALID (empty sidecar) while corpus I3 pins that a file with
# no dump shape at all is a hard failure, so the header is what separates them.
# 11 lines, so fixture bodies start at line 12.
HEADER = """\
--
-- PostgreSQL database dump
--

-- Dumped from database version 15.4 (Debian 15.4-1.pgdg120+1)
-- Dumped by pg_dump version 15.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET client_encoding = 'UTF8';

"""

# The complete caveat vocabulary of design §6 / the corpus. The producer emits
# exactly these keys — no more (an unknown caveat key is an unreviewed blindness
# channel) and no fewer (a missing key is a silent one).
EMPTY_CAVEATS: dict[str, object] = {
    "unparsedStatements": [],
    "plpgsqlStatementAccounting": [],
    "dynamicSql": 0,
    "unsupportedLanguageBodies": {},
    "unresolvedTableNames": {},
    "ambiguousColumnBindings": [],
    "multiTableBoundFunctions": {},
    "disabledObjects": [],
    "outOfScopeSchemaObjects": {"objects": [], "references": 0},
    "partitionAttribution": {},
    "positionalInsert": 0,
    "unboundTriggerFunctions": [],
}
CAVEAT_KEYS = frozenset(EMPTY_CAVEATS)

INVENTORY_KEYS = frozenset({"tables", "functions", "views", "policies", "triggers"})

# Invariant I4: every row's `method` is `<class>:<schema-qualified identity>`, with
# `;`-joined segments when a row reached its table through a second object.
METHOD_CLASSES = frozenset(
    {
        "function-body",
        "trigger-when",
        "trigger-event",
        "view-definition",
        "rls-policy",
        "column-default",
        "check-constraint",
        "index",
        "generated-column",
        "foreign-key",
        "unique-constraint",
        "primary-key",
        "not-null",
        "partition",
    }
)


def write_dump(tmp_path: Path, text: str, name: str = "db-config.sql") -> Path:
    tmp_path.mkdir(parents=True, exist_ok=True)
    path = tmp_path / name
    path.write_text(text, encoding="utf-8")
    return path


def sidecar_for(tmp_path: Path, text: str, schema: str = "public") -> dict:
    """Run the producer over a fixture dump and return the sidecar."""
    return produce_sidecar(write_dump(tmp_path, text), target_schema=schema)


def rows(sidecar: dict) -> set[tuple[str, str, str, str, str]]:
    return {
        (r["table"], r["column"], r["direction"], r["confidence"], r["method"])
        for r in sidecar["rows"]
    }


def caveats(sidecar: dict) -> dict:
    return sidecar["caveats"]


def inventory(sidecar: dict) -> dict:
    return sidecar["objectsFound"]


def assert_quiet_except(sidecar: dict, *ignored: str) -> None:
    """Every caveat channel is empty apart from the named ones.

    Keeps the "no caveat" halves of the corpus (A6, and every case whose expectation
    is silence on the loudness channels) honest — a producer that fired a spurious
    caveat would still pass a rows-only assertion.
    """
    got = {k: v for k, v in caveats(sidecar).items() if k not in ignored}
    want = {k: v for k, v in EMPTY_CAVEATS.items() if k not in ignored}
    assert got == want


def line_of(text: str, needle: str) -> int:
    """1-based line of the first line containing `needle` in the ORIGINAL dump."""
    for index, line in enumerate(text.splitlines(), start=1):
        if needle in line:
            return index
    raise AssertionError(f"fixture does not contain {needle!r}")


# ── A. SQL-language function bodies ─────────────────────────────────────────

A1_DUMP = (
    HEADER
    + """\
CREATE TABLE public.jobs (
    id uuid,
    status text
);

CREATE FUNCTION public.set_done(p_id uuid) RETURNS void
    LANGUAGE sql
    AS $$
UPDATE public.jobs SET status = 'done' WHERE id = $1;
$$;
"""
)

A2_DUMP = (
    HEADER
    + """\
CREATE TABLE public.users (
    name text,
    email text,
    org_id uuid
);

CREATE FUNCTION public.org_members(p_org uuid) RETURNS SETOF record
    LANGUAGE sql
    AS $$
SELECT name, email FROM public.users WHERE org_id = $1;
$$;
"""
)

A3_DUMP = (
    HEADER
    + """\
CREATE TABLE public.audit (
    actor text,
    action text
);

CREATE FUNCTION public.log_it(p_actor text, p_action text) RETURNS void
    LANGUAGE sql
    AS $$
INSERT INTO public.audit (actor, action) VALUES ($1, $2);
$$;
"""
)

A4_DUMP = (
    HEADER
    + """\
CREATE TABLE public.audit (
    actor text,
    action text
);

CREATE FUNCTION public.log_it(p_actor text, p_action text) RETURNS void
    LANGUAGE sql
    AS $$
INSERT INTO public.audit VALUES ($1, $2);
$$;
"""
)

A5_DUMP = (
    HEADER
    + """\
CREATE TABLE public.jobs (
    id uuid,
    status text
);

CREATE FUNCTION public.get_job(p_id uuid) RETURNS SETOF public.jobs
    LANGUAGE sql
    AS $$
SELECT * FROM public.jobs WHERE id = $1;
$$;
"""
)

A6_DUMP = (
    HEADER
    + """\
CREATE TABLE public.jobs (
    id uuid,
    status text,
    owner text
);

CREATE FUNCTION public.touch(p_id uuid) RETURNS void
    LANGUAGE sql
    AS $$
UPDATE public.jobs SET status = 'a' WHERE id = $1;
$$;

CREATE FUNCTION public.touch(p_status text) RETURNS SETOF text
    LANGUAGE sql
    AS $$
SELECT owner FROM public.jobs WHERE status = $1;
$$;
"""
)

A7_DUMP = (
    HEADER
    + """\
CREATE TABLE public.jobs (
    id uuid,
    status text
);

CREATE FUNCTION public.set_done(p_id uuid) RETURNS void
    LANGUAGE sql
    AS $$
UPDATE jobs SET status = 'done' WHERE id = $1;
$$;
"""
)

A8_DUMP = (
    HEADER
    + """\
CREATE TABLE public.jobs (
    id uuid,
    status text
);

CREATE FUNCTION public.zero_out(p_id uuid) RETURNS void
    LANGUAGE sql
    AS $$
UPDATE ledger SET amount = 0 WHERE id = $1;
$$;
"""
)


class TestASqlLanguageFunctionBodies:
    def test_A1_sql_body_splits_set_targets_from_where_reads(self, tmp_path):
        # Design §4: a function body is tier-1 executing text, so it reaches exact.
        # Direction is per-clause: the SET target is a write, the WHERE column a read.
        out = sidecar_for(tmp_path, A1_DUMP)
        assert rows(out) == {
            ("jobs", "status", "write", "exact", "function-body:public.set_done"),
            ("jobs", "id", "read", "exact", "function-body:public.set_done"),
        }
        assert_quiet_except(out)

    def test_A2_select_body_is_all_exact_reads(self, tmp_path):
        out = sidecar_for(tmp_path, A2_DUMP)
        assert rows(out) == {
            ("users", "name", "read", "exact", "function-body:public.org_members"),
            ("users", "email", "read", "exact", "function-body:public.org_members"),
            ("users", "org_id", "read", "exact", "function-body:public.org_members"),
        }
        assert_quiet_except(out)

    def test_A3_insert_column_list_is_exact_writes(self, tmp_path):
        out = sidecar_for(tmp_path, A3_DUMP)
        assert rows(out) == {
            ("audit", "actor", "write", "exact", "function-body:public.log_it"),
            ("audit", "action", "write", "exact", "function-body:public.log_it"),
        }
        assert_quiet_except(out)

    def test_A4_positional_insert_is_star_write_plus_caveat(self, tmp_path):
        # v1 does NOT join the table def to recover positional columns; upgrading
        # that attribution is a later measured change. The `*` write is declared
        # indirect — SIDECAR re-grades `*` writes to indirect on merge regardless.
        out = sidecar_for(tmp_path, A4_DUMP)
        assert rows(out) == {
            ("audit", "*", "write", "indirect", "function-body:public.log_it"),
        }
        assert caveats(out)["positionalInsert"] == 1
        assert_quiet_except(out, "positionalInsert")

    def test_A5_select_star_is_table_scoped_read_beside_the_exact_where_read(
        self, tmp_path
    ):
        out = sidecar_for(tmp_path, A5_DUMP)
        assert rows(out) == {
            ("jobs", "*", "read", "wildcard", "function-body:public.get_job"),
            ("jobs", "id", "read", "exact", "function-body:public.get_job"),
        }
        assert_quiet_except(out)

    def test_A6_overloads_are_parsed_independently_with_no_caveat(self, tmp_path):
        # Overload ambiguity is a reference-site concern, not a body concern: each
        # body is its own text and yields its own rows.
        out = sidecar_for(tmp_path, A6_DUMP)
        assert rows(out) == {
            ("jobs", "status", "write", "exact", "function-body:public.touch"),
            ("jobs", "id", "read", "exact", "function-body:public.touch"),
            ("jobs", "owner", "read", "exact", "function-body:public.touch"),
            ("jobs", "status", "read", "exact", "function-body:public.touch"),
        }
        assert_quiet_except(out)

    def test_A7_unqualified_name_resolves_to_the_target_schema(self, tmp_path):
        out = sidecar_for(tmp_path, A7_DUMP)
        assert rows(out) == {
            ("jobs", "status", "write", "exact", "function-body:public.set_done"),
            ("jobs", "id", "read", "exact", "function-body:public.set_done"),
        }
        assert_quiet_except(out)

    def test_A8_unresolvable_table_name_emits_no_row_and_is_counted(self, tmp_path):
        # Blindness attributable to NO table cannot become a row (design §6 rule 2),
        # so it must be counted — and it blocks invisible-surface narrowing.
        out = sidecar_for(tmp_path, A8_DUMP)
        assert rows(out) == set()
        assert caveats(out)["unresolvedTableNames"] == {"ledger": 1}
        assert_quiet_except(out, "unresolvedTableNames")


# ── B. PL/pgSQL bodies ──────────────────────────────────────────────────────

B1_DUMP = (
    HEADER
    + """\
CREATE TABLE public.t (
    a integer
);

CREATE FUNCTION public.b1() RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  v integer;
BEGIN
  IF v > 0 THEN
    INSERT INTO public.t (a) VALUES (1);
  END IF;
END;
$$;
"""
)

B2_DUMP = (
    HEADER
    + """\
CREATE TABLE public.t (
    c integer
);

CREATE FUNCTION public.b2() RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE
  v bigint;
BEGIN
  v := (SELECT count(*) FROM public.t WHERE c = 1);
  RETURN v;
END;
$$;
"""
)

B3_DUMP = (
    HEADER
    + """\
CREATE TABLE public.t (
    x integer
);

CREATE FUNCTION public.b3(tbl text) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  EXECUTE format('UPDATE %I SET x=1', tbl);
END;
$$;
"""
)

B4_DUMP = (
    HEADER
    + """\
CREATE TABLE public.t (
    x integer
);

CREATE FUNCTION public.b4() RETURNS void
    LANGUAGE plv8
    AS $$
  plv8.execute('UPDATE public.t SET x = 1');
$$;
"""
)

B5_DUMP = (
    HEADER
    + """\
CREATE TABLE public.ledger (
    id uuid,
    amount numeric
);

CREATE FUNCTION public.b5() RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_amt numeric;
BEGIN
  UPDATE public.ledger SET amount = 1 WHERE id = 1 RETURNING amount INTO STRICT v_amt;
END;
$$;
"""
)


class TestBPlpgsqlBodies:
    def test_B1_embedded_statement_inside_control_flow_is_isolated(self, tmp_path):
        # PL/pgSQL is not a SQL dialect: the producer isolates embedded SQL from the
        # procedural scaffolding and parses each statement individually.
        out = sidecar_for(tmp_path, B1_DUMP)
        assert rows(out) == {
            ("t", "a", "write", "exact", "function-body:public.b1"),
        }
        accounting = caveats(out)["plpgsqlStatementAccounting"]
        entry = next(e for e in accounting if e["object"] == "public.b1")
        assert entry["parsed"] >= 1
        assert entry["isolated"] >= entry["parsed"]
        # Control flow is skipped AND counted — the dominant function language must
        # have a stated position, not a silent one (design §6).
        assert entry["controlFlowSkipped"] >= 1
        assert_quiet_except(out, "plpgsqlStatementAccounting")

    def test_B2_count_star_is_not_a_star_column_read(self, tmp_path):
        # `count(*)` is an aggregate over rows, not a read of every column: only a
        # star in PROJECTION position earns a table-scoped `*` row (contrast A5).
        out = sidecar_for(tmp_path, B2_DUMP)
        assert rows(out) == {
            ("t", "c", "read", "exact", "function-body:public.b2"),
        }
        assert not [r for r in out["rows"] if r["column"] == "*"]
        assert_quiet_except(out, "plpgsqlStatementAccounting")

    def test_B3_dynamic_execute_is_smoke_never_attribution(self, tmp_path):
        # Blindness attributable to no table: it cannot become a row, so it is
        # counted and it blocks narrowing.
        out = sidecar_for(tmp_path, B3_DUMP)
        assert rows(out) == set()
        assert caveats(out)["dynamicSql"] == 1
        assert_quiet_except(out, "dynamicSql", "plpgsqlStatementAccounting")

    def test_B4_unsupported_language_body_is_counted_per_language(self, tmp_path):
        out = sidecar_for(tmp_path, B4_DUMP)
        assert rows(out) == set()
        assert caveats(out)["unsupportedLanguageBodies"] == {"plv8": 1}
        assert_quiet_except(out, "unsupportedLanguageBodies")

    def test_B5_unparsed_statement_with_a_known_table_becomes_a_star_row(
        self, tmp_path
    ):
        # Design §6: blindness attributable to a TABLE becomes a table-scoped `*`
        # row, so those columns land in `undecidable` rather than `unwired`.
        out = sidecar_for(tmp_path, B5_DUMP)
        assert rows(out) == {
            ("ledger", "*", "write", "indirect", "function-body:public.b5"),
        }
        unparsed = caveats(out)["unparsedStatements"]
        assert len(unparsed) == 1
        assert unparsed[0]["object"] == "public.b5"
        assert_quiet_except(out, "unparsedStatements", "plpgsqlStatementAccounting")


# ── C. Triggers ─────────────────────────────────────────────────────────────

C_DOCS_TABLE = """\
CREATE TABLE public.docs (
    id uuid,
    title text,
    state text,
    updated_at timestamp with time zone
);

"""

C1_DUMP = (
    HEADER
    + C_DOCS_TABLE
    + """\
CREATE FUNCTION public.docs_touch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.title IS DISTINCT FROM OLD.title THEN
    RAISE NOTICE 'changed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER docs_touch_trg BEFORE UPDATE ON public.docs FOR EACH ROW EXECUTE FUNCTION public.docs_touch();
"""
)

C2_DUMP = (
    HEADER
    + C_DOCS_TABLE
    + """\
CREATE FUNCTION public.docs_stamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER docs_stamp_trg BEFORE UPDATE ON public.docs FOR EACH ROW EXECUTE FUNCTION public.docs_stamp();
"""
)

C3_DUMP = (
    HEADER
    + C_DOCS_TABLE
    + """\
CREATE FUNCTION public.docs_stamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER docs_stamp_trg AFTER UPDATE ON public.docs FOR EACH ROW EXECUTE FUNCTION public.docs_stamp();
"""
)

C4_DUMP = (
    HEADER
    + """\
CREATE TABLE public.a (
    x text
);

CREATE TABLE public.b (
    x text
);

CREATE FUNCTION public.audit_row() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.x IS NULL THEN
    RAISE NOTICE 'null';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER a_audit BEFORE INSERT ON public.a FOR EACH ROW EXECUTE FUNCTION public.audit_row();

CREATE TRIGGER b_audit BEFORE INSERT ON public.b FOR EACH ROW EXECUTE FUNCTION public.audit_row();
"""
)

C5_DUMP = (
    HEADER
    + """\
CREATE TABLE public.a (
    x text
);

CREATE TABLE public.b (
    x text
);

CREATE TABLE public.audit (
    msg text
);

CREATE FUNCTION public.audit_row() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.x IS NULL THEN
    INSERT INTO public.audit (msg) VALUES ('x');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER a_audit BEFORE INSERT ON public.a FOR EACH ROW EXECUTE FUNCTION public.audit_row();

CREATE TRIGGER b_audit BEFORE INSERT ON public.b FOR EACH ROW EXECUTE FUNCTION public.audit_row();
"""
)

C_NOOP_FN = """\
CREATE FUNCTION public.noop() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN NEW;
END;
$$;

"""

C6_DUMP = (
    HEADER
    + C_DOCS_TABLE
    + C_NOOP_FN
    + """\
CREATE TRIGGER docs_when_trg BEFORE UPDATE ON public.docs FOR EACH ROW WHEN ((old.state IS DISTINCT FROM new.state)) EXECUTE FUNCTION public.noop();
"""
)

C7_DUMP = (
    HEADER
    + """\
CREATE TABLE public.items (
    id uuid,
    price numeric
);

"""
    + C_NOOP_FN
    + """\
CREATE TRIGGER items_price_trg AFTER UPDATE OF price ON public.items FOR EACH ROW EXECUTE FUNCTION public.noop();
"""
)

C8_DUMP = C1_DUMP + """\

ALTER TABLE public.docs DISABLE TRIGGER docs_touch_trg;
"""

C9_DUMP = (
    HEADER
    + C_DOCS_TABLE
    + """\
CREATE FUNCTION public.on_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.id IS NOT NULL THEN
    RAISE NOTICE 'gone';
  END IF;
  RETURN OLD;
END;
$$;

CREATE FUNCTION public.on_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.id IS NOT NULL THEN
    RAISE NOTICE 'never';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER docs_del AFTER DELETE ON public.docs FOR EACH ROW EXECUTE FUNCTION public.on_delete();

CREATE TRIGGER docs_ins AFTER INSERT ON public.docs FOR EACH ROW EXECUTE FUNCTION public.on_insert();
"""
)

C10_DUMP = (
    HEADER
    + C_DOCS_TABLE
    + """\
CREATE FUNCTION public.notify_docs() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM pg_notify('c', to_jsonb(NEW)::text);
  RETURN NEW;
END;
$$;

CREATE TRIGGER docs_notify AFTER INSERT ON public.docs FOR EACH ROW EXECUTE FUNCTION public.notify_docs();
"""
)

C11_DUMP = (
    HEADER
    + C_DOCS_TABLE
    + """\
CREATE FUNCTION public.orphan_touch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.title IS NOT NULL THEN
    RAISE NOTICE 'orphan';
  END IF;
  RETURN NEW;
END;
$$;
"""
)


class TestCTriggers:
    def test_C1_single_bound_trigger_function_attributes_new_and_old(self, tmp_path):
        # NEW and OLD collapse to ONE column row: they are two references to the
        # same column of the same bound table.
        out = sidecar_for(tmp_path, C1_DUMP)
        assert rows(out) == {
            ("docs", "title", "read", "exact", "function-body:public.docs_touch"),
        }
        title_rows = [r for r in out["rows"] if r["column"] == "title"]
        assert len(title_rows) == 1

    def test_C2_before_trigger_new_assignment_is_an_exact_write(self, tmp_path):
        out = sidecar_for(tmp_path, C2_DUMP)
        assert rows(out) == {
            (
                "docs",
                "updated_at",
                "write",
                "exact",
                "function-body:public.docs_stamp",
            ),
        }

    def test_C3_after_trigger_new_assignment_emits_no_write(self, tmp_path):
        # `NEW.col := …` in an AFTER trigger is inert — the row is already written.
        # Emitting a write here would manufacture evidence for a no-op.
        out = sidecar_for(tmp_path, C3_DUMP)
        assert not [
            r for r in out["rows"] if r["direction"] == "write" and r["table"] == "docs"
        ]
        assert rows(out) == set()

    def test_C4_multi_table_bound_function_degrades_and_says_so(self, tmp_path):
        # The G8 lesson on the SQL side: attributing one body's NEW.x as exact to
        # every bound table is attribution invariant in the thing it attributes.
        out = sidecar_for(tmp_path, C4_DUMP)
        assert rows(out) == {
            ("a", "x", "read", "indirect", "function-body:public.audit_row"),
            ("b", "x", "read", "indirect", "function-body:public.audit_row"),
        }
        assert not [r for r in out["rows"] if r["confidence"] == "exact"]
        assert "public.audit_row" in caveats(out)["multiTableBoundFunctions"]

    def test_C5_explicit_qualification_stays_exact_inside_a_multi_bound_body(
        self, tmp_path
    ):
        # Ratification note 6, pinned: only NEW./OLD. attribution degrades. An
        # explicitly schema-qualified statement is unambiguous regardless of bindings.
        out = sidecar_for(tmp_path, C5_DUMP)
        assert (
            "audit",
            "msg",
            "write",
            "exact",
            "function-body:public.audit_row",
        ) in rows(out)
        assert rows(out) == {
            ("audit", "msg", "write", "exact", "function-body:public.audit_row"),
            ("a", "x", "read", "indirect", "function-body:public.audit_row"),
            ("b", "x", "read", "indirect", "function-body:public.audit_row"),
        }

    def test_C6_trigger_when_clause_is_an_exact_read(self, tmp_path):
        # A WHEN clause is evaluated at fire time — a genuine read, not a declaration.
        out = sidecar_for(tmp_path, C6_DUMP)
        assert rows(out) == {
            (
                "docs",
                "state",
                "read",
                "exact",
                "trigger-when:public.docs.docs_when_trg",
            ),
        }

    def test_C7_update_of_event_list_is_indirect_not_exact(self, tmp_path):
        # `UPDATE OF price` is a FIRING CONDITION, not an access: it fires on the
        # column's mention in a SET list and reads nothing (downgraded from v1).
        out = sidecar_for(tmp_path, C7_DUMP)
        assert rows(out) == {
            (
                "items",
                "price",
                "read",
                "indirect",
                "trigger-event:public.items.items_price_trg",
            ),
        }

    def test_C8_disabled_trigger_caps_its_function_rows_at_indirect(self, tmp_path):
        # A disabled trigger never fires, so the tier-1 "when it runs" condition
        # fails — the trigger analogue of the RLS gate.
        out = sidecar_for(tmp_path, C8_DUMP)
        assert rows(out) == {
            ("docs", "title", "read", "indirect", "function-body:public.docs_touch"),
        }
        assert len(caveats(out)["disabledObjects"]) == 1

    def test_C9_old_is_null_in_insert_triggers(self, tmp_path):
        # Attribution is per trigger event: OLD does not exist in an INSERT trigger,
        # so the INSERT-bound body's OLD.id reference attributes to nothing.
        out = sidecar_for(tmp_path, C9_DUMP)
        assert rows(out) == {
            ("docs", "id", "read", "exact", "function-body:public.on_delete"),
        }
        assert not [
            r for r in out["rows"] if r["method"] == "function-body:public.on_insert"
        ]

    def test_C10_whole_row_use_is_a_table_scoped_read_never_silence(self, tmp_path):
        # `to_jsonb(NEW)` reads every column; the producer cannot say which, so the
        # honest row is table-scoped — and silence would be the one wrong answer.
        out = sidecar_for(tmp_path, C10_DUMP)
        assert rows(out) == {
            ("docs", "*", "read", "wildcard", "function-body:public.notify_docs"),
        }

    def test_C11_unbound_trigger_function_is_counted_never_silent(self, tmp_path):
        # A trigger function with no CREATE TRIGGER anywhere in the dump has NEW./
        # OLD. references that attribute to no table. Per design §6 that blindness
        # can carry no row, so it must be counted — and it blocks narrowing rather
        # than passing as a clean measurement.
        out = sidecar_for(tmp_path, C11_DUMP)
        assert rows(out) == set()
        assert caveats(out)["unboundTriggerFunctions"] == ["public.orphan_touch"]


# ── D. Views ────────────────────────────────────────────────────────────────

D1_DUMP = (
    HEADER
    + """\
CREATE TABLE public.users (
    id uuid,
    name text
);

CREATE VIEW public.v AS
 SELECT users.id,
    users.name
   FROM public.users;
"""
)

D2_DUMP = (
    HEADER
    + """\
CREATE TABLE public.t (
    a text,
    b text,
    c text
);

CREATE VIEW public.v_all AS
 SELECT t.a,
    t.b,
    t.c
   FROM public.t;
"""
)

D3_DUMP = (
    HEADER
    + """\
CREATE TABLE public.users (
    id uuid,
    email text
);

CREATE MATERIALIZED VIEW public.mv AS
 SELECT users.id,
    users.email
   FROM public.users
  WITH NO DATA;
"""
)

D4_DUMP = (
    HEADER
    + """\
CREATE TABLE public.base (
    a text,
    b text
);

CREATE VIEW public.v1 AS
 SELECT base.a,
    base.b
   FROM public.base;

CREATE VIEW public.v2 AS
 SELECT v1.a
   FROM public.v1;
"""
)


class TestDViews:
    def test_D1_view_definition_reads_are_exact_and_carry_the_view_identity(
        self, tmp_path
    ):
        # The distinguishing `method` is what lets a drops ledger see that dropping
        # the VIEW is the move that unlocks the table (design §4).
        out = sidecar_for(tmp_path, D1_DUMP)
        assert rows(out) == {
            ("users", "id", "read", "exact", "view-definition:public.v"),
            ("users", "name", "read", "exact", "view-definition:public.v"),
        }
        assert_quiet_except(out)

    def test_D2_expanded_star_view_reads_every_listed_column(self, tmp_path):
        # pg_dump renders views pre-expanded, so no star survives into the dump:
        # one convenience view makes every then-existing column an exact read.
        out = sidecar_for(tmp_path, D2_DUMP)
        assert rows(out) == {
            ("t", "a", "read", "exact", "view-definition:public.v_all"),
            ("t", "b", "read", "exact", "view-definition:public.v_all"),
            ("t", "c", "read", "exact", "view-definition:public.v_all"),
        }

    def test_D3_materialized_view_behaves_like_a_view(self, tmp_path):
        # Matviews are opaque to sqlglot as pg_dump emits them — the producer's
        # splitter and reader must still handle them.
        out = sidecar_for(tmp_path, D3_DUMP)
        assert rows(out) == {
            ("users", "id", "read", "exact", "view-definition:public.mv"),
            ("users", "email", "read", "exact", "view-definition:public.mv"),
        }

    def test_D4_view_chain_resolves_through_to_the_base_table(self, tmp_path):
        # Dump-local view chase, cycle-safe. Rows must never name a view as `table`:
        # the consumer merges bare names against generated types, where no view sits.
        out = sidecar_for(tmp_path, D4_DUMP)
        assert rows(out) == {
            ("base", "a", "read", "exact", "view-definition:public.v1"),
            ("base", "b", "read", "exact", "view-definition:public.v1"),
            ("base", "a", "read", "exact", "view-definition:public.v2"),
        }
        assert not [r for r in out["rows"] if r["table"] in {"v1", "v2"}]


# ── E. RLS policies ─────────────────────────────────────────────────────────

E_DOCS_TABLE = """\
CREATE TABLE public.docs (
    id uuid,
    tenant_id uuid,
    owner_id uuid
);

"""

E1_DUMP = (
    HEADER
    + E_DOCS_TABLE
    + """\
ALTER TABLE public.docs ENABLE ROW LEVEL SECURITY;

CREATE POLICY docs_tenant ON public.docs USING ((tenant_id = auth.uid()));
"""
)

E2_DUMP = (
    HEADER
    + E_DOCS_TABLE
    + """\
CREATE POLICY docs_tenant ON public.docs USING ((tenant_id = auth.uid()));
"""
)

E3_DUMP = (
    HEADER
    + E_DOCS_TABLE
    + """\
ALTER TABLE public.docs ENABLE ROW LEVEL SECURITY;

CREATE POLICY docs_admin ON public.docs USING ((get_user_role() = 'admin'::text));
"""
)

E4_DUMP = (
    HEADER
    + E_DOCS_TABLE
    + """\
ALTER TABLE public.docs ENABLE ROW LEVEL SECURITY;

CREATE POLICY docs_owner ON public.docs FOR INSERT WITH CHECK ((owner_id = auth.uid()));
"""
)


class TestERlsPolicies:
    def test_E1_enabled_policy_qual_is_an_exact_read(self, tmp_path):
        out = sidecar_for(tmp_path, E1_DUMP)
        assert rows(out) == {
            (
                "docs",
                "tenant_id",
                "read",
                "exact",
                "rls-policy:public.docs.docs_tenant",
            ),
        }
        # `auth.uid()` is a function call, not a cross-schema TABLE reference.
        assert caveats(out)["outOfScopeSchemaObjects"]["references"] == 0

    def test_E2_policy_on_an_rls_disabled_table_is_capped_at_indirect(self, tmp_path):
        # A policy on a table without ENABLE ROW LEVEL SECURITY never executes.
        out = sidecar_for(tmp_path, E2_DUMP)
        assert rows(out) == {
            (
                "docs",
                "tenant_id",
                "read",
                "indirect",
                "rls-policy:public.docs.docs_tenant",
            ),
        }
        assert len(caveats(out)["disabledObjects"]) == 1

    def test_E3_policy_naming_no_columns_emits_no_rows(self, tmp_path):
        # Not a gap: the called function's own body carries the evidence, and the
        # producer emits that first-order regardless of caller.
        out = sidecar_for(tmp_path, E3_DUMP)
        assert rows(out) == set()

    def test_E4_with_check_columns_are_exact_reads(self, tmp_path):
        out = sidecar_for(tmp_path, E4_DUMP)
        assert rows(out) == {
            ("docs", "owner_id", "read", "exact", "rls-policy:public.docs.docs_owner"),
        }


# ── F. Furniture (tier 2 — indirect, never silence, never exact) ────────────

F1_DUMP = (
    HEADER
    + """\
CREATE TABLE public.t (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text
);
"""
)

F2_DUMP = (
    HEADER
    + """\
CREATE TABLE public.t (
    qty integer,
    CONSTRAINT t_qty_check CHECK ((qty > 0))
);
"""
)

F3_DUMP = (
    HEADER
    + """\
CREATE TABLE public.t (
    a integer,
    b integer,
    CONSTRAINT t_ab_check CHECK ((a > b))
);
"""
)

F4_DUMP = (
    HEADER
    + """\
CREATE TABLE public.users (
    id uuid,
    email text
);

CREATE INDEX idx_users_email ON public.users USING btree (email);
"""
)

F5_DUMP = (
    HEADER
    + """\
CREATE TABLE public.jobs (
    owner_id uuid,
    status text
);

CREATE INDEX idx_jobs_owner ON public.jobs USING btree (owner_id) WHERE (status = 'active'::text);
"""
)

F6_DUMP = (
    HEADER
    + """\
CREATE TABLE public.t (
    a integer,
    b integer GENERATED ALWAYS AS ((a * 2)) STORED
);
"""
)

F7_DUMP = (
    HEADER
    + """\
CREATE TABLE public.parent (
    id uuid
);

CREATE TABLE public.child (
    id uuid,
    parent_id uuid
);

ALTER TABLE ONLY public.child
    ADD CONSTRAINT child_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.parent(id);
"""
)

F8_DUMP = (
    HEADER
    + """\
CREATE TABLE public.members (
    id uuid,
    email text
);

ALTER TABLE ONLY public.members
    ADD CONSTRAINT members_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.members
    ADD CONSTRAINT members_email_key UNIQUE (email);
"""
)

F9_DUMP = (
    HEADER
    + """\
CREATE TABLE public.tickets (
    ref text NOT NULL,
    note text
);
"""
)


class TestFFurniture:
    def test_F1_column_default_is_an_indirect_write(self, tmp_path):
        # A column populated only by its own DEFAULT under NOT NULL is executed
        # structure: "I looked and I cannot tell" is the only verdict that does not
        # break every insert the day a drops ledger trusts an `unwired`.
        out = sidecar_for(tmp_path, F1_DUMP)
        assert rows(out) == {
            ("t", "id", "write", "indirect", "column-default:public.t"),
        }

    def test_F2_single_column_check_is_an_indirect_read(self, tmp_path):
        out = sidecar_for(tmp_path, F2_DUMP)
        assert rows(out) == {
            ("t", "qty", "read", "indirect", "check-constraint:public.t"),
        }

    def test_F3_multi_column_check_reads_every_named_column(self, tmp_path):
        out = sidecar_for(tmp_path, F3_DUMP)
        assert rows(out) == {
            ("t", "a", "read", "indirect", "check-constraint:public.t"),
            ("t", "b", "read", "indirect", "check-constraint:public.t"),
        }

    def test_F4_plain_index_is_an_indirect_read(self, tmp_path):
        out = sidecar_for(tmp_path, F4_DUMP)
        assert rows(out) == {
            ("users", "email", "read", "indirect", "index:public.idx_users_email"),
        }

    def test_F5_partial_index_reads_the_predicate_columns_too(self, tmp_path):
        out = sidecar_for(tmp_path, F5_DUMP)
        assert rows(out) == {
            ("jobs", "owner_id", "read", "indirect", "index:public.idx_jobs_owner"),
            ("jobs", "status", "read", "indirect", "index:public.idx_jobs_owner"),
        }

    def test_F6_generated_column_reads_its_source_and_writes_itself(self, tmp_path):
        # §11.1 pinned at indirect for v1 — arguably tier 1, decided by this case.
        out = sidecar_for(tmp_path, F6_DUMP)
        assert rows(out) == {
            ("t", "a", "read", "indirect", "generated-column:public.t"),
            ("t", "b", "write", "indirect", "generated-column:public.t"),
        }

    def test_F7_foreign_key_lands_rows_on_both_tables(self, tmp_path):
        # Ratification note 5: the one furniture class whose rows land on a table
        # other than the one owning the object.
        out = sidecar_for(tmp_path, F7_DUMP)
        assert rows(out) == {
            ("child", "parent_id", "read", "indirect", "foreign-key:public.child"),
            ("parent", "id", "read", "indirect", "foreign-key:public.child"),
        }

    def test_F8_constraint_backed_indexes_are_indirect_reads(self, tmp_path):
        # A PRIMARY KEY and a UNIQUE constraint are indexes with a constraint's
        # name: executed structure over their columns. Emitting nothing for them
        # manufactures measured-looking false-dead verdicts, which design §4 names
        # as v1's worst defect.
        out = sidecar_for(tmp_path, F8_DUMP)
        assert rows(out) == {
            ("members", "id", "read", "indirect", "primary-key:public.members_pkey"),
            (
                "members",
                "email",
                "read",
                "indirect",
                "unique-constraint:public.members_email_key",
            ),
        }

    def test_F9_not_null_without_a_default_is_an_indirect_read(self, tmp_path):
        # Design §4 lists "its NOT NULL" as tier-2 furniture. A NOT NULL column with
        # no default must be supplied by every insert — executed structure whose
        # writer lives outside the dump — so the honest verdict is undecidable, not
        # unwired. A NOT NULL column that HAS a default is already carried by its
        # `column-default` row (corpus F1) and does not double-count here.
        out = sidecar_for(tmp_path, F9_DUMP)
        assert rows(out) == {
            ("tickets", "ref", "read", "indirect", "not-null:public.tickets.ref"),
        }

    def test_F9_not_null_beside_a_default_does_not_double_count(self, tmp_path):
        # F1's fixture is `id uuid DEFAULT gen_random_uuid() NOT NULL` and its row
        # set is pinned to the default row alone.
        out = sidecar_for(tmp_path, F1_DUMP)
        assert not [r for r in out["rows"] if r["method"].startswith("not-null:")]


# ── G. Schema scope and collisions ──────────────────────────────────────────

G1_DUMP = (
    HEADER
    + """\
CREATE TABLE public.jobs (
    id uuid,
    status text
);

CREATE TABLE auth.users (
    id uuid,
    email text
);

CREATE FUNCTION auth.list_emails() RETURNS SETOF text
    LANGUAGE sql
    AS $$
SELECT email FROM auth.users;
$$;
"""
)

G2_DUMP = (
    HEADER
    + """\
CREATE TABLE public.jobs (
    id uuid
);

CREATE TABLE auth.users (
    id uuid,
    email text
);

CREATE FUNCTION public.list_emails() RETURNS SETOF text
    LANGUAGE sql
    AS $$
SELECT email FROM auth.users;
$$;
"""
)

G3_DUMP = (
    HEADER
    + """\
CREATE TABLE public.users (
    id uuid,
    email text
);

CREATE TABLE auth.users (
    id uuid,
    email text
);

CREATE FUNCTION public.list_emails() RETURNS SETOF text
    LANGUAGE sql
    AS $$
SELECT email FROM users;
$$;
"""
)


class TestGSchemaScope:
    def test_G1_objects_residing_out_of_scope_emit_nothing_and_are_counted(
        self, tmp_path
    ):
        # The sidecar row has no schema field, so an `auth.users` row would land on
        # `public.users` as false-live evidence. Out-of-scope EXECUTING objects are
        # counted, and per design §6 that count gates narrowing rather than
        # discharging it.
        out = sidecar_for(tmp_path, G1_DUMP)
        assert rows(out) == set()
        assert len(caveats(out)["outOfScopeSchemaObjects"]["objects"]) == 1
        assert inventory(out)["tables"] == 1

    def test_G2_reference_into_another_schema_is_excluded_and_counted(self, tmp_path):
        out = sidecar_for(tmp_path, G2_DUMP)
        assert rows(out) == set()
        assert caveats(out)["outOfScopeSchemaObjects"]["references"] == 1
        assert caveats(out)["outOfScopeSchemaObjects"]["objects"] == []

    def test_G3_unqualified_name_resolves_to_target_schema_never_to_auth(
        self, tmp_path
    ):
        # Both `public.users` and `auth.users` exist in nearly every Supabase
        # project. Resolution is target-schema-first; had it resolved to auth.users
        # the row would be suppressed and the reference counted instead.
        out = sidecar_for(tmp_path, G3_DUMP)
        assert rows(out) == {
            ("users", "email", "read", "exact", "function-body:public.list_emails"),
        }
        assert caveats(out)["outOfScopeSchemaObjects"]["references"] == 0


# ── H. Partitions ───────────────────────────────────────────────────────────

H1_DUMP = (
    HEADER
    + """\
CREATE TABLE public.orders (
    id uuid,
    total numeric,
    created_at date
)
PARTITION BY RANGE (created_at);

CREATE TABLE public.orders_2024 PARTITION OF public.orders
FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');

CREATE FUNCTION public.record_order(p_total numeric) RETURNS void
    LANGUAGE sql
    AS $$
INSERT INTO public.orders_2024 (total) VALUES ($1);
$$;
"""
)


class TestHPartitions:
    def test_H1_partition_child_evidence_reaches_the_parent(self, tmp_path):
        # Ratification note 3: a row naming the CHILD would be dropped into
        # `evidenceUnknownTables` by the merge and the parent would read unwired.
        out = sidecar_for(tmp_path, H1_DUMP)
        assert len(out["rows"]) == 1
        row = out["rows"][0]
        assert (row["table"], row["column"], row["direction"], row["confidence"]) == (
            "orders",
            "total",
            "write",
            "exact",
        )
        # The method still carries the child identity, so the ref stays auditable.
        assert "partition:public.orders_2024" in row["method"]
        assert not [r for r in out["rows"] if r["table"] == "orders_2024"]
        assert caveats(out)["partitionAttribution"] == {
            "public.orders_2024": "public.orders"
        }


# ── I. Artefact-level behaviour ─────────────────────────────────────────────

I1_DUMP = (
    HEADER
    + r"""\restrict aBcDeFgHiJkLmNoP

CREATE TABLE public.jobs (
    id uuid,
    status text
);

CREATE FUNCTION public.set_done(p_id uuid) RETURNS void
    LANGUAGE sql
    AS $$
UPDATE public.jobs SET status = 'done' WHERE id = $1;
$$;

\unrestrict aBcDeFgHiJkLmNoP
"""
)

# I2: the two dump variants, line-for-line aligned so that "identical rows" can be
# asserted including the `line` of every ref.
I2_RAW_DUMP = (
    HEADER
    + r"""\restrict aBcDeFgHiJkLmNoP
CREATE TABLE public.jobs (
    id uuid,
    status text
);
CREATE FUNCTION public.set_done(p_id uuid) RETURNS void
    LANGUAGE sql
    AS $$
UPDATE public.jobs SET status = 'done' WHERE id = $1;
$$;
\unrestrict aBcDeFgHiJkLmNoP
"""
)

I2_SUPABASE_DUMP = (
    HEADER
    + r"""-- \restrict aBcDeFgHiJkLmNoP
CREATE TABLE IF NOT EXISTS "public"."jobs" (
    "id" uuid,
    "status" text
);
CREATE OR REPLACE FUNCTION "public"."set_done"("p_id" uuid) RETURNS void
    LANGUAGE "sql"
    AS $$
UPDATE "public"."jobs" SET "status" = 'done' WHERE "id" = $1;
$$;
-- \unrestrict aBcDeFgHiJkLmNoP
"""
)

I3_NOT_A_DUMP = """\
id,name,email
1,alice,alice@example.com
2,bob,bob@example.com
"""

I4_EMPTY_DUMP = HEADER

I5_DUMP = (
    HEADER
    + """\
CREATE TABLE public.jobs (
    id uuid,
    status text
);

CREATE FUNCTION public.set_done(p_id uuid) RETURNS void
    LANGUAGE sql
    AS $tag$
UPDATE public.jobs SET status = 'a $$ b' WHERE id = $1;
$tag$;
"""
)

I6_DUMP = (
    HEADER
    + """\
CREATE TABLE public.mixed (
    CamelCol text,
    "CamelCol" text
);

CREATE VIEW public.v_mixed AS
 SELECT mixed.CamelCol,
    mixed."CamelCol"
   FROM public.mixed;
"""
)

I7_DUMP = (
    HEADER
    + """\
CREATE TABLE public.jobs (
    id uuid,
    status text
);

CREATE FUNCTION public.i7() RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE public.jobs SET status = 'a;b' WHERE id = 1;
  EXECUTE $inner$ SELECT 1 $inner$;
END;
$$;
"""
)


class TestIArtefactLevel:
    def test_I1_restrict_meta_command_lines_do_not_shift_refs(self, tmp_path):
        # Modern pg_dump emits non-SQL psql meta-commands that crash a naive
        # whole-file parse. Stripping them must not move any ref: the splitter is
        # positional and counts lines it skips.
        out = sidecar_for(tmp_path, I1_DUMP)
        assert rows(out) == {
            ("jobs", "status", "write", "exact", "function-body:public.set_done"),
            ("jobs", "id", "read", "exact", "function-body:public.set_done"),
        }
        status_row = next(r for r in out["rows"] if r["column"] == "status")
        assert status_row["line"] == line_of(I1_DUMP, "UPDATE public.jobs")

    def test_I2_supabase_variant_matches_the_raw_variant(self, tmp_path):
        # The Supabase CLI rewrites pg_dump output (CREATE OR REPLACE, IF NOT
        # EXISTS, quoted identifiers, commented-out \restrict). Both variants are
        # ONE artefact class and must produce the same evidence.
        raw = sidecar_for(tmp_path / "raw", I2_RAW_DUMP)
        supa = sidecar_for(tmp_path / "supa", I2_SUPABASE_DUMP)

        def comparable(sidecar: dict) -> set:
            return {
                (
                    r["table"],
                    r["column"],
                    r["direction"],
                    r["confidence"],
                    r["method"],
                    r["line"],
                )
                for r in sidecar["rows"]
            }

        assert comparable(raw) == comparable(supa)
        assert comparable(raw)

    def test_I3_input_with_no_recognisable_ddl_is_a_hard_failure(self, tmp_path):
        # An unrecognisable input must never merge as an empty, clean sidecar —
        # that is exactly how "could not look" becomes "measured".
        path = write_dump(tmp_path, I3_NOT_A_DUMP, name="rows.csv")
        with pytest.raises(DumpFormatError):
            produce_sidecar(path)

    def test_I3_cli_exits_non_zero_and_writes_no_sidecar(self, tmp_path):
        path = write_dump(tmp_path, I3_NOT_A_DUMP, name="rows.csv")
        out_path = tmp_path / "sidecar.json"
        exit_code = cli_main(
            ["db-config-uses", "--dump", str(path), "--out", str(out_path)]
        )
        assert exit_code != 0
        assert not out_path.exists()

    def test_I4_empty_but_valid_dump_is_an_empty_sidecar_not_an_error(self, tmp_path):
        # Distinguishable from I3: a real dump that happens to hold no objects is a
        # measurement of zero, not a failure to measure.
        out = sidecar_for(tmp_path, I4_EMPTY_DUMP)
        assert out["rows"] == []
        assert inventory(out) == {
            "tables": 0,
            "functions": 0,
            "views": 0,
            "policies": 0,
            "triggers": 0,
        }

    def test_I5_named_dollar_quote_survives_a_double_dollar_lookalike(self, tmp_path):
        # A dollar-quote boundary mis-parse silently corrupts every file:line after
        # it — ref corruption, which is why it is fatal rather than countable.
        out = sidecar_for(tmp_path, I5_DUMP)
        assert rows(out) == {
            ("jobs", "status", "write", "exact", "function-body:public.set_done"),
            ("jobs", "id", "read", "exact", "function-body:public.set_done"),
        }

    def test_I6_unquoted_identifiers_fold_and_quoted_ones_stay_verbatim(self, tmp_path):
        # Postgres semantics, pinned so the merge against generated types is
        # deterministic (sqlglot normalises; generated types do not).
        out = sidecar_for(tmp_path, I6_DUMP)
        assert rows(out) == {
            ("mixed", "camelcol", "read", "exact", "view-definition:public.v_mixed"),
            ("mixed", "CamelCol", "read", "exact", "view-definition:public.v_mixed"),
        }

    def test_I7_splitter_holds_across_semicolon_literals_and_nested_tags(
        self, tmp_path
    ):
        # The #14 survey ruled the splitter load-bearing with no outsourcing option
        # (the only alternative splitter is GPL), so its edge cases are first-class.
        out = sidecar_for(tmp_path, I7_DUMP)
        assert inventory(out)["functions"] == 1
        assert {
            ("jobs", "status", "write", "exact", "function-body:public.i7"),
            ("jobs", "id", "read", "exact", "function-body:public.i7"),
        } <= rows(out)

    def test_I8_missing_sqlglot_errors_loudly_and_writes_nothing(
        self, tmp_path, monkeypatch
    ):
        # Unlike `column-uses`, there is NO regex fallback: a dump producer with no
        # SQL parser cannot meet the loudness floor.
        from tools.ast_dataflow_py import db_config_uses

        monkeypatch.setattr(db_config_uses, "HAVE_SQLGLOT", False)
        path = write_dump(tmp_path, A1_DUMP)
        out_path = tmp_path / "sidecar.json"
        exit_code = cli_main(
            ["db-config-uses", "--dump", str(path), "--out", str(out_path)]
        )
        assert exit_code != 0
        assert not out_path.exists()


# ── The sidecar envelope (SIDECAR.md v1 + the design's §6/§7 enrichment) ────


class TestSidecarEnvelope:
    def test_row_shape_matches_the_v1_contract(self, tmp_path):
        out = sidecar_for(tmp_path, A1_DUMP)
        assert set(out["rows"][0]) == {
            "table",
            "column",
            "direction",
            "confidence",
            "method",
            "file",
            "line",
            "source",
        }

    def test_caveat_vocabulary_is_exactly_the_corpus_vocabulary(self, tmp_path):
        out = sidecar_for(tmp_path, A1_DUMP)
        assert set(caveats(out)) == CAVEAT_KEYS

    def test_envelope_carries_snapshot_identity(self, tmp_path):
        # Design §7: a plain dump carries no timestamp, so identity is the file's
        # mtime plus the "Dumped from database version…" header lines.
        path = write_dump(tmp_path, A1_DUMP)
        out = produce_sidecar(path)
        assert out["generatedBy"] == "db-config-uses"
        assert out["snapshot"]["path"] == str(path)
        assert isinstance(out["snapshot"]["mtimeIso"], str)
        assert any(
            "Dumped from database version" in header
            for header in out["snapshot"]["headers"]
        )

    def test_cli_writes_the_sidecar_to_out(self, tmp_path):
        path = write_dump(tmp_path, A1_DUMP)
        out_path = tmp_path / "sidecar.json"
        exit_code = cli_main(
            ["db-config-uses", "--dump", str(path), "--out", str(out_path)]
        )
        assert exit_code == 0
        sidecar = json.loads(out_path.read_text(encoding="utf-8"))
        assert sidecar["schemaVersion"] == 1
        assert sidecar["source"] == "ast-dataflow-dbconfig"

    def test_cli_requires_a_dump_path(self):
        assert cli_main(["db-config-uses"]) == 2

    def test_schema_flag_retargets_the_producer(self, tmp_path):
        # `--schema` moves the target schema set; `auth` objects then emit rows and
        # `public` ones become the out-of-scope class.
        out = sidecar_for(tmp_path, G1_DUMP, schema="auth")
        assert rows(out) == {
            ("users", "email", "read", "exact", "function-body:auth.list_emails"),
        }


# ── Global invariants, swept over EVERY fixture output ──────────────────────

# Every fixture that produces a sidecar. I3 is excluded: it is the hard-failure
# case and by definition has no output to sweep.
CORPUS_DUMPS: dict[str, str] = {
    "A1": A1_DUMP,
    "A2": A2_DUMP,
    "A3": A3_DUMP,
    "A4": A4_DUMP,
    "A5": A5_DUMP,
    "A6": A6_DUMP,
    "A7": A7_DUMP,
    "A8": A8_DUMP,
    "B1": B1_DUMP,
    "B2": B2_DUMP,
    "B3": B3_DUMP,
    "B4": B4_DUMP,
    "B5": B5_DUMP,
    "C1": C1_DUMP,
    "C2": C2_DUMP,
    "C3": C3_DUMP,
    "C4": C4_DUMP,
    "C5": C5_DUMP,
    "C6": C6_DUMP,
    "C7": C7_DUMP,
    "C8": C8_DUMP,
    "C9": C9_DUMP,
    "C10": C10_DUMP,
    "C11": C11_DUMP,
    "D1": D1_DUMP,
    "D2": D2_DUMP,
    "D3": D3_DUMP,
    "D4": D4_DUMP,
    "E1": E1_DUMP,
    "E2": E2_DUMP,
    "E3": E3_DUMP,
    "E4": E4_DUMP,
    "F1": F1_DUMP,
    "F2": F2_DUMP,
    "F3": F3_DUMP,
    "F4": F4_DUMP,
    "F5": F5_DUMP,
    "F6": F6_DUMP,
    "F7": F7_DUMP,
    "F8": F8_DUMP,
    "F9": F9_DUMP,
    "G1": G1_DUMP,
    "G2": G2_DUMP,
    "G3": G3_DUMP,
    "H1": H1_DUMP,
    "I1": I1_DUMP,
    "I2raw": I2_RAW_DUMP,
    "I2supabase": I2_SUPABASE_DUMP,
    "I4": I4_EMPTY_DUMP,
    "I5": I5_DUMP,
    "I6": I6_DUMP,
    "I7": I7_DUMP,
}

CASE_IDS = sorted(CORPUS_DUMPS)


@pytest.fixture(scope="module")
def all_outputs(tmp_path_factory) -> dict[str, tuple[dict, str, Path]]:
    """(sidecar, dump text, dump path) for every corpus fixture."""
    base = tmp_path_factory.mktemp("corpus")
    produced: dict[str, tuple[dict, str, Path]] = {}
    for case_id, text in CORPUS_DUMPS.items():
        case_dir = base / case_id
        case_dir.mkdir()
        path = write_dump(case_dir, text)
        produced[case_id] = (produce_sidecar(path), text, path)
    return produced


class TestGlobalInvariants:
    @pytest.mark.parametrize("case_id", CASE_IDS)
    def test_invariant_I1_no_named_column_write_is_wildcard(self, case_id, all_outputs):
        # Ratification note 2: the verdict engine has no `writes.wildcard` branch,
        # so such a row is recorded and then IGNORED. Write-side uncertainty must be
        # `indirect`, or table-scoped `*`.
        sidecar, _, _ = all_outputs[case_id]
        offenders = [
            r
            for r in sidecar["rows"]
            if r["direction"] == "write"
            and r["column"] != "*"
            and r["confidence"] == "wildcard"
        ]
        assert offenders == []

    @pytest.mark.parametrize("case_id", CASE_IDS)
    def test_invariant_I2_positive_inventory_is_always_present(
        self, case_id, all_outputs
    ):
        # Caveats count what was SEEN; they are silent about what was never in the
        # file. Without a positive inventory an under-privileged or truncated dump
        # merges clean and converts "could not look" into "measured".
        sidecar, _, _ = all_outputs[case_id]
        found = sidecar["objectsFound"]
        assert set(found) == INVENTORY_KEYS
        assert all(isinstance(v, int) and v >= 0 for v in found.values())

    @pytest.mark.parametrize("case_id", CASE_IDS)
    def test_invariant_I3_schema_version_and_source(self, case_id, all_outputs):
        sidecar, _, _ = all_outputs[case_id]
        assert sidecar["schemaVersion"] == 1
        assert sidecar["source"] == "ast-dataflow-dbconfig"

    @pytest.mark.parametrize("case_id", CASE_IDS)
    def test_invariant_I4_method_carries_the_containing_object_identity(
        self, case_id, all_outputs
    ):
        # Dump line numbers shift on every regeneration, so the row's own `method`
        # is what keeps it interpretable after the file moves under it (design §5).
        sidecar, _, _ = all_outputs[case_id]
        for row in sidecar["rows"]:
            segments = row["method"].split(";")
            assert segments, row
            for index, segment in enumerate(segments):
                assert ":" in segment, row
                cls, identity = segment.split(":", 1)
                assert cls in METHOD_CLASSES, row
                # Identity is schema-qualified, so the row names its object even
                # once the file has moved under it.
                assert "." in identity, row
                assert identity.split(".")[0] == "public", row
                if index == 0:
                    assert cls != "partition", row

    @pytest.mark.parametrize("case_id", CASE_IDS)
    def test_invariant_I5_refs_point_at_original_dump_lines(
        self, case_id, all_outputs
    ):
        # `file` is the dump path AS SUPPLIED; `line` is a line of the ORIGINAL
        # file — stripping \restrict and comment lines must not shift refs.
        sidecar, text, path = all_outputs[case_id]
        total_lines = len(text.splitlines())
        for row in sidecar["rows"]:
            assert row["file"] == str(path), row
            assert isinstance(row["line"], int), row
            assert 1 <= row["line"] <= total_lines, row

    @pytest.mark.parametrize("case_id", CASE_IDS)
    def test_invariant_caveat_vocabulary_is_closed(self, case_id, all_outputs):
        # An unknown caveat key is an unreviewed blindness channel; a missing one is
        # a silent one. Both are floor violations, so the vocabulary is exact.
        sidecar, _, _ = all_outputs[case_id]
        assert set(sidecar["caveats"]) == CAVEAT_KEYS

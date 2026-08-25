# The DB-config acceptance corpus

**Status: authored as the §10.2 gate of [`db-config-export.md`](./db-config-export.md);
the implementation loop treats this file as the test oracle source.** Every case below
becomes a fixture + assertion in `scripts/tests/test_ast_dataflow_py_db_config.py` before
any detector code is written — the T1 lesson applied to the SQL surface. Fixtures are
pg_dump-style SQL snippets; expectations are sidecar rows
`(table, column, direction, confidence, method)` plus caveat and inventory fields, in the
style of the existing declarative-writes tests.

Two decisions this file settles (design §11.4, ratification note 7, both on the critical
path): the producer is the CLI subcommand **`db-config-uses --dump <path>`** on the
existing Python CLI, and its sidecar `source` value is **`ast-dataflow-dbconfig`**.

## Global invariants (asserted over every fixture's output)

- **I1** — no row ever has direction `write`, a named column, and confidence `wildcard`
  (ratification note 2: the verdict engine has no `writes.wildcard` branch; such a row is
  recorded and then ignored). Write-side uncertainty is `indirect` or a table-scoped `*`.
- **I2** — the positive inventory (`objectsFound` per class: tables, functions, views,
  policies, triggers) is present in every output, including empty ones.
- **I3** — `schemaVersion` is 1 and `source` is `ast-dataflow-dbconfig`.
- **I4** — every row's `method` carries the containing object's identity
  (`view-definition:public.v_orders`, `function-body:public.claim_job`, …).
- **I5** — `file` is the dump path as supplied; `line` numbers refer to the ORIGINAL dump
  lines — stripping `\restrict` / comment lines must not shift refs (parse positionally).

## A. SQL-language function bodies

| #   | fixture                                                                                             | expect                                                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | `LANGUAGE sql` body: `UPDATE public.jobs SET status='done' WHERE id=$1`                             | exact write `jobs.status`; exact read `jobs.id`                                                                                                             |
| A2  | body: `SELECT name, email FROM public.users WHERE org_id=$1`                                        | exact reads `users.name`, `users.email`, `users.org_id`                                                                                                     |
| A3  | body: `INSERT INTO public.audit(actor, action) VALUES ($1,$2)`                                      | exact writes `audit.actor`, `audit.action`                                                                                                                  |
| A4  | body: `INSERT INTO public.audit VALUES ($1,$2)` (no column list)                                    | table-scoped `*` write on `audit` + `positionalInsert` caveat — v1 does NOT join the table def; upgrading positional attribution is a later measured change |
| A5  | body: `SELECT * FROM public.jobs WHERE id=$1`                                                       | `*` read on `jobs` (wildcard on merge); exact read `jobs.id`                                                                                                |
| A6  | two `CREATE FUNCTION public.f` overloads, different arg lists, both bodies with distinct statements | each body parsed independently; rows from both; no caveat (overload ambiguity is a reference-site concern, not a body concern)                              |
| A7  | body references unqualified `jobs` where `public.jobs` exists in the dump                           | resolves to `public.jobs`, rows as A1                                                                                                                       |
| A8  | body references unqualified `ledger` matching nothing in the dump                                   | no row; `unresolvedTableNames` +1                                                                                                                           |

## B. PL/pgSQL bodies

| #   | fixture                                                                                  | expect                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | plpgsql: `DECLARE v int; BEGIN IF x THEN INSERT INTO public.t(a) VALUES(1); END IF; END` | exact write `t.a`; `plpgsqlStatementAccounting` records statements isolated vs parsed for the body                                                            |
| B2  | plpgsql: `v := (SELECT count(*) FROM public.t WHERE c=1);`                               | exact read `t.c`; (`count(*)` is not a column read of `*` — no `*` row)                                                                                       |
| B3  | plpgsql with `EXECUTE format('UPDATE %I SET x=1', tbl)`                                  | no attribution row; `dynamicSql` +1 (blindness attributable to no table — blocks narrowing)                                                                   |
| B4  | `LANGUAGE plv8` function                                                                 | no rows; `unsupportedLanguageBodies['plv8']` +1 (blocks narrowing)                                                                                            |
| B5  | plpgsql body where a statement fails to parse                                            | that statement in `unparsedStatements`; if its target table is identifiable, a `*` row on it (design §6: blindness attributable to a table becomes a `*` row) |

## C. Triggers

| #   | fixture                                                                                                   | expect                                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | fn bound by ONE enabled trigger on `public.docs`; body: `IF NEW.title IS DISTINCT FROM OLD.title`         | exact reads `docs.title` (NEW and OLD collapse to one column)                                                                                             |
| C2  | BEFORE trigger, body: `NEW.updated_at := now();`                                                          | exact write `docs.updated_at`                                                                                                                             |
| C3  | AFTER trigger, body: `NEW.updated_at := now();`                                                           | NO write row (inert in AFTER); the read side of the expression, if any, still counts                                                                      |
| C4  | one fn bound by triggers on `public.a` AND `public.b`; body reads `NEW.x`                                 | NO exact rows; `indirect` (or `*`) rows on both `a` and `b` + `multiTableBoundFunctions` +1                                                               |
| C5  | same multi-bound fn ALSO contains `INSERT INTO public.audit(msg) VALUES('x')`                             | exact write `audit.msg` — explicit qualification is unambiguous regardless of bindings (ratification note 6, pinned: only NEW./OLD. attribution degrades) |
| C6  | `CREATE TRIGGER ... WHEN (OLD.state IS DISTINCT FROM NEW.state)` (enabled)                                | exact read `<table>.state`, method `trigger-when:…`                                                                                                       |
| C7  | `CREATE TRIGGER ... AFTER UPDATE OF price ON public.items`                                                | `indirect` read `items.price`, method `trigger-event:…` (a firing condition, not an access)                                                               |
| C8  | trigger from C1 plus `ALTER TABLE public.docs DISABLE TRIGGER trg`                                        | C1's rows capped at `indirect`; `disabledObjects` +1                                                                                                      |
| C9  | DELETE trigger body reads `OLD.id`; separate INSERT trigger body reads `OLD.id`                           | DELETE: exact read. INSERT: no row (`OLD` is null in INSERT triggers)                                                                                     |
| C10 | body: `PERFORM pg_notify('c', to_jsonb(NEW)::text)`                                                       | table-scoped `*` read on the bound table, never silence                                                                                                   |
| C11 | a `RETURNS trigger` function with `NEW.x` references and NO `CREATE TRIGGER` binding anywhere in the dump | NO rows; `unboundTriggerFunctions` +1 — the references attribute to no table, so §6 forbids a row and requires a count that blocks narrowing              |

## D. Views

| #   | fixture                                                                           | expect                                                                                                             |
| --- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| D1  | `CREATE VIEW public.v AS SELECT id, name FROM public.users;`                      | exact reads `users.id`, `users.name`, method `view-definition:public.v`                                            |
| D2  | expanded-star view (pg_dump renders `SELECT *` pre-expanded to all columns)       | exact reads on every listed column — the documented §4 consequence, pinned                                         |
| D3  | `CREATE MATERIALIZED VIEW` with named columns                                     | same as D1 (matviews are opaque to sqlglot as pg_dump emits them — the producer's splitter must still handle them) |
| D4  | `public.v2 AS SELECT a FROM public.v1` where `v1 AS SELECT a, b FROM public.base` | v2's read resolves THROUGH v1 to `base.a` (dump-local view chase, cycle-safe); rows never name a view as `table`   |

## E. RLS policies

| #   | fixture                                                                | expect                                                                                     |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| E1  | `ENABLE ROW LEVEL SECURITY` + policy `USING (tenant_id = auth.uid())`  | exact read `<table>.tenant_id`, method `rls-policy:…`                                      |
| E2  | same policy, table WITHOUT the ENABLE statement                        | `indirect` read + `disabledObjects` +1 (a policy that cannot execute)                      |
| E3  | policy `USING (get_user_role() = 'admin')` — function call, no columns | no rows from the policy (the called function's own body carries the evidence, first-order) |
| E4  | policy `WITH CHECK (owner_id = auth.uid())` (enabled)                  | exact read `<table>.owner_id`                                                              |

## F. Furniture (tier 2 — `indirect`, never silence, never `exact`)

| #   | fixture                                                                   | expect                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | `col uuid DEFAULT gen_random_uuid()`                                      | indirect WRITE on the column, method `column-default`                                                                                                                                                                                                                                   |
| F2  | single-column `CHECK (qty > 0)`                                           | indirect read `qty`, method `check-constraint`                                                                                                                                                                                                                                          |
| F3  | multi-column `CHECK (a > b)`                                              | indirect reads `a` AND `b`                                                                                                                                                                                                                                                              |
| F4  | plain index on `email`                                                    | indirect read `email`, method `index`                                                                                                                                                                                                                                                   |
| F5  | partial index `WHERE status = 'active'`                                   | indirect reads on the indexed column AND `status`                                                                                                                                                                                                                                       |
| F6  | generated column `b AS (a * 2) STORED`                                    | indirect read `a`, indirect write `b` (§11.1 pinned at indirect for v1)                                                                                                                                                                                                                 |
| F7  | FK `child.parent_id REFERENCES parent(id)`                                | indirect read `child.parent_id` AND indirect read `parent.id` — the one furniture class whose rows land on a different table than the object (ratification note 5)                                                                                                                      |
| F8  | `ADD CONSTRAINT … PRIMARY KEY (id)` and `ADD CONSTRAINT … UNIQUE (email)` | indirect read on each constrained column, methods `primary-key:…` / `unique-constraint:…` — constraint-backed indexes are indexes, and silence here manufactures false-dead verdicts                                                                                                    |
| F9  | a column declared `NOT NULL` with no default                              | indirect read on that column, method `not-null:<table>.<column>` — §4 lists "its NOT NULL" as tier 2; every insert must supply it, so `undecidable` is the honest verdict. A `NOT NULL` column that HAS a default is carried by its `column-default` row (F1) and is not double-counted |

## G. Schema scope and collisions

| #   | fixture                                                                                    | expect                                                                                    |
| --- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| G1  | dump contains `auth.users` objects and a function residing in `auth`                       | no rows from them; `outOfScopeSchemaObjects` +1 per executing object (blocks narrowing)   |
| G2  | function residing in `public` reading `auth.users.email`                                   | no row (reference into a non-target schema); `outOfScopeSchemaObjects` reference count +1 |
| G3  | dump has BOTH `public.users` and `auth.users`; a public function reads unqualified `users` | resolves to `public.users` (target-schema resolution); never to `auth.users`              |

## H. Partitions

| #   | fixture                                                                                     | expect                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | `orders_2024` is `PARTITION OF public.orders`; a function inserts into `orders_2024(total)` | exact write attributed to **`orders.total`** (parent), method carrying the child identity; `partitionAttribution` +1. Rows must never name the child (the merge would drop them into `evidenceUnknownTables` and the parent would read unwired — ratification note 3) |

## I. Artefact-level behaviour

| #   | fixture                                                                                                          | expect                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | dump with `\restrict` / `\unrestrict` lines (modern pg_dump)                                                     | parsed clean; a known row's `line` still matches its ORIGINAL dump line (invariant I5)                                                                                                                     |
| I2  | Supabase-variant dump (`CREATE OR REPLACE FUNCTION`, `IF NOT EXISTS`, quoted identifiers, commented `\restrict`) | identical rows to the raw-variant equivalent                                                                                                                                                               |
| I3  | input with no recognisable DDL (e.g. a CSV)                                                                      | hard error, non-zero exit, NO sidecar written                                                                                                                                                              |
| I4  | empty-but-valid dump (headers only)                                                                              | sidecar with zero rows, inventory all zeros — distinguishable from I3                                                                                                                                      |
| I5  | `$tag$ … $$ … $tag$` — dollar-quoted body containing a `$$` lookalike                                            | body extracted correctly; rows as normal                                                                                                                                                                   |
| I6  | unquoted `CamelCol` vs quoted `"CamelCol"` in DDL                                                                | unquoted folds to `camelcol` (Postgres semantics); quoted stays verbatim — pinned so merge against generated types is deterministic                                                                        |
| I7  | a body containing `';'` inside a string literal, and a `$inner$…$inner$` quote nested in a `$$` body             | the splitter holds: one function, rows as normal. The #14 survey ruled the splitter load-bearing with no outsourcing option (the only alternative splitter is GPL), so its edge cases are first-class here |
| I8  | sqlglot not importable                                                                                           | `db-config-uses` errors loudly and writes no sidecar — a dump producer with no SQL parser cannot meet the loudness floor, so there is no regex fallback (unlike `column-uses`)                             |

## Out of scope for this corpus (recorded so absence is deliberate)

- The **consumer-side** behaviours: inventory-gated `invisibleSurfaces` narrowing, the new
  source key, `method` surfacing (design §9's three consumer changes). Those get their own
  TS tests in the consumer loop — and per ratification note 1, the source key and the
  inventory gate must land in the SAME commit there.
- The **migrations-SQL producer** (sibling, reads repo files) — its corpus comes with its
  slice.
- Positional-INSERT column attribution via table-def join (A4 pins the conservative v1).

## Extensions ratified during the implementation loop

C11, F8 and F9 were added after the first red-test pass, when the implementation loop
surfaced two omissions the original table set did not cover: constraint-backed indexes and
bare `NOT NULL` (design §4 names "its NOT NULL" as tier-2 furniture explicitly, and the
ratification's false-dead analysis leaned on exactly these objects), and trigger functions
with no binding (silence there violates the §6 floor — blindness attributable to no table
must block narrowing rather than merge clean). The caveat vocabulary is consequently
closed at twelve keys, `unboundTriggerFunctions` being the twelfth. The global invariants
are unchanged.

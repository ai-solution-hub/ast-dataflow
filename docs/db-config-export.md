# Design: the DB-config export as producer input

**Status: ratified (2026-08-20), v3.** This answers
[#15](https://github.com/ai-solution-hub/ast-dataflow/issues/15) — what exporting database
configuration unlocks, and in what form producers should consume it. Draft v1 was reviewed
by an adversarial design pass, an external-claims fact-check (pg_dump, Supabase CLI,
sqlglot, and Postgres drop semantics, verified empirically on live systems), and a
read-only catalog survey of a real consumer database. Every §4 classification below
carries the outcome of that review. A senior-staff ratification review of v2 returned
RATIFY-WITH-EDITS; this version carries all six edits. The decision in §2 settles a
contract and graduates to ADR 0003, provisional on the two gates in §10; the rest stays
here as the design record. ADR 0003's Consequences must carry two things the design record
alone will not enforce: that §6's loudness floor — in particular that `invisibleSurfaces`
narrowing is gated on positive inventory _and_ on the surface having been measured
completely enough to withdraw the warning — binds any #13 producer built on this input;
and that neither accepted producing path meets issue #15's non-technical-user constraint
(§3.3), which is deferred to §11.2 rather than satisfied by this decision.

## 1. The problem

`schema-coverage` merges evidence from any producer via the sidecar contract
([`SIDECAR.md`](./SIDECAR.md)), but three schema surfaces remain structurally invisible to
every producer that exists
([#13](https://github.com/ai-solution-hub/ast-dataflow/issues/13)): Postgres function and
RPC bodies, migrations SQL, and API-exposing views. Migrations are already files in the
target repo, so that producer needs no new input. The rest — function bodies, view
definitions, triggers, row-level-security policies — live only in the database catalog.

A producer could read them over a live connection at query time. The decisive objection is
**auditability**: an evidence ref must be openable by a reviewer, and `db-config.sql:143`
is a file on disk where `pg_proc` oid 16412 is not. Secondary objections: a connection
string inside a static-analysis tool's process is an avoidable liability, and a snapshot
file makes "which schema state produced this verdict" a fact about an artefact rather than
a memory about a moment. (A live-connection producer could still emit a point-in-time
sidecar — reproducibility alone does not decide this; the openable ref does.)

Two constraints carried verbatim from the issue:

- the export must be producible by a non-technical user (the "vibe coder on Supabase"
  persona from the market scan), and
- their data must stay local.

## 2. The decision (proposed)

**The producer input is a schema-only Postgres SQL dump. Producers never open a database
connection, and no bespoke export format is invented.** Two dump variants are accepted as
one artefact class: raw `pg_dump` plain output, and the Supabase CLI's `db dump` output —
which is _not_ literal pg_dump text (the CLI rewrites it: `CREATE OR REPLACE`,
`IF NOT EXISTS`, quoted identifiers, commented-out `\restrict` lines). The parser must
take both.

Reasons, in order of weight:

1. **Auditability.** SIDECAR.md renders `file:line` verbatim and requires refs to be
   self-identifying. A dump is a real local file a reviewer can open; no synthetic `db://`
   URI scheme is needed.
2. **Platform independence.** A `pg_dump`-format input works for any Postgres project.
   Supabase is the friendliest producing path, not a dependency — which keeps this tool an
   independent surface rather than an appendage of any one platform.
3. **Build-versus-integrate, applied to the export half.** The standing directive
   ([#14](https://github.com/ai-solution-hub/ast-dataflow/issues/14)) is to not replicate
   what exists: `pg_dump --schema-only` and `supabase db dump` already produce this
   artefact in one command. (The same directive applies to the _analysis_ half — see the
   §10 survey gate. One honest concession from review: a catalog export would carry
   `pg_depend`, which records column-level dependency for views, policies, constraints and
   generated columns authoritatively. It cannot see into function bodies — Postgres tracks
   no dependencies through them, and a function survives a column drop _broken_ — and
   function bodies are this feature's headline surface, so `pg_depend` is a complement for
   a future drop-planning consumer, not a substitute for the dump parse.)
4. **A rejected alternative, named:** the Supabase management API (browser OAuth, no local
   tooling) is plausibly the friendliest export path for the persona, and schema-only
   content arguably satisfies "data stays local". It is rejected _as the contract_ because
   it is platform-specific (violates reason 2) and builds an exporter (violates reason 3).
   It stays open as a possible convenience _front-end_ that produces the same dump file
   (§11).

What review removed from this section: the claim that the parsing machinery "already
exists". It half-exists. sqlglot parses the dump's structural DDL (tables, views,
triggers, indexes, most ALTERs) but treats `CREATE FUNCTION` and `CREATE POLICY` — the two
highest-value classes — as opaque `Command` nodes, and PL/pgSQL is not a SQL dialect. The
producer must split statements itself, extract dollar-quoted bodies, and parse the SQL
statements _inside_ them individually, with control flow (`DECLARE`, `IF`, assignments)
skipped and accounted for (§6). The degradation discipline exists; the extraction layer is
new work.

## 3. Producing the snapshot

Documented as a ladder with real prerequisites — review established both paths are less
"one command" than draft v1 claimed, and the persona constraint is genuinely strained. All
paths run locally and move no row data.

1. **Supabase CLI** — `supabase db dump -f db-config.sql`. Schema-only by default; user
   schemas only (internal schemas — `auth`, `storage`, `extensions`, etc. — are excluded
   by design). **Prerequisites: a linked project (`supabase link`) or `--db-url`, and
   Docker** — the CLI runs pg_dump in a container. For included schemas the dump does
   contain function bodies, views, triggers, and RLS policies.
2. **pg_dump directly** —
   `pg_dump --schema-only --no-owner --no-privileges -f db-config.sql "$DATABASE_URL"`.
   Verified: the schema-only dump contains every §4 object class, all function bodies
   verbatim regardless of language. Prerequisite: a connection string, which the persona
   may find hostile.
3. **SQL-editor fallback** — deferred, as in v1, but the persona gap is now measured
   rather than suspected: _neither_ path above is truly non-technical. Whether this tool
   ships a convenience front-end (or documents the management API as one) is an open
   product question (§11), separate from the input contract.

**Parser-facing facts about the artefact, from the fact-check:** modern pg_dump
(post-2025-08 security releases) emits non-SQL `\restrict` / `\unrestrict` psql
meta-command lines that crash a naive whole-file parse — the producer strips or splits
around them; the Supabase variant comments them out. Plain output carries no timestamp —
only "Dumped from database version X / by pg_dump version Y" header lines (§7).

**Privacy note, stated because the persona constraint demands it:** a schema-only dump
contains no row data (sequence values included). Column DEFAULT literals and SQL comments
can in principle embed fixed values; the artefact stays on the user's machine either way,
and the producer sends nothing anywhere.

## 4. What each object class unlocks

Draft v1 stated a survival test here ("evidence only if the referencing object would
survive the column's drop"). Review refuted it against actual Postgres drop semantics:
views, policies and generated columns do _not_ survive a referenced column's drop (the
drop fails without `CASCADE`), while function bodies _do_ survive, broken — the server
tracks no dependencies through them. Taken literally the test inverted its own table. The
rule that survives review is about **ownership and execution**, in two tiers:

> **Tier 1 — independent objects that execute access.** An object with an identity of its
> own — a view, a function body, a policy, a trigger — whose text _reads or writes_ the
> column when it runs. These can reach `exact`, subject to the per-class rules below.
>
> **Tier 2 — the column's own structural furniture.** Objects that exist to serve the
> column itself: its DEFAULT, its NOT NULL, its CHECK constraints, its indexes, a
> generated column's expression. These are emitted as **`indirect` rows, never silence and
> never `exact`**. `indirect` cannot wire a column (SIDECAR.md quarantines it into
> `undecidable`), but it _can_ pull a column out of `unwired` — which is precisely
> correct, and drops-ledger-critical: a column populated only by its own
> `DEFAULT gen_random_uuid()` under `NOT NULL` is executed structure, and "I looked and I
> cannot tell" is the only verdict that doesn't break every insert the day the ledger
> trusts an `unwired`. Emitting nothing for furniture was v1's worst defect: it
> manufactured measured-looking false-dead verdicts.

This is ADR 0002's declaration-is-never-proof discipline _argued_, not merely restated:
declarations (structure) are capped below wiring strength, while executable text — and a
view or function body is code that runs, unlike a `TableSchema` literal which is data a
library may or may not honour — can prove access. The scanner already counts a read inside
a never-called TypeScript function; first-order treatment of a never-called SQL function
is the same discipline (see the end of this section).

| object class                             | yields                                                                                                                                                         | ceiling                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| function / procedure bodies (incl. RPC)  | read/write rows per embedded SQL statement                                                                                                                     | `exact` (unambiguous binding); else `*` + caveat                         |
| trigger-bound function bodies            | `NEW.col` / `OLD.col` refs attributed to the bound table — **only when the function is bound to exactly one table**                                            | `exact` (single binding, enabled trigger); `indirect` + caveat otherwise |
| trigger `WHEN` clauses                   | `OLD.x IS DISTINCT FROM NEW.x` — a genuine read, evaluated at fire time                                                                                        | `exact` (enabled); `indirect` + caveat (disabled)                        |
| trigger `UPDATE OF col` event lists      | a firing condition, not an access — fires on the column's _mention_ in a SET list and reads nothing                                                            | `indirect` (downgraded from v1's `exact`)                                |
| views and materialised views             | the definition's SELECT — reads of referenced columns                                                                                                          | `exact`, with the expansion warning below                                |
| row-level-security policies              | column refs in `USING` / `WITH CHECK` — **gated on `ENABLE ROW LEVEL SECURITY` being present for the table**; a policy on an RLS-disabled table never executes | `exact` (enabled); `indirect` + caveat (disabled)                        |
| tables                                   | column resolution for everything else, plus a drift cross-check against the target repo's generated types                                                      | not evidence; the resolver                                               |
| constraints, defaults, generated columns | tier-2 furniture rows, one per referenced column                                                                                                               | `indirect`                                                               |
| indexes                                  | tier-2 furniture rows                                                                                                                                          | `indirect`                                                               |
| extensions                               | context only (which types exist to parse)                                                                                                                      | none                                                                     |

Per-class rules review forced, each closing a measured or demonstrated failure shape:

- **Multi-binding degradation (the G8 lesson, SQL side).** `set_updated_at()` and
  `audit_row()`-style functions are bound to many tables; attributing one body's
  `NEW.order_no` as `exact` to every bound table is attribution invariant in the thing it
  claims to attribute — G8's fingerprint. A function with more than one table binding
  emits `indirect` (or table-scoped `*`) rows plus a `multiTableBoundFunctions` caveat.
  `to_jsonb(NEW)` / `row_to_json(NEW)` whole-row uses emit a table-scoped `*` row, never
  silence. `NEW.col := …` in an AFTER trigger is inert and must not emit a write. `NEW` is
  null in DELETE triggers and `OLD` in INSERT triggers — attribution is per trigger event.
  A disabled trigger (`ALTER TABLE … DISABLE TRIGGER`) never fires, so its body and its
  `WHEN` clause are capped at `indirect` with a `disabledObjects` caveat — the trigger
  analogue of the RLS gate, and the same tier-1 "when it runs" condition.
- **The view-expansion warning.** pg_dump renders views in rewritten form: a `SELECT *` is
  already expanded to an explicit column list at view-creation time, so v1's "`SELECT *`
  emits a `*` row" mitigation can never fire — no star survives into the dump.
  Consequence, stated so no reader discovers it: **one convenience view over a table makes
  every then-existing column of that table an exact read**, and no column of that table
  can verdict `write-only` or `unwired` while the view stands. That is a true fact about
  the database (the view does read them) — but a drops ledger must know that dropping the
  _view_ is the move that unlocks the table, so view-derived rows carry a distinguishing
  `method`, compound with the object's identity (`view-definition:public.v_orders`).
- **Schema qualification, stated because the sidecar row has no schema field.** The
  consumer merges bare table names against the target repo's generated `public` types, so
  an unqualified `auth.users` row would land on `public.users` as false-live evidence —
  and both exist in nearly every Supabase project. Rule: only objects in the target schema
  set (default `public`) emit rows; references into other schemas are excluded and counted
  (`outOfScopeSchemaObjects`). The converse is not symmetric with it and is the dangerous
  direction: a function, view or policy _residing_ in a non-target schema may still read
  or write a target-schema column, and excluding it produces silence on that column rather
  than a false positive. `outOfScopeSchemaObjects` is a global integer, and §6's rule 2
  forbids an integer from discharging per-column blindness — so out-of-scope executing
  objects gate the §6 narrowing rule rather than being merely counted.
- **Policies that reference no columns.** The live-catalog survey found most policy quals
  are function calls (`get_user_role() = ANY(…)`) or bare `true`, not column references.
  That is fine, not a gap: the called function's _body_ carries the column evidence, and
  the function-body producer emits it first-order regardless of caller. Policy rows exist
  only where the qual names columns.

**First-order evidence only, by design.** A read inside a function nothing calls, or a
view nothing queries, still counts — exactly as a read inside a never-called TypeScript
function counts today. Transitive liveness is a different analysis and out of scope. One
honesty note from review: first-order treatment fails conservative ("don't drop") on the
transitive side, while _suppressing_ evidence fails dangerous ("safe to drop") — which is
why tier 2 emits `indirect` rather than nothing.

## 5. Evidence refs

`file` is the dump path as the caller supplied it; `line` is the statement's line within
that dump. Two honesty notes v1 lacked:

- **Line numbers shift on every regeneration** — any schema change (or a pg_dump version
  bump) moves everything below it. A dump ref is weaker than a `lib/read.ts:10` ref in
  version control; it is valid only against the same snapshot file. The producer therefore
  also names the containing object _inside_ the row's `method` value — the contract
  defines no other row-level field, and tolerates unknown keys only at the top level — so
  `method` reads `view-definition:public.v_orders` and a row stays interpretable after the
  file moves under it. Honesty note, the same shape as §7's: the consumer keeps only
  `{file, line, confidence}` per merged row (`EvidenceRef` in
  `queries/schema-coverage.ts`) and discards both `method` and the row-level `source`, so
  this identity is an audit path through the sidecar JSON and not through the verdict
  output until the §9 consumer change carries it.
- **Openability is load-bearing** (it is §2 reason 1), so the recommended convention is a
  stable filename (`db-config.sql`) that is _committed_ where the repo's policy allows — a
  gitignored dump makes every ref unresolvable to anyone but whoever ran it. Where it must
  stay untracked, the sidecar's snapshot identity (§7) is the fallback audit path.

## 6. The loudness floor

Per SIDECAR.md, anything schema-shaped the producer cannot attribute must surface loudly.
Review found v1's caveat list structurally insufficient in one way that counting cannot
fix, so the floor now has three parts.

**1. A positive inventory, required.** Caveats count what was _seen_; they are silent
about what was never in the file. A dump produced by an under-privileged role, a wrong
file, or a truncated download contains no functions, fires zero caveats, and merges clean
— converting "could not look" into "measured". The producer therefore always emits
per-class counts of objects _found_ (tables, functions, views, policies, triggers), and
§9's invisible-surface narrowing is gated on inventory, not on the sidecar's mere
presence. Inventory is necessary and not sufficient: a surface that was _partially_
measured is not a measured surface. Where the producer's blindness is attributable to a
table — an unparsed statement inside a body whose binding is known, a skipped PL/pgSQL
construct that could carry column refs in expression position, an unresolved column inside
a resolved table — it is expressed as a table-scoped `*` row per rule 2, so those columns
land in `undecidable` rather than `unwired`. Where it is attributable to no table —
`unresolvedTableNames`, `unsupportedLanguageBodies`, and `outOfScopeSchemaObjects` naming
executing classes (functions, views, policies, triggers) — no row can carry it, so the
corresponding `invisibleSurfaces` entry stays and narrowing does not fire. The invariant,
stated once: **merging this sidecar must never remove a warning that was protecting a
column this producer did not actually measure.** An input with no recognisable DDL at all
is a hard, loud failure — never an empty sidecar.

**2. Per-column loudness through rows, not integers.** A resolved table with an unresolved
column emits a table-scoped `*` row _plus_ a caveat — the pattern the reference producer
already ships — never a caveat alone. A global integer cannot discharge "has to say so,
per column"; a `*` or `indirect` row can, by landing the column in `undecidable`.

**3. The caveat classes**, extended by review:

- `unparsedStatements` — statements the producer's own splitter isolated but could not
  parse
- `plpgsqlStatementAccounting` — per body: N embedded SQL statements parsed of M isolated;
  control flow (`DECLARE`, `IF`, assignments) is skipped _and counted_, since PL/pgSQL is
  not a SQL dialect and the dominant function language must have a stated position
- `dynamicSql` — `EXECUTE` of a constructed string; smoke, never attribution
- `unsupportedLanguageBodies` — plv8, plpython, …, counted per language
- `unresolvedTableNames` / `ambiguousColumnBindings` — which table, and _which table a
  resolved column belongs to_ in a multi-table join; mis-binding `id` in a join is G8 by
  another route
- `multiTableBoundFunctions`, `disabledObjects` (disabled triggers, RLS-disabled-table
  policies), `outOfScopeSchemaObjects`, `partitionAttribution` (evidence against
  `orders_2024_01` must reach parent `orders`, not die in `evidenceUnknownTables`)
- Identifier-case normalisation (sqlglot normalises; generated types do not) is a stated
  producer responsibility, and a dollar-quote boundary mis-parse is treated as fatal for
  the _file_, not one object — a shifted boundary silently corrupts every `file:line`
  after it, which is ref corruption, not a countable caveat.

## 7. Staleness and identity

Sidecars are point-in-time files and regeneration is the caller's responsibility —
unchanged from SIDECAR.md. The producer enriches its output (under the
tolerated-unknown-keys allowance) with the snapshot file's mtime and the dump's version
header lines ("Dumped from database version…"), which is all a default dump carries — no
timestamp exists in plain output. One honesty note from review: the consumer renders only
`{source, path, rows}` into `caveats.mergedEvidence`, so the snapshot-identity audit path
is _manual inspection of the sidecar JSON_ until a consumer change surfaces it (§9).

## 8. Non-goals

- **Not a schema-diff or migration tool.** The dump is never replayed and never compared
  against the repo's migrations. (Catalog-vs-migrations drift detection is real signal and
  stays out.) The one comparison in scope is the §4 `tables` row's cross-check against the
  repo's generated types, which reports drift as a count and never as a diff or a proposed
  migration.
- **No live connection in this producer's v1 contract.** Scoped rather than absolute, per
  review: a future drop-planning consumer has a legitimate claim on `pg_depend`, which
  only a connection or catalog export provides. That is a different consumer and a
  different decision.
- **No data export.** Schema only.
- **No transitive liveness analysis** (§4).
- **No descriptor work.** The declared-as-data descriptor boundary from SIDECAR.md is
  untouched.

## 9. Relationship to the queued work, and consumer changes this forces

- **[#13](https://github.com/ai-solution-hub/ast-dataflow/issues/13)** consumes this
  directly. Slice order per the live-catalog survey: **functions + triggers + policies
  first** (77 functions and 198 policies in the surveyed consumer), **views second** (zero
  observed there; the class stays for generic completeness). The migrations-SQL producer
  is a sibling reading repo files, no export needed.
- **Three consumer-side changes are work this design creates, not footnotes:**
  `invisibleSurfaces` narrowing is keyed on a hard-coded producer source string in
  `schema-coverage` today, so a new producer's surface-removal (§9, O4) requires a TS
  change — and per §6 it must be gated on the positive inventory, not sidecar presence.
  Second, distinct `source` values (dump producer vs migrations producer) buy
  **auditability only**: the verdict engine does not and must not weight by source —
  "merging changes the evidence, never the verdict rules" (ADR 0002). v1's claim that "a
  consumer can weight them" is withdrawn. Third, the merge discards each row's `method`,
  so §4's `view-definition` marker — the thing that lets a ledger see that one view is
  holding a whole table hostage — reaches no output today. Surfacing it is what makes the
  view-expansion consequence actionable rather than merely disclosed.
- **O4** — the `unwired-in-ts` / unmeasured-surfaces qualification lands in the same
  consumer change.
- **G12** is unaffected: corpus instability is a tsconfig-graph problem; the dump has no
  import graph.

## 10. Gates before implementation

1. **Build-vs-integrate survey for the analysis half
   ([#14](https://github.com/ai-solution-hub/ast-dataflow/issues/14)).** v1 applied the
   directive to the export and not to the SQL analysis being built — the inconsistency a
   reviewer notices first. Before the producer is coded: survey the Postgres Language
   Server, sqlglot's lineage module, and `pg_depend` (authoritative for structural
   dependents; blind to function bodies). Outcome recorded per #14.
2. **A SQL-surface acceptance corpus.** This design proposes six detector classes with
   `exact` ceilings and zero measurements — in a repo whose gap register exists because
   detectors shipped unmeasured, and whose T1 states the corpus _gates_ detector work. The
   fixture set (functions single- and multi-bound, `WHEN` clauses, expanded views,
   enabled/disabled policies, dynamic SQL, dollar-quote edge cases, partitioned tables,
   cross-schema name collisions) is written first and gates the implementation loop.

## 11. Open questions

1. **Cross-column generated expressions** — column B generated from A executes a read of A
   on every write of B. Tier 2 caps it at `indirect` for v1; arguably it belongs in tier 1
   (`exact`). Decide with acceptance-corpus cases rather than argument.
2. **The persona front-end** — neither dump path is truly non-technical (link + Docker, or
   a connection string). Does a convenience front-end (possibly the Supabase management
   API producing the same dump file) earn a place, or is documenting the two commands
   enough? Product question, decoupled from the input contract.
3. **View-heavy databases** — whether the §4 view-expansion consequence needs a per-view
   summary in the output (N columns of table T wired by view V alone) so a ledger can see
   which single object holds a table hostage.
4. **Producer naming** — proposed: a subcommand of the existing Python CLI
   (`ast-dataflow-py db-config-uses --dump db-config.sql`), sidecar `source`
   `"ast-dataflow-dbconfig"`. The source value is load-bearing for §9's consumer change.

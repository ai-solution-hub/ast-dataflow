# The evidence sidecar (contract v1)

`schema-coverage` decides, per database column, whether anything in your codebase reads or
writes it. Its answer is only as wide as its scan, and its scan is one TypeScript project.
A column written exclusively by a Python pipeline, a migration, a stored procedure or an
ORM in another service looks identical to a column nothing touches at all.

The sidecar is how that gets fixed without teaching the TypeScript scanner every other
language. A producer — any producer, in any language — writes a JSON file of the column
accesses it observed. `schema-coverage --evidence <path>` merges it (repeatable, N files).
Verdict rules do not change when you merge: **evidence changes, not the rules.**

## The file

```jsonc
{
  "schemaVersion": 1,
  "source": "ast-dataflow-py", // the producing TOOL
  "rows": [
    {
      "table": "widgets",
      "column": "id", // or "*" — see table-scoped rows
      "direction": "write", // "read" | "write"
      "confidence": "exact", // "exact" | "wildcard" | "indirect"
      "method": "declare_row", // the producer's detector method
      "file": "pipeline/ingest.py",
      "line": 17,
      "source": "declarative", // the detector WITHIN the producing tool
    },
  ],
}
```

`schemaVersion` must be `1`; a sidecar declaring anything else is rejected with a message
naming both versions rather than being partially read. Unknown top-level keys are
tolerated and ignored, so a producer can enrich its output — the reference producer adds
`generatedBy`, `sqlglot`, `durationMs` and a `caveats` block — without breaking this
consumer.

Rows naming a table or column that is not in the target repo's generated types are not
dropped. They are counted into a `caveats.evidenceUnknownTables` entry keyed by producer,
so a producer that has drifted from the schema is visible in the output rather than
silently absent from the verdicts. Merged sidecars are listed in `caveats.mergedEvidence`
with their row counts, so any verdict's evidence base is auditable after the fact.

`file` and `line` are rendered into the verdict's evidence refs verbatim. A
`pipeline/ingest.py:17` ref is self-identifying next to a `lib/read.ts:10` ref, so no
prefix is added.

## Confidence, and what each tier can do to a verdict

The verdict rule is short enough to state completely:

| verdict       | condition                                                        |
| ------------- | ---------------------------------------------------------------- |
| `wired`       | at least one **exact** read **and** at least one **exact** write |
| `read-only`   | at least one exact read, no exact write                          |
| `write-only`  | at least one exact write, no exact read                          |
| `undecidable` | no exact evidence, but some wildcard or indirect evidence exists |
| `unwired`     | no evidence of any kind                                          |

So the tiers are not a scale of enthusiasm. They are a gate:

- **`exact`** — the producer resolved the actual column at the actual site. Only `exact`
  can wire a column.
- **`wildcard`** — the site provably touched the table, and reads could have covered any
  column (a `select *`, a dynamic read). Never wiring evidence.
- **`indirect`** — the producer could not rule the column out, but could not confirm it
  either. Never wiring evidence.

`wildcard` and `indirect` are unfalsifiable by construction: a column that does not exist
would collect both. Treating them as proof is how a scanner talks itself into believing a
dead column is live, so they are quarantined into `undecidable` — a verdict that says "I
looked and I cannot tell", which is a different and more useful claim than either "live"
or "dead".

### Table-scoped rows

A row with `column: "*"` means the producer proved the **table** was touched but not which
column. On merge it lands on every column of that table, re-graded regardless of the
confidence the producer declared:

- a `*` **read** becomes `wildcard` — a dynamic read may have read any column;
- a `*` **write** becomes `indirect` — a dynamic write is smoke, not proof.

The asymmetry is deliberate. It means a `*` write can never flip a column to `write-only`.
It can only pull an otherwise-evidence-free column out of `unwired` into `undecidable`,
which is exactly right: something wrote this table, so you cannot call any of its columns
untouched, but nothing proved it wrote _this_ column.

## Declaration is never write proof

The rule that most often surprises people implementing a producer.

Frameworks in the declared-as-data family let you declare a table's shape as a data
structure — a schema object, a model class, a column list — and then hand rows to a
library that does the writing. It is tempting to treat the declaration as evidence that
its columns are written. **It is not, and a producer must not emit it as `exact`.**

Declarations lie in both directions, and both directions were observed in real code:

- a pipeline declared columns "for schema completeness" that it deliberately never
  populates, so the declaration over-claims;
- a target was declared with 22 columns and then written through raw SQL touching 26, so
  the declaration under-claims.

So a schema declaration is emitted at `indirect` confidence, which puts a
declared-but-never-written column at `undecidable` and never at `wired` or `write-only`.
Only observed write payloads — resolved payload keys, parsed SQL, resolved query-chain
payloads — can be `exact`.

This was chosen over adding a distinct "declared" confidence tier. A new tier ripples
through the envelope types and every consumer, while mapping declaration to `indirect`
produces the correct verdicts through the existing engine unchanged.

### Worked example

A Python source declaring three columns, writing two of them literally, and writing an
opaque payload it cannot resolve:

```python
SCHEMA = TableSchema(
    columns={
        "id": ColumnDef(type="uuid", nullable=False),
        "name": ColumnDef(type="text", nullable=False),
        "spare": ColumnDef(type="text", nullable=True),
    },
    primary_key=("id",),
)

async def mount(ctx):
    return await mount_table_target(ctx, "widgets", SCHEMA)

def write(target):
    target.declare_row(row={"id": make_id(), "name": "x"})

def write_opaque(target, payload):
    target.declare_row(row=payload)
```

`ast-dataflow-py schema-uses` emits six rows: three `table-schema` rows at `indirect` (one
per declared column), two `declare_row` rows at `exact` (`id` and `name`), and one
`declare_row` row at `indirect` with `column: "*"` for the payload it could not resolve.

Merged into a TypeScript project whose only reference is an untyped read of `name`, the
verdicts are:

| column  | verdict       | why                                                                         |
| ------- | ------------- | --------------------------------------------------------------------------- |
| `id`    | `write-only`  | exact write from the resolved payload key; nothing reads it                 |
| `name`  | `write-only`  | exact write; the TypeScript read is `indirect` (untyped client), so no wire |
| `spare` | `undecidable` | declared but never written — declaration and `*` smoke only                 |

`spare` is the case the rule exists for. It is declared in the schema, so a naive producer
would report it written; nothing in either language ever puts a value in it. Neither
"live" nor "dead" is a safe answer, and `undecidable` is the one that survives review.

## Writing a producer

Three layers, in the order they matter.

### 1. The sidecar contract is the extension point

Anything that can emit the JSON above is a first-class evidence producer. There is no
plugin API to implement, no process to embed, and no coupling to the TypeScript runtime —
which also means a producer can be written in whatever language can already parse the code
it needs to read.

That is the reason for a file rather than in-process integration or a shell-out. Sidecars
keep the runtimes decoupled, and the verdict discipline is enforced once at the merge
rather than reimplemented per producer.

Sidecars are point-in-time files. A caller must regenerate them per run; staleness is the
caller's responsibility, and the `caveats.mergedEvidence` listing is what makes a stale
merge auditable rather than invisible.

Natural producers beyond the ones that ship: a migrations or `pg_proc` SQL scanner, an
ORM-schema reader, a scanner for a service in another repository that shares the database.

### 2. Descriptors, for the declared-as-data family

Other ecosystems hit the declared-as-data problem in their own dialects — SQLAlchemy
`Table()` and declarative models, Django models, Prisma and Drizzle schema files,
config-driven ETL with no ORM at all. They differ in spelling and agree in structure: the
write is a data structure, and the executor lives in a library the scan never sees.

The engine that resolves them is framework-agnostic — collect declarations, bind them to
table names, attribute row writes to declarations, and walk a resolution ladder from
strongest to weakest. What varies between frameworks is only names and argument positions:
which constructor declares a schema, which call binds it to a table and where the table
name sits in that call, which call writes a row and where the payload sits.

That triple is a **descriptor**. The intended shape is built-in descriptors for known
frameworks plus a user-supplied descriptor file for in-house patterns. It is deliberately
**not built yet**: one framework is not enough evidence to design an abstraction over.
What _is_ done now is keeping the framework-specific constants in a single frozen set so
the boundary is trivially liftable when a second real framework asks for it.

### 3. The loud-failure floor

The floor under both layers, and the part a producer is most likely to skip.

**Anything schema-shaped that a producer cannot attribute must surface as a caveat count,
never as a silent drop.** The reference producer counts unattributable write sites,
unparsed SQL, dynamic SQL it could not resolve, RPC payloads it does not read, and — where
its SQL parser is not installed — every SQL site it therefore skipped. Each is a number in
the output, so the gap between "found nothing" and "could not look" is visible in the
artefact rather than in the reader's assumptions.

A tool that cannot see a surface has to say so, per column. That is what makes the merged
verdict trustworthy: not that the scan is complete, but that its incompleteness is
enumerated. It is also why merging a sidecar drops the corresponding entry from
`caveats.invisibleSurfaces` — the surface stops being invisible only once something
actually measured it.

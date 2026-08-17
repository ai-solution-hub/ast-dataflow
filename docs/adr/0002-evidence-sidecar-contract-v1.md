# ADR 0002: External evidence merges via sidecar files; declarations are never write proof

## Context

schema-coverage's wiring verdicts were TypeScript-only, leaving the origin repo's Python
pipeline — its cocoindex declarative writes (`TableSchema` / `mount_table_target` /
`declare_row`) and its raw-SQL layer built from const strings — as static caveats. Joining
those surfaces needed both a transport — how external evidence reaches the TS verdict
engine — and a semantics: what a data-declared schema column actually proves.

## Decision

External evidence merges through a versioned **sidecar file contract**, v1:
`{schemaVersion: 1, source, rows: [{table, column|"*", direction, confidence, method, file, line, source}]}`,
consumed by `schema-coverage --evidence <path>` (repeatable). Merging changes the
evidence, never the verdict rules.

**Declaration is never write proof.** Schema-declaration rows (method `table-schema`) are
emitted at `indirect` confidence only, so a declared-but-never-written column verdicts
`undecidable` — never `wired` or `write-only`. Only observed write payloads (`declare_row`
keys, SQL, chain payloads) reach `exact`. Table-scoped `*` rows merge as wildcard-reads
and indirect-writes: smoke, not proof.

Declarations lie in both directions, which is why no "declared" confidence tier was added:
the origin pipeline declares columns for one table it deliberately never populates, and
another table is mounted with 22 declared columns but written via raw SQL with 26.

## Consequences

- Any extractor in any language is a first-class producer (Python scanner, pg_proc scan,
  Prisma/Drizzle adapters) without touching the TS core.
- Sidecars are point-in-time files: callers regenerate per run, and merged sidecars are
  named in `caveats.mergedEvidence` so a verdict's evidence base is auditable.
- Producers must be loud about blindness — unparsed or dynamic SQL, rpc payloads and
  unattributable `declare_row` sites are caveat counts, never silent drops. The consumer
  routes unknown tables/columns to `caveats.evidenceUnknownTables` rather than crashing or
  dropping them.

_(was DR-102 in the origin repo's private decision register)_

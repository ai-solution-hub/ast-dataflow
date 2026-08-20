# ADR 0003: DB-config producers consume a schema-only SQL dump; no live connection, no bespoke format

## Context

Three schema surfaces are structurally invisible to every existing producer (#13):
Postgres function/RPC bodies, view definitions, and catalog-resident triggers and
row-level-security policies. They live only in the database catalog, so a producer for
them needs an input. Issue #15 asked what exporting database configuration unlocks and in
what form producers should consume it. The full design record — object classes, confidence
ceilings, the two-tier evidence rule, the loudness floor — is
[`docs/db-config-export.md`](../db-config-export.md), which passed an adversarial design
review, an empirically verified external-claims fact-check, a live-catalog survey, and a
senior-staff ratification review before this ADR was cut.

## Decision

DB-config evidence producers consume a **schema-only Postgres SQL dump** and never open a
database connection. Two dump variants are one artefact class: raw `pg_dump` plain output
and Supabase CLI `db dump` output (a rewritten variant — parsers must accept both,
including stripping psql `\restrict` meta-command lines). No bespoke export format is
invented. Evidence refs are `file:line` into the dump, with the containing object's
identity carried inside the row's `method` value.

Confidence follows the design's two-tier rule: **independent executing objects** (function
bodies, views, policies, triggers) can reach `exact` under per-class gates (unambiguous
single binding, object enabled); **the column's own structural furniture** (defaults,
constraints, indexes, generated expressions) is emitted at `indirect` — never silence,
never `exact` — so a column whose only trace is executed structure verdicts `undecidable`
rather than `unwired`.

## Consequences

- **The loudness floor binds every #13 producer built on this input.** The producer always
  emits a positive per-class inventory of objects found, and `caveats.invisibleSurfaces`
  narrowing is gated on that inventory **and** on the surface having been measured
  completely enough to withdraw the warning: blindness attributable to a table becomes a
  table-scoped `*` row (the column lands `undecidable`); blindness attributable to no
  table — unresolved names, unsupported body languages, out-of-scope executing objects —
  blocks narrowing entirely. Merging this sidecar must never remove a warning that was
  protecting a column the producer did not actually measure. An input with no recognisable
  DDL is a hard failure, never an empty sidecar.
- **Issue #15's non-technical-user constraint is NOT met by this decision.** Both
  producing paths carry real prerequisites (Supabase CLI: a linked project and Docker;
  pg_dump: a connection string). The persona front-end is deliberately deferred (design
  §11.2), decoupled from this input contract rather than satisfied by it.
- Implementation is gated (design §10) on a build-vs-integrate survey per #14 (Postgres
  Language Server, sqlglot's lineage module, `pg_depend` — authoritative for structural
  dependents, blind to function bodies) and on a SQL-surface acceptance corpus written
  before any detector code.
- Distinct `source` values across producers buy auditability in `caveats.mergedEvidence`
  only; the verdict engine does not weight by source — merging changes the evidence, never
  the verdict rules (ADR 0002).

_(settles the §2 decision of `docs/db-config-export.md`; ratified 2026-08-20)_

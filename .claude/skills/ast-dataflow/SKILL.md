---
name: ast-dataflow
description:
  "Catalogue and entry point for the ast-dataflow skill family. Use when you need
  type-checker-resolved symbol and dataflow analysis. Examples: 'find all callers of sb()', 'which files read
  example_table.example_column', 'are there dead exports in file x', 'verify this rename
  is complete', 'which schema columns are built but not wired'"
allowed-tools: Bash, Read, Edit
---

# ast-dataflow — Skill catalogue

## What ast-dataflow is

ast-dataflow is a type-checker-resolved symbol and dataflow analysis for TypeScript repos, with a Python
column-lineage companion. Answers the questions grep cannot: exact call sites, column
read/write sites, string-literal AST context, re-export chains, type-position blast
radius, and cross-language schema coverage.

Two halves, one contract:

`ast-dataflow` (TypeScript, ts-morph) — the query
engine, CLI, and MCP server.
`ast_dataflow_py` (Python, stdlib ast + optional
sqlglot) — column lineage over Python pipelines
and SQL, feeding the TS side through a versioned evidence-sidecar contract.

**Primary CLI:**

```bash
bun run ast-dataflow <query> [args]
```

- `tsconfig.json` defines the analysis corpus.

## MCP server

The warm path: a long-lived process holding the ts-morph project, so repeat queries skip
the project load (~6 s cold, ~100–200 ms warm). Register in your `.mcp.json`:

```json
{
  "mcpServers": {
    "ast-dataflow": {
      "command": "bunx",
      "args": ["ast-dataflow-mcp"]
    }
  }
}
```

The server binds its repo root to the working directory it is spawned in.

---

## When to use ast-dataflow vs. sibling tools

| Tool             | Use when                                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ast-dataflow** | You need file-and-line resolution with TypeScript semantic precision: exact call sites, type-position references, column access sites, or string-literal AST context |
| **gitnexus**     | You need process-level blast radius, execution-flow orientation, or automated rename — but do NOT need full indirect-caller enumeration                              |
| **Knip**         | You need entry-point reachability (binary yes/no: dead vs. reachable) — but NOT semantic confirmation of why                                                         |
| **ccc**          | You need concept-based file discovery across all corpus types (TS, Python, SQL, Markdown) — but NOT AST precision                                                    |

ast-dataflow and gitnexus are **complementary, not competing.** Use them together — see
the Cross-tool patterns section below.

---

## Query catalogue

Fifteen queries are available. Match your question to the right query:

### callers — "who calls this function?"

```bash
bun run ast-dataflow callers \
  --symbol 'lib/supabase/safe.ts:sb'
```

Returns every call site of a function, including indirect callers (arrow- function
callbacks, Promise.all wrappers, HOC patterns) that gitnexus may not index. Each row
carries: `file`, `line`, `column`, `enclosing` (the function/method that wraps the call),
`resolution` (`direct` | `aliased` | `indirect`).

**Use when:** debugging a wrong-argument bug, verifying a contract (e.g. UUID shape), or
confirming every caller before modifying a function. **Companion skill:**
`ast-dataflow-call-chain-pin` (Pattern 5).

---

### callees — "what does this function call?"

```bash
bun run ast-dataflow callees \
  --symbol 'lib/supabase/safe.ts:sb'
```

The inverse of `callers`: every call made from inside the named function's body, resolved
through the type checker. External (node_modules) callees are excluded by default with a
top-level `externalCount`; `--include-external` emits them with `callee.file: null` (never
a node_modules path). Error kind `not_callable` when the symbol is not a function.

**Use when:** understanding a function before refactoring it, auditing what a route
handler touches, building a mental call graph downward.

---

### references — "every TypeScript reference to a symbol"

```bash
bun run ast-dataflow references \
  --symbol 'types/bid.ts:BidState'
```

Returns all references classified by kind: `read`, `write`, `typeReference`, `typeOnly`,
`jsxComponent`, `reexport`. Confidence is always `exact` (type- checker resolved). Useful
for pre-rename impact and for confirming a rename swept all sites.

**Use when:** pre-rename reference count, post-rename verification, type- evolution blast
radius.

---

### importers — "which files import this module?"

```bash
bun run ast-dataflow importers \
  --module '@/lib/supabase/safe'
```

Returns all files that import the given module path, including named import details
(`namedImports`, `importStyle`). After a rename, the old module path should return
`error.kind === 'unknown_file'` (the module is gone). Any results means missed imports.

**Use when:** post-rename import-path sweep, confirming no barrel-chain gaps, checking who
depends on a module before removing it.

---

### string-literal-uses — "find string literals with AST context"

```bash
bun run ast-dataflow string-literal-uses \
  --value 'generateDigest'
```

Finds every string literal matching the value and classifies its AST context: `viMock`
(Vitest `vi.mock(...)` argument), `jsxProp` (JSX attribute value), `sqlTag` (SQL tagged
template), `envKey` (`process.env[...]` key), `argument` (other call-expression argument).
Python and SQL files outside the ts-morph corpus are NOT covered — run a `grep` sweep in
addition for those.

**Use when:** post-rename string-site sweep, auditing `vi.mock` paths, finding hardcoded
URL fragments.

---

### fixture-uses — "where does a name appear in test fixtures?"

```bash
bun run ast-dataflow fixture-uses \
  --needle question_text
```

Scans fixture corpora — JSON fixtures (hand-rolled lexer with key/value + structural path
context), fixture TS files, and markdown frontmatter — for the needle, classifying each
hit as `key` or `value` with its structural path. Fixture-by-convention: `/fixtures/` path
segment or `*-fixture.ts` basename. Confidence is always `indirect` (fixtures are data,
not type-checked code).

**Use when:** column/field renames that must sweep test data, auditing which fixtures pin
a schema name, pre-migration fixture impact.

---

### column-reads — "every TS file that reads a Supabase column"

```bash
bun run ast-dataflow column-reads \
  --table form_questions --column question_text
```

Walks the TypeScript call graph to find every `.select()` / `.from()` call chain that
references the named table column. Handles aliased column selects and type-narrowed reads.

**Use when:** pre-column-rename impact, verifying a column migration swept all read sites,
column-access audits.

---

### column-writes — "every TS file that writes a Supabase column"

```bash
bun run ast-dataflow column-writes \
  --table form_questions --column question_text
```

Finds `.insert()`, `.update()`, `.upsert()` call chains writing the named column.
Companion to `column-reads`.

**Caveat until id-377 {377.6} G8 lands:** counts are table-level, not column-level — open
every site before acting.

**Use when:** pre-column-rename impact, write-path audits, verifying no direct writes
bypass `sb()` wrappers.

---

### dead-exports — "exports with no non-test callers"

```bash
bun run ast-dataflow dead-exports \
  --scope 'lib/bid/**'
```

Returns exported symbols with zero non-test importers. Each row includes `testOnly` (true
= only referenced from `__tests__/`) and `reachableImporters` count. Scope is a glob or
comma-separated glob list.

**Use when:** pre-delete safety check, dead-code audits, Knip false-positive confirmation.
**Companion:** Pattern 1 (Knip dead-exports verifier).

---

### reexport-chain — "trace the full barrel chain for a symbol"

```bash
bun run ast-dataflow reexport-chain \
  --symbol '@/lib/bid:createBid'
```

Walks re-export declarations from the entry point to the source declaration, resolving the
full chain. Exposes `BARREL_DETECTED` when a symbol escapes through an index file. Use to
confirm Knip false positives caused by barrel chains.

**Use when:** debugging "why is Knip saying this is dead but it clearly isn't?", auditing
barrel-chain depth, verifying no-barrel-re-exports rule.

---

### type-evolution — "all type-position references for a TypeScript type"

```bash
bun run ast-dataflow type-evolution \
  --type 'types/bid.ts:BidState'
```

Enumerates declaration sites, re-exports, aliases, generic specialisations, `extends`
clauses, conditional types, and mapped-type positions. Returns rows classified as
`typeReference`, `typeOnly`, `read`, or `reexport`. Gitnexus `impact` covers runtime
callers; `type-evolution` covers the type- position references gitnexus does not index.

**Use when:** pre-type-rename full blast radius, distinguishing runtime callers (test
coverage needed) from type-position references (compile-time fix only). **Companion:**
Pattern 6 (type-evolution agreement check).

---

### enum-uses — "all reads of a specific enum or `as const` member"

```bash
bun run ast-dataflow enum-uses \
  --enum BID_STATES [--member DRAFT]
```

Returns every property-access read, type-position reference, and string- literal
equivalent of the named enum or `as const` member. Handles both TypeScript `enum`
declarations and `as const` object idioms. Knip has documented false
positives on `as const` patterns; this query provides the semantic confirmation.

**Use when:** auditing before retiring an enum member, confirming a Knip unused-member
report, `as const` property lifecycle audits. **Companion:** Pattern 8 (Knip enum-member
confirmation).

---

### flow-trace — "step-by-step call path from entry to target"

```bash
bun run ast-dataflow flow-trace \
  --entry 'app/api/bid/[id]/route.ts:GET' \
  --target 'lib/supabase/safe.ts:sb'
```

Walks the call graph from an entry point to a target symbol, returning each hop with its
file, line, and hop kind (`call` | `import` | `typeRef`). Useful for tracing the full
execution path of a request through the KH API layer.

**Use when:** understanding how a request reaches a specific function, tracing the auth
chain, verifying that a write path goes through `sb()`.

---

### type-drift-detect — "API response-interface drift classification"

```bash
bun run ast-dataflow type-drift-detect
```

Classifies every response-interface candidate in the codebase into one of four buckets:
`enforced` (fetcher + route both use it), `fetcher-only`, `route-only`, or `unused`.
Implements PRODUCT.md WP-D (R-WP17). Runs across the full corpus — no scoping argument
needed.

**Use when:** API type-drift audits, enforcing symmetric interface coverage before an API
release, identifying interfaces that have diverged between fetcher and route definitions.

---

### schema-coverage — "which schema columns are built but never wired?"

```bash
bun run ast-dataflow schema-coverage [--table X] [--report path.md]
```

The headline report query (id-375 A6). Enumerates every table/column from the generated
`database.types.ts`, one-pass-scans the corpus for all `.from()` chains (including one-hop
const-resolved table names), and emits a per-column verdict:
`wired | read-only | write-only | undecidable | unwired`. Conservative by construction:
wildcard/indirect evidence never counts as wiring; a column is `unwired` only when its
table also has zero smoke; unknown tables/columns are structured errors (`unknown_table` /
`unknown_column`). `--report <path>` additionally writes a Markdown report (unwired-first,
evidence + caveats); no writes without the flag. Full 807-column sweep runs in ~7 s. Blind
to: RPC SQL bodies, `api.*` views, external PostgREST consumers — and the Python pipeline
UNLESS you merge its evidence sidecar: `--evidence <sidecar.json>` (repeatable) folds
external evidence rows into the verdicts. Cross-language verdict recipe:

```bash
bun run ast-dataflow-py schema-uses --exclude-tests > /tmp/py-evidence.json
bun run ast-dataflow schema-coverage --evidence /tmp/py-evidence.json --report out.md
```

Merged sidecars are listed in `caveats.mergedEvidence`; sidecar rows naming unknown
tables/columns land in `caveats.evidenceUnknownTables` (loud, never dropped).
Declaration-only evidence (method `table-schema`) is indirect by design — it can make a
column `undecidable`, never `wired`.

**Use when:** built-not-wired audits, pre-migration column-retirement candidates, "is
anything actually using this table?", owner-facing schema hygiene reports.

---

## Python corpus sibling (column lineage only)

`bun run ast-dataflow-py column-reads|column-writes --table X --column Y [--exclude-tests]`
(wraps the installed `@ai-solution-hub/ast-dataflow` package's Python CLI) answers the
same column question for the Python pipeline corpus (`scripts/`), which reaches the SAME
Postgres tables through THREE surfaces the TS tool cannot see: raw asyncpg SQL strings,
supabase-py `.from_()` chains, and the cocoindex DECLARATIVE write path (`TableSchema`
consts bound by `mount_table_target`, written via `declare_row` — flow.py's primary write
mechanism). Same JSON envelope; rows carry
`source: "sql" | "supabase-py" | "declarative"`. Declarative semantics:
`method: "declare_row"` rows are write evidence (exact for literal payload keys, incl. the
dedup-map `row=<var>` fallback at indirect); `method: "table-schema"` rows are declaration
INTENT only — always indirect, because flow.py declares columns it deliberately never
populates. SQL statements parse via sqlglot when installed (`exact` confidence) and
degrade to a regex fallback (`indirect`) when not — check the `sqlglot` boolean in the
response. SQL passed by module-constant name (`conn.fetch(_SQL_FOO)`, the l_records
convention) and f-strings over such constants resolve to their exact text; only
locally-assembled SQL stays invisible (caveated in `schema-uses`).

`bun run ast-dataflow-py schema-uses [--exclude-tests]` is the bulk sweep: one corpus
walk, no --table/--column, emitting every attributable evidence row as the v1 evidence
sidecar (`{schemaVersion, source, rows, caveats}`) for `schema-coverage --evidence`.
Caveats report what was skipped loudly: rpc payloads (table-blind), unparsed/dynamic SQL,
unattributable declare_row sites. Python symbol queries (callers/references) are
deliberately not duplicated here — use GitNexus (which indexes `scripts/**.py`) or
jedi/pyright.

## Cross-tool patterns

Nine patterns document high-leverage compositions of ast-dataflow with gitnexus, Knip, and
ccc. Full write-up:
`${KH_PRIVATE_DOCS_DIR}/src/content/docs/specs/id-50-ast-dataflow-tool/investigations/R-WP11-cross-tool-integration.md`

| #   | Pattern                                            | Tools                                                                  | Leverage |
| --- | -------------------------------------------------- | ---------------------------------------------------------------------- | -------- |
| 1   | Knip dead-exports verifier                         | `knip --reporter json` + `dead-exports` + `reexport-chain`             | High     |
| 2   | GitNexus blast radius refinement                   | `gitnexus_impact` + `callers` / `column-reads` / `references`          | High     |
| 3   | cocoindex-code wide-net + string-literal precision | `ccc search` + `string-literal-uses`                                   | High     |
| 4   | Rename-sweep verifier                              | `gitnexus_rename` + `string-literal-uses` + `importers` + `references` | High     |
| 5   | Call-chain pin for wrong-argument bugs             | `gitnexus_context` + `callers`                                         | High     |
| 6   | Type-evolution agreement check                     | `gitnexus_impact` + `type-evolution`                                   | Medium   |
| 7   | Architectural invariant verification               | `ccc guide` + `callers` / `string-literal-uses`                        | Medium   |
| 8   | Knip enum-member confirmation                      | `knip --reporter json` + `enum-uses`                                   | Medium   |
| 9   | Concept-scoped dead-export audit                   | `ccc search` + `dead-exports --scope`                                  | Low      |

---

## Skill files

Three skills are available. Choose by task shape:

| Task                                                         | Skill                         |
| ------------------------------------------------------------ | ----------------------------- |
| Verify a rename is complete after `gitnexus_rename`          | `ast-dataflow-rename-sweep`   |
| Pin the exact call site passing a wrong argument value       | `ast-dataflow-call-chain-pin` |
| Orient yourself — which query to use, which pattern to apply | This file (catalogue)         |

Full skill paths:

- `.claude/skills/ast-dataflow/ast-dataflow-rename-sweep/SKILL.md` (Pattern 4)
- `.claude/skills/ast-dataflow/ast-dataflow-call-chain-pin/SKILL.md` (Pattern 5)

---

## Error contract

All queries return a `QueryResponse<T>` with a top-level `error` field on failure:

```typescript
{
  query: string;
  args: Record<string, unknown>;
  error: {
    kind: 'ambiguous_symbol' | 'unknown_file' | 'parse_error' | 'out_of_corpus'
        | 'not_callable' | 'unknown_table' | 'unknown_column';
    message: string;
    hint?: string;
  };
  durationMs: number;
}
```

Common error codes:

| `error.kind`       | Cause                                                                    | Resolution                                             |
| ------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------ |
| `ambiguous_symbol` | Symbol name matches multiple declarations                                | Qualify with `file:symbol` form                        |
| `unknown_file`     | Module path does not exist in the project                                | Check the path; file may have been renamed             |
| `parse_error`      | Malformed argument (bad symbol format, empty required arg)               | Fix the argument shape shown in the hint               |
| `out_of_corpus`    | File exists but the named symbol is not declared/exported there          | Check the export name; may be default-exported         |
| `not_callable`     | `callees` target resolves but is not a function                          | Check the symbol; classes/values have no callees       |
| `unknown_table`    | `schema-coverage --table` names a table absent from the generated schema | Check `database.types.ts`; table may have been dropped |
| `unknown_column`   | `schema-coverage --column` names a column absent from the table          | Check the Row type for the table                       |

A query that runs successfully with zero matches returns `results: []` with no `error`
field — an empty result set is not an error.

---

## Related

- `${KH_PRIVATE_DOCS_DIR}/src/content/docs/specs/id-50-ast-dataflow-tool/TECH.md` — full
  technical specification
- `${KH_PRIVATE_DOCS_DIR}/src/content/docs/specs/id-50-ast-dataflow-tool/PRODUCT.md` —
  invariant test suite
- `${KH_PRIVATE_DOCS_DIR}/src/content/docs/specs/id-50-ast-dataflow-tool/ROADMAP.md` —
  wave plan, WP status
- `${KH_PRIVATE_DOCS_DIR}/src/content/docs/specs/id-50-ast-dataflow-tool/investigations/R-WP11-cross-tool-integration.md`
  — cross-tool pattern brief

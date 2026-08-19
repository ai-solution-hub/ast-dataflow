# ast-dataflow

Type-checker-resolved symbol and dataflow analysis for TypeScript repos, with a Python
column-lineage companion. Answers the questions grep cannot: exact call sites, column
read/write sites, string-literal AST context, re-export chains, type-position blast
radius, and cross-language schema coverage.

Two halves, one contract:

- **`tools/ast-dataflow`** (TypeScript, [ts-morph](https://ts-morph.com)) — the query
  engine, CLI, and MCP server.
- **`tools/ast_dataflow_py`** (Python, stdlib `ast` + optional
  [sqlglot](https://github.com/tobymao/sqlglot)) — column lineage over Python pipelines
  and SQL, feeding the TS side through a versioned evidence-sidecar contract.

## Install

```sh
bun add -d github:ai-solution-hub/ast-dataflow
```

Requires [bun](https://bun.sh) — the CLI and MCP server run TypeScript directly, no build
step.

## CLI

Run from the root of the repo you want to analyse (the target repo's `tsconfig.json`
defines the analysis corpus):

```sh
bunx ast-dataflow                       # print the query catalogue
bunx ast-dataflow callers --symbol lib/db.ts:getClient
bunx ast-dataflow column-reads --table users --column email
bunx ast-dataflow schema-coverage --evidence .ast-dataflow/evidence.json
```

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

### Path confinement

Three arguments name files the tool then opens — `schema-coverage --evidence`,
`dead-exports --symbolsFile`, and `fixture-uses --scope` (the one `scope` that globs disk
rather than filtering the loaded corpus). The two surfaces treat them differently, because
their callers differ:

| surface | policy                                                                                                                                                                                     |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CLI     | unconfined — the caller already holds the shell's authority, and out-of-repo sidecars are a live requirement (a producer writing to `$TMPDIR` then passing absolute paths to `--evidence`) |
| MCP     | confined to an allowlist, `[repoRoot]` by default — the caller is a model, not the operator                                                                                                |

To let the server read a sidecar written outside the repo, name the extra roots at spawn:

```json
{
  "mcpServers": {
    "ast-dataflow": {
      "command": "bunx",
      "args": ["ast-dataflow-mcp"],
      "env": { "AST_DATAFLOW_ALLOWED_ROOTS": "/tmp/census-evidence" }
    }
  }
}
```

`AST_DATAFLOW_ALLOWED_ROOTS` is `PATH`-delimited (`:` on POSIX); relative entries resolve
against the repo root. It is read once at spawn — no request can widen its own allowlist.
A path outside the roots returns `error.kind: "path_not_allowed"` and reads nothing; the
refusal is decided on path shape before any filesystem call, so it is identical whether or
not the file exists and cannot be used to test for one.

## Response envelope

Every query returns the same envelope, on both surfaces, so a zero-row answer is readable
rather than ambiguous:

```jsonc
{
  "query": "references",
  "results": [...],
  "truncated": false,
  "summary": { "read": 31, "typeReference": 3 },   // the query's natural buckets
  "caveats": {
    "scan": "...",                  // what the answer rests on, in one sentence
    "searched": [...],              // the AST shapes actually matched
    "invisibleSurfaces": [...],     // what this scan structurally cannot see
    "corpus": { "fileCount": 49, "tsconfigPath": "tsconfig.json",
                "testFilesExcluded": false },
    "summaryBasis": "all-rows",     // or "shown-rows" when rows were dropped
    "narrowing": [...],             // present only when truncated: what to do next
    "schemaValidation": { ... }     // column-reads / column-writes only
  }
}
```

Read it this way:

- **A zero with `caveats`** tells you which of three things happened: no sites exist, no
  sites exist _in the shapes listed under `searched`_, or your target is not in the corpus
  (`corpus.fileCount`, and a structured `error` for a target that could be checked and did
  not exist).
- **`schemaValidation.validated: false`** means the target repo ships no generated
  Postgres types, so the table and column were never checked to exist — that zero could
  equally be a typo. With generated types present, an unknown table or column is a loud
  `unknown_table` / `unknown_column` error with a near-miss hint, never a silent `[]`.
- **`truncated: true`** always carries `caveats.narrowing`: the shown/total split, the
  filters _this_ query honours, and the exact `--limit` that would show the rest.
  `summaryBasis` flips to `shown-rows` so the histogram is never mistaken for a full
  count.

## Python companion

```sh
bun run ast-dataflow-py -- schema-uses --root path/to/pipeline
```

SQL column extraction requires `sqlglot` (`pip install sqlglot`); without it, SQL sites
degrade to indirect confidence and the response says so.

## Known caveats (measured, binding until the named gap lands)

Efficacy trials against a real production repo produced a clear verdict: this is a
**precision instrument, not an inventory instrument**. Cleared for "is this specific thing
still there?"; not cleared for "how many sites are there?"

1. **Never quote a `column-writes` count.** Column attribution is table-level in
   untyped-client repos: 18.5 % pooled false positives over 65 hand-checked sites; ~44 %
   of rows return for any _real_ column name (G8). A column that is not in the generated
   types no longer returns rows at all — it errors — but for columns that do exist the
   attribution is unchanged.
2. **Never read a `string-literal-uses` zero as absence.** Comparisons, property values
   and array elements are currently dropped silently (G1).
3. **Never read any zero as corpus-covered.** Corpus membership is transitive over the
   target repo's tsconfig import graph — unpredictable and unstable across unrelated
   refactors (G12).
4. **`schema-coverage --evidence` is the only verdict-grade surface.** Run it with the
   evidence sidecar or not at all.

## Development

```sh
bun install
bun test          # vitest suite
bun run test:py   # pytest suite (Python half)
bun run typecheck
```

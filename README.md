# ast-dataflow

Type-checker-resolved symbol and dataflow analysis for TypeScript repos, with a
Python column-lineage companion. Answers the questions grep cannot: exact call
sites, column read/write sites, string-literal AST context, re-export chains,
type-position blast radius, and cross-language schema coverage.

Two halves, one contract:

- **`tools/ast-dataflow`** (TypeScript, [ts-morph](https://ts-morph.com)) — the
  query engine, CLI, and MCP server.
- **`tools/ast_dataflow_py`** (Python, stdlib `ast` + optional
  [sqlglot](https://github.com/tobymao/sqlglot)) — column lineage over Python
  pipelines and SQL, feeding the TS side through a versioned evidence-sidecar
  contract.

## Install

```sh
bun add -d github:ai-solution-hub/ast-dataflow
```

Requires [bun](https://bun.sh) — the CLI and MCP server run TypeScript
directly, no build step.

## CLI

Run from the root of the repo you want to analyse (the target repo's
`tsconfig.json` defines the analysis corpus):

```sh
bunx ast-dataflow                       # print the query catalogue
bunx ast-dataflow callers --symbol lib/db.ts:getClient
bunx ast-dataflow column-reads --table users --column email
bunx ast-dataflow schema-coverage --evidence .ast-dataflow/evidence.json
```

## MCP server

The warm path: a long-lived process holding the ts-morph project, so repeat
queries skip the project load (~6 s cold, ~100–200 ms warm). Register in your
`.mcp.json`:

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

## Python companion

```sh
bun run ast-dataflow-py -- schema-uses --root path/to/pipeline
```

SQL column extraction requires `sqlglot` (`pip install sqlglot`); without it,
SQL sites degrade to indirect confidence and the response says so.

## Known caveats (measured, binding until the named gap lands)

Efficacy trials against a real production repo produced a clear verdict: this
is a **precision instrument, not an inventory instrument**. Cleared for "is
this specific thing still there?"; not cleared for "how many sites are there?"

1. **Never quote a `column-writes` count.** Column attribution is table-level
   in untyped-client repos: 18.5 % pooled false positives over 65 hand-checked
   sites; ~44 % of rows return for _any_ column name (G8).
2. **Never read a `string-literal-uses` zero as absence.** Comparisons,
   property values and array elements are currently dropped silently (G1).
3. **Never read any zero as corpus-covered.** Corpus membership is transitive
   over the target repo's tsconfig import graph — unpredictable and unstable
   across unrelated refactors (G12).
4. **`schema-coverage --evidence` is the only verdict-grade surface.** Run it
   with the evidence sidecar or not at all.

## Development

```sh
bun install
bun test          # vitest suite
bun run test:py   # pytest suite (Python half)
bun run typecheck
```

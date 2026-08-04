# Roadmap

What this package answers well today, what it answers badly, and what is queued to change
that. The measurements behind the "answers badly" half live in
[`docs/gap-register.md`](./docs/gap-register.md); this file is the shorter question of
what to expect next.

## Where it stands

Fifteen TypeScript queries and a three-query Python companion, all behind one response
envelope.

**Symbol and reference queries** — `callers`, `callees`, `importers`, `references`,
`reexport-chain`, `dead-exports`. These are the mature half. Reference resolution runs
through the type checker, so aliased imports, re-export chains and same-named local
declarations are separated correctly rather than matched textually, and comments and
string labels are excluded rather than filtered out afterwards.

**Schema queries** — `column-reads`, `column-writes`, `schema-coverage`. `column-reads`
and `schema-coverage` are dependable. `column-writes` is not, in a specific way: read the
first caveat below before quoting anything it returns.

**Literal, fixture and type queries** — `string-literal-uses`, `fixture-uses`,
`enum-uses`, `type-evolution`, `type-drift-detect`, `flow-trace`. Useful, with known blind
spots each.

**Python companion** — `column-reads`, `column-writes`, `schema-uses`, over Python sources
and the SQL inside them. `schema-uses` emits an evidence sidecar that
`schema-coverage --evidence` merges, which is how a column written only from outside the
TypeScript corpus stops looking dead. The contract is in
[`docs/SIDECAR.md`](./docs/SIDECAR.md).

**Response envelope** — every query, on both the CLI and MCP surfaces, returns its corpus,
the AST shapes it actually searched, the surfaces it structurally cannot see, and a
narrowing path when results were truncated. A zero-row answer is readable rather than
ambiguous. This is what makes the gaps below detectable by a user instead of silent.

## What is not trustworthy yet

Three gaps produce wrong answers rather than slow ones. Each is measured; each is binding
until the fix lands.

**`column-writes` counts are not per-column.** Column attribution collapses to table-level
wherever the client is not type-instantiated, which in practice is most places. Measured
18.5 % false positives over 65 hand-checked sites, and around 44 % of returned rows come
back for any column name at all. Use it to ask whether a specific site still exists, never
to ask how many sites there are.

**A `string-literal-uses` zero is not absence.** The query classifies five call-site
contexts and silently drops comparisons, object-property values, array elements,
type-position literals, return statements and const initialisers — which between them are
the majority of real literal sites. Measured 0 detected out of 24 for one persisted-enum
sweep.

**No zero is corpus-covered.** Corpus membership is transitive over the target repo's
tsconfig import graph, which makes it both unpredictable and unstable: a fixed query has
been observed silently changing its answer because an unrelated refactor dropped a file
out of the import graph. The envelope now reports the corpus it used, so this is visible;
it is not yet controllable.

## Queued

Ordered by whether the work removes a wrong answer, then by effort.

### Correctness

| id  | what                                                                                   | shape of the fix                                                                                                                                                                            |
| --- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G8  | `column-writes` attributes rows to a column it cannot prove is in the payload          | give writes the wildcard honesty reads already have: `columnPath: "*"` + `confidence: "wildcard"` when the column is not provably a payload key, behind an opt-in flag for today's superset |
| G1  | `string-literal-uses` sees five of the eleven contexts that matter                     | add `comparison`, `caseClause`, `propertyValue`, `arrayElement`, `typeLiteral`, `initializer`, keeping today's set as a filter; carry the comparison LHS text                               |
| G12 | corpus membership is transitive, unpredictable and unstable across unrelated refactors | short term a CLI `corpus-info` (MCP-only today) and per-target membership in the envelope; long term, a decision on pinning or declaring the corpus                                         |

### Contract and surface

Tracked as issues, because they are about how the tool presents itself rather than what it
can see.

- **[#2](https://github.com/ai-solution-hub/ast-dataflow/issues/2)** — migrate the MCP
  server from the hand-rolled low-level `Server` to `McpServer.registerTool`, with a
  strict Zod discriminated union on `query`. This is the root cause of several smaller
  complaints: unknown flags are silently accepted and echoed back as honoured, there is no
  `outputSchema`, no tool annotations, and `isError` is inconsistent.
  `DeadExportsArgs.scope` is folded in — it is declared and read by no code, so
  `dead-exports --scope <glob>` is today silently dropped and the full corpus scanned. The
  ruling is to implement it, so that strict schemas honour declared arguments rather than
  rejecting them.
- **[#3](https://github.com/ai-solution-hub/ast-dataflow/issues/3)** — no evaluation
  exists for the MCP surface, and no tests cover tool listing, argument rejection or
  `isError`. Also pagination (there is no offset or `has_more`), a `responseFormat` option
  (markdown renderers exist in the CLI and are unreachable over MCP), and a character cap
  on responses.
- **[#4](https://github.com/ai-solution-hub/ast-dataflow/issues/4)** — two measured holes
  in the envelope work: `reexport-chain` under-reports truncation at small limits, so it
  can return fewer rows than exist with `truncated: false` and no narrowing block; and
  caveats attach in `dispatch` only, so importing a query function directly from the
  package returns rows with no context attached.

### Coverage

Queries that do not exist, or that see less than the language offers.

| id  | what                                                                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G11 | no identifier-text query. A property key repeated across unrelated interfaces is addressable by neither `string-literal-uses` (not a literal) nor `references` (no single declaration) |
| G9  | `references` has no member-level resolution — `file.ts:propName` for an interface property errors, and with the wrong error kind                                                       |
| G4  | `enum-uses` handles enums and as-const objects but not as-const arrays                                                                                                                 |
| G5  | `fixture-uses --needle` is whole-token exact-match, with no way to widen to a substring                                                                                                |
| G7  | cold project load dominates literal queries at 5–12 s each; accepting several `--value` arguments per invocation would amortise one load across a set                                  |

### Opportunities

Not gaps — nothing here returns a wrong answer — but each is real leverage.

- **O1** — nothing connects a string const to its literal value. `references` tracks the
  symbol, `string-literal-uses` tracks the string, and no query joins them. Carrying
  `literalValue` on `references` rows for string-const declarations would.
- **O2** — deciding whether a hit is load-bearing or stale stays human judgement. A
  `comparison` kind carrying the left-hand expression text gets most of the way there.
- **O4** — the `unwired` verdict is under-qualified. Where no sidecar was merged, a column
  written only from another language reads as dead. Either rename the token to
  `unwired-in-ts` or carry a per-row `externalSurfacesUnmeasured` flag.
- **O5** — absence guards in a test suite are a first-class artefact of any retirement
  work and are currently invisible. Once G1 lands, a kind-filtered sweep makes finding
  them mechanical, which is worth a documented recipe.

### T1 — the TypeScript acceptance corpus

There is a Python-side acceptance corpus of hard declarative-write cases. There is no
TypeScript equivalent, and that absence is the reason the gaps above shipped undetected
rather than being caught. It gates the detector work rather than sitting beside it.

The seed already exists in the trial data: 65 hand-checked `column-writes` sites with
per-site verdicts, a 345-file decomposition of one identifier sweep into visible /
literal-in-unhandled-position / identifier-only / comment-only / out-of-corpus buckets,
and eight literal classes with per-class ground truth.

## Recently closed

- **Response envelope (G2, G3, G10)** — zero-row answers carried no context, and
  `column-reads` / `column-writes` answered an unknown table or column with a silent `[]`
  while `schema-coverage`, running off the same generated types, reported it loudly. Every
  query now carries the envelope; an unknown table or column is a structured error with a
  near-miss hint; truncated responses carry a narrowing path. Residual holes are in
  [#4](https://github.com/ai-solution-hub/ast-dataflow/issues/4).
- **Path confinement ([#1](https://github.com/ai-solution-hub/ast-dataflow/issues/1))** —
  three arguments name files the tool then opens. Over MCP they are now confined to an
  allowlist defaulting to the repo root, decided on path shape before any filesystem call
  so the refusal cannot be used to test whether a file exists. The CLI stays unconfined,
  because a caller with a shell already holds that authority and out-of-repo sidecars are
  a real requirement. See the README's path-confinement section.

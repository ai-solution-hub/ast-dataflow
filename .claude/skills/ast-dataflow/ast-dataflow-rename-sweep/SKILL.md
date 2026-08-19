---
name: ast-dataflow-rename-sweep
description: "Run a 3-query rename-sweep battery after a gitnexus_rename to find string-literal and import sites that the gitnexus ast_search fallback may have missed. Use when completing a multi-file TypeScript symbol rename, after gitnexus_rename has been applied, or when auditing rename completeness. Examples: 'verify the rename is complete', 'check for missed string-literal sites after renaming generateDigest', 'sweep for leftover references after a symbol rename'"
allowed-tools: Bash, Read, Edit
---

# Rename-sweep verifier (ast-dataflow)

## When to Use

Use this skill immediately after `gitnexus_rename` (or any multi-file TypeScript
symbol rename) to verify completeness. `gitnexus_rename` applies edits in two
tiers:

1. **Graph edits (high confidence)** — TypeScript symbol references resolved via
   the GitNexus call-graph. These are correct by construction.
2. **`ast_search` edits (review carefully)** — string-match fallback for sites
   not in the graph. These are candidates, not guarantees.

This skill closes the gap between tier 2 candidates and confirmed misses by
running ast-dataflow's type-checker-resolved queries against the post-rename
codebase.

**Triggers:**

- `gitnexus_rename` dry-run returned any `ast_search` edits marked "review carefully"
- A rename touches `vi.mock(...)` paths, `fetch(...)` URL strings, SQL template
  fragments, or `process.env[...]` keys
- A post-rename test failure references the old name
- You want a confidence certificate before landing the rename branch

---

## Inputs

| Field | Required | Description |
|---|---|---|
| `oldName` | Yes | The original symbol name (e.g. `generateDigest`) |
| `newName` | Yes | The renamed symbol (e.g. `generateChangeReport`) |
| `oldModulePath` | Yes | Module path before rename (e.g. `@/lib/ai/change-reports`) |
| `newModulePath` | Yes | Module path after rename (e.g. `@/lib/reports/generate-change-report`) |
| `scope` | No | Glob to restrict searches (e.g. `app/**,lib/**,__tests__/**`) |

---

## Workflow

### Step 0 — Confirm gitnexus dry-run output

Before running the battery, confirm you have the `gitnexus_rename` dry-run
output listing:

- How many graph edits (high confidence)?
- How many `ast_search` edits (review carefully)?

The `ast_search` count is the number of sites this battery will
confirm, refute, or extend.

### Step 1 — Q1: String-literal sites (unmissed sites battery)

Run `string-literal-uses` for both the old module path AND the old symbol name
as a string. These two passes catch the two most common miss categories:

**Pass A — old module path as a string literal:**

```bash
bun run ast-dataflow string-literal-uses \
  --value '<oldModulePath>'
```

Catches: `vi.mock('@/lib/ai/change-reports')`, `import(...)` dynamic imports,
`fetch('/api/change-reports/...')` URL fragments, SQL template strings containing the
old path.

**Pass B — old symbol name as a string literal:**

```bash
bun run ast-dataflow string-literal-uses \
  --value '<oldName>'
```

Catches: `registerMock('generateDigest', ...)`, `console.error('generateDigest
failed')`, object-key strings, test description strings (`it('calls generateDigest
when...')`).

**Interpreting Q1 results:**

- Rows with `kind: 'viMock'` — Vitest `vi.mock(...)` argument. **Must update.**
- Rows with `kind: 'argument'` — call-expression argument. **Inspect each: is the
  string semantically tied to the old name, or incidental (e.g. log message)?**
- Rows with `kind: 'sqlTag'` — SQL template fragment. **Must update or confirm
  intentional (e.g. a migration comment).**
- Rows with `kind: 'jsxProp'` — JSX prop value. **Inspect: is it a display
  label or a key?**
- Rows with `kind: 'envKey'` — `process.env[...]` key. **Inspect: does the
  env var name need to change?**

### Step 2 — Q2: Module-level importers (import path sweep)

Run `importers` against the old module path to find any file still importing
it. After a correct rename, this should return zero results (the old module
no longer exists). If it returns results, those files were missed entirely.

```bash
bun run ast-dataflow importers \
  --module '<oldModulePath>'
```

If the old module path was `lib/ai/change-reports.ts`, also run:

```bash
bun run ast-dataflow importers \
  --module '@/lib/ai/change-reports'
```

**Interpreting Q2 results:**

- `error.kind === 'unknown_file'` — the old module path is gone. **This is the
  expected post-rename state.** No misses here.
- `results.length > 0` — files still importing the old path. These are missed
  edits. Each row includes `importStyle` (named/default/namespace/typeOnly/
  reexport) and `namedImports` to guide the update.

### Step 3 — Q3: Type-checker references to new symbol

Run `references` against the renamed symbol to confirm all TS-resolved
references now point to the new name and carry `confidence: 'exact'`.

```bash
bun run ast-dataflow references \
  --symbol '<newModulePath>:<newName>'
```

**Interpreting Q3 results:**

- Every row should have `confidence: 'exact'`. A `confidence: 'wildcard'` or
  `'indirect'` row signals a reference that the type checker could not
  unambiguously resolve — inspect manually.
- Count the rows. Compare with the count from `gitnexus_rename`'s graph-edge
  list. If ast-dataflow finds significantly more, the extra rows are sites
  gitnexus did not index (dynamic callers, HOC-wrapped components, etc.).
- `isDefinition: true` rows are the declaration sites — expected.

### Step 4 — Produce the categorised report

Consolidate the three query outputs into a categorised report:

```
RENAME-SWEEP REPORT
  Symbol:       <oldName> → <newName>
  Module:       <oldModulePath> → <newModulePath>

Q1 — String-literal unmissed sites:
  <n> sites found
  - <file>:<line> — kind: viMock    — ACTION: update vi.mock path
  - <file>:<line> — kind: argument  — ACTION: review (display label vs. key)
  - <file>:<line> — kind: sqlTag    — ACTION: update SQL fragment

Q2 — Module import sweep:
  <n> files still importing old path  (0 = clean)
  - <file> — importStyle: named — namedImports: [<oldName>]

Q3 — New-symbol references:
  <n> references to <newName> (all exact confidence)
  <n> definition sites
  Delta vs. gitnexus graph list: +<n> extra (inspect if > 0)

VERDICT: CLEAN | NEEDS ACTION
  Action items: [list each file:line that requires a manual edit]
```

---

## Worked example — `ai_summary → summary` rename (KH S9.16)

This is the real KH rename from commit `3fec2cf6` (13 Apr 2026). The column
`content_items.ai_summary` was renamed to `content_items.summary` per the AI
Visibility Policy. The rename touched 120+ files but intentionally excluded
`feed_articles.ai_summary` (a different column).

**gitnexus_rename dry-run output (hypothetical):**

```
Symbol:        ai_summary
New name:      summary
Graph edits:   98 (high confidence) — type annotations, .select(), .update() calls
ast_search:     6 (review carefully) — test fixture strings, SQL comments, Python scripts
```

**Q1 Pass A — old column name as string literal:**

```bash
bun run ast-dataflow string-literal-uses --value 'ai_summary'
```

Expected results (subset):

```
__tests__/api/bid-drafting-pipeline.test.ts:47   kind:argument  enclosing:fn:buildBidDraft
__tests__/lib/classify.test.ts:91                kind:argument  enclosing:fn:classifyContentSpec
```

These are test fixture object literals `{ ai_summary: '...' }` that were
missed because gitnexus's `ast_search` is string-match, not AST-context-aware.
All must be updated to `summary`.

**Q1 Pass B — old column name in SQL tag:**

```bash
bun run ast-dataflow string-literal-uses --value 'ai_summary'
```

(Same pass — includes any SQL template fragments.)

The Python files (`scripts/kb_pipeline/*.py`) are outside the ts-morph corpus
so this pass will NOT find them. The CLAUDE.md note "NOT renamed:
feed_articles.ai_summary" was a deliberate scope decision, not a miss.

**Q2 — Module import sweep:**

The column rename does not involve a module path change (it's a DB column, not
a TS symbol). Q2 is not applicable for pure column renames. Skip or run as
a sanity check: `importers --module '@/lib/content/classify'` to confirm no
barrel-chain gaps.

**Q3 — References to new column name:**

```bash
bun run ast-dataflow references \
  --symbol 'supabase/types/database.types.ts:content_items'
```

(The Supabase-generated row type is the canonical declaration for `summary`.)

**Rename-sweep report:**

```
RENAME-SWEEP REPORT
  Symbol:  content_items.ai_summary → content_items.summary

Q1 — String-literal unmissed sites:
  2 sites found (missed by gitnexus ast_search)
  - __tests__/api/bid-drafting-pipeline.test.ts:47 — kind:argument — ACTION: update fixture key
  - __tests__/lib/classify.test.ts:91              — kind:argument — ACTION: update fixture key

Q2 — Module import sweep:
  N/A (column rename, not a module rename)

Q3 — New-symbol references:
  Via Supabase type — not directly addressable by ts-morph symbol lookup.
  Use column-reads/column-writes queries instead:
    bun run ast-dataflow column-reads --table content_items --column summary
    bun run ast-dataflow column-writes --table content_items --column summary

VERDICT: NEEDS ACTION
  2 test fixture files require manual update of 'ai_summary' object keys → 'summary'
```

---

## Self-evaluation

Use this checklist after running the skill to assess completeness. This is the
skill-efficacy evaluation pattern feeding R-WP7.

### Post-invocation checklist

- [ ] **Q1 Pass A executed** — `string-literal-uses --value '<oldModulePath>'`
  ran without error and returned a structured response (not a CLI error).

- [ ] **Q1 Pass B executed** — `string-literal-uses --value '<oldName>'` ran
  without error.

- [ ] **Q2 executed** — `importers --module '<oldModulePath>'` ran. Result is
  either `error.kind === 'unknown_file'` (expected clean state) or returns
  rows that were added to the action list.

- [ ] **Q3 executed** — `references --symbol '<newModulePath>:<newName>'`
  returned results with all rows at `confidence: 'exact'`.

- [ ] **All Q1 hits manually reviewed** — each `kind:argument` row inspected to
  determine if the string is a semantic rename target or an incidental
  occurrence (display label, log message, comment prose).

- [ ] **Unmissed sites confirmed** — for each site in Q1+Q2 that requires
  action, the file was opened and the edit was confirmed correct (not just
  a find-and-replace that could break a different string).

- [ ] **Q3 count cross-checked** — the number of `references` rows was compared
  against the `gitnexus_rename` graph-edge count. Any delta > 3 was
  investigated (possible indirect caller not in gitnexus's index).

- [ ] **Rename-sweep report produced** — the categorised report (Q1 + Q2 + Q3 +
  VERDICT) was written and attached to the PR description or commit message.

- [ ] **Python/SQL corpus noted** — if the codebase has Python scripts or raw
  SQL files, a note was added that `string-literal-uses` does NOT cover
  them (ts-morph TypeScript only). A separate `grep` sweep was run if
  needed.

- [ ] **Tests pass** — `bun run test` passes after all action-item edits.

### Skill efficacy indicators

These signals indicate the skill is working correctly end-to-end:

| Signal | Meaning |
|---|---|
| Q1 finds hits that were NOT in gitnexus's `ast_search` list | Skill is finding real misses — high value |
| Q1 finds hits that WERE in gitnexus's `ast_search` list | Skill is confirming candidates — normal value |
| Q1 finds zero hits | Either rename is clean or the old name is not used as a string literal (both are valid outcomes) |
| Q2 returns `unknown_file` | Expected: old module is gone. Clean. |
| Q2 returns results | Missed import — high-severity action item |
| Q3 returns `ambiguous_symbol` error | Rename target needs a more specific `file:symbol` form |
| Q3 row count > gitnexus graph count | Indirect callers present — investigate each extra row |

---

## Related

- `gitnexus-refactoring` skill — upstream step: runs `gitnexus_rename` dry-run
  and applies graph edits.
- `${KH_PRIVATE_DOCS_DIR}/src/content/docs/specs/id-50-ast-dataflow-tool/TECH.md` §Cross-tool patterns — Pattern 4
  (Rename-sweep verifier) with the full worked-example summary.
- `${KH_PRIVATE_DOCS_DIR}/src/content/docs/specs/id-50-ast-dataflow-tool/investigations/R-WP11-cross-tool-integration.md`
  §Pattern 4 — original investigation brief with rationale.
- R-WP7 (Wave 6) — skill-efficacy evaluation framework that reuses the
  self-evaluation pattern from this skill.

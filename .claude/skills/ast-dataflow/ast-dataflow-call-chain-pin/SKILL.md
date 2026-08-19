---
name: ast-dataflow-call-chain-pin
description: "Use gitnexus_context to identify the execution flow context of a suspect function, then use ast-dataflow callers to enumerate ALL call sites (including indirect callers gitnexus does not index) and inspect argument values at each site. Use when debugging a wrong-argument-value bug: wrong UUID shape, wrong string key, missing required field, wrong typed client. Examples: 'find which caller passes a non-UUID userId to classifyContent', 'pin the call site passing an untyped Supabase client', 'which caller passes the wrong string key to registerMock'"
allowed-tools: Bash, Read, Edit
---

# Call-chain pin (ast-dataflow Pattern 5)

## When to Use

Use this skill when you have a bug that manifests as an **incorrect argument
value** reaching a function. Typical symptom: a runtime error, test failure,
or data-corruption report whose stack trace points to a function that
received the wrong thing — wrong UUID shape, wrong string literal, wrong
typed Supabase client, missing required field.

The skill chains two tools:

1. **gitnexus** — identifies the execution flow context and the direct
   callers that are in the graph index. Fast orientation; does not enumerate
   indirect callers.
2. **ast-dataflow `callers`** — enumerates ALL call sites using the
   TypeScript type checker (`ts-morph.Symbol.findReferences()`). Finds the
   indirect callers that gitnexus does not index: arrow-function callbacks,
   Promise.all wrappers, HOC-wrapped components, test helpers.

Neither tool alone gives the full picture. gitnexus gives context quickly;
ast-dataflow confirms exhaustively.

**Triggers:**

- A runtime error traces to a function that received the wrong UUID (e.g.
  a literal string where a UUID v4 was expected)
- A DB write produced corrupted or missing data and the write function
  received a bad argument
- A test failure shows a mock receiving unexpected arguments
- An auth failure traces to a function passed an untyped client instead of
  `getAuthorisedClient()`
- You need to confirm that a CLAUDE.md gotcha (e.g. "always pass UUID, not
  string") is actually enforced across all call sites

---

## Inputs

| Field | Required | Description |
|---|---|---|
| `suspectFunction` | Yes | The function that received the wrong argument (e.g. `classifyContent`) |
| `modulePath` | Yes | Module path of the function (e.g. `lib/content/classify-content.ts`) |
| `argumentPosition` | Yes | Which argument is suspect (by name or position, e.g. `userId`, `arg[1]`) |
| `expectedContract` | Yes | What the argument must be (e.g. "UUID v4", "typed Supabase client") |
| `scope` | No | Optional glob to restrict the `callers` search |

---

## Workflow

### Step 1 — gitnexus: identify execution flow and direct callers

Run `gitnexus_query` to locate the suspect function in the indexed
execution flows:

```
gitnexus_query({query: "<suspectFunction> <argumentPosition>"})
```

This returns the process names the function participates in (e.g.
`ContentClassificationFlow`, `BatchIngestionFlow`) and the symbol records.

Then run `gitnexus_context` on the function to get the direct callers and
the process step where it appears:

```
gitnexus_context({name: "<suspectFunction>"})
```

**What to read from the output:**

- `Incoming calls` — the direct callers gitnexus has indexed.
- `Processes` — which flow, which step number. Read the process resource
  to understand the full step sequence:
  `gitnexus://repo/knowledge-hub/process/<ProcessName>`
- Note the caller count from gitnexus — you will compare this against
  the ast-dataflow caller count in Step 2.

---

### Step 2 — ast-dataflow: enumerate ALL callers

Run `callers` against the suspect function using the full
`modulePath:functionName` form:

```bash
bun run ast-dataflow callers \
  --symbol '<modulePath>:<suspectFunction>'
```

**What to read from the output:**

- `results.length` — compare with gitnexus's direct-caller count. Any
  additional rows are indirect callers (callbacks, HOC wrappers, etc.) that
  gitnexus did not index. These are your investigation targets.
- `enclosing` — the function or method that wraps the call site. This is the
  first-level caller; its own callers determine how the argument value
  reaches the suspect function.
- `resolution` — `direct` (normal import) or `aliased` (imported under a
  different name). An `aliased` call site requires inspecting the alias to
  confirm the argument contract.
- `file` + `line` — open each file at the returned line to inspect the
  argument value being passed.

---

### Step 3 — inspect argument values at each call site

For each row returned by `callers`, open the file and read the argument
at the position named in `argumentPosition`.

**Classification pattern:**

```
For each call site row:
  - Read <file> at <line>
  - Find the argument at <argumentPosition>
  - Classify the argument expression:
      CONSTANT    — a named constant (e.g. PIPELINE_SYSTEM_USER_ID) → check const type
      LITERAL     — a hardcoded string/number → inspect value + type
      PARAMETER   — passed through from the caller's own arguments → trace up one level
      COMPUTED    — a function call or expression → inspect the return type
```

Any `LITERAL` that does not satisfy `expectedContract` is the bug location.
Any `PARAMETER` requires tracing up to the enclosing function's callers
(you may need to run `callers` on the enclosing function as well).

---

### Step 4 — produce the call-chain pin report

Consolidate the findings into a pin report:

```
CALL-CHAIN PIN REPORT
  Function:    <modulePath>:<suspectFunction>
  Argument:    <argumentPosition>
  Contract:    <expectedContract>

Callers found:
  gitnexus direct callers:  <n>
  ast-dataflow total:        <n>
  Additional indirect:       <n>  (arrow-fn callbacks / Promise.all / HOC)

Call-site inspection:
  <file>:<line>  CONSTANT   <constName>  → <satisfies/violates contract>
  <file>:<line>  LITERAL    '<value>'    → VIOLATION — expected <contract>
  <file>:<line>  PARAMETER  <paramName>  → trace required (enclosing: <fn>)
  <file>:<line>  COMPUTED   <expr>       → <satisfies/violates contract>

BUG LOCATION(S):
  <file>:<line> — passes <value> (expected: <contract>)

SAFE CALL SITES:
  <n> sites confirmed correct
```

---

## Worked example — `classifyContent` userId UUID contract

### Background

`classifyContent` accepts a `userId: string` parameter which **must** be a
UUID v4. The canonical value is the pipeline service account UUID:

```
a0000000-0000-4000-8000-000000000001
```

This is the "CLAUDE.md gotcha": passing a literal string like `'admin'` or
`'system'` instead of a UUID silently corrupts DB records because Supabase
inserts the literal as a `uuid` column value, which may pass server-side
validation but violates the semantic contract.

### Step 1 — gitnexus context

```
gitnexus_query({query: "classifyContent userId"})
→ Processes: ContentClassificationFlow, BatchIngestionFlow
→ Symbols: classifyContent, batchClassifyContent, ContentClassificationRoute
```

```
gitnexus_context({name: "classifyContent"})
→ Incoming calls: batchClassifyContent (lib/content/), ContentClassificationRoute
→ Processes: ContentClassificationFlow (step 2/5)
→ Direct callers known to gitnexus: 2
```

Reading the process resource:

```
gitnexus://repo/knowledge-hub/process/ContentClassificationFlow
→ Step 2: classifyContent — receives userId from caller, passes to DB write
→ Risk: any non-UUID userId reaching classifyContent corrupts DB records
```

### Step 2 — ast-dataflow callers

```bash
bun run ast-dataflow callers \
  --symbol 'lib/content/classify-content.ts:classifyContent'
```

Expected output shape (illustrative):

```json
{
  "query": "callers",
  "results": [
    {
      "file": "lib/content/classify-content.ts",
      "line": 47,
      "enclosing": { "kind": "function", "name": "batchClassifyContent" },
      "resolution": "direct"
    },
    {
      "file": "app/api/content/classify/route.ts",
      "line": 31,
      "enclosing": { "kind": "function", "name": "POST" },
      "resolution": "direct"
    },
    {
      "file": "lib/content/classify-content.ts",
      "line": 89,
      "enclosing": { "kind": "arrowFunction", "name": "processItem" },
      "resolution": "direct"
    },
    {
      "file": "__tests__/lib/content/classify-content.test.ts",
      "line": 54,
      "enclosing": { "kind": "arrowFunction", "name": "<anonymous>" },
      "resolution": "direct"
    }
  ]
}
```

gitnexus found 2 direct callers. ast-dataflow found 4 — the 2 additional
are a Promise.all arrow-function wrapper (`processItem`) and a test helper.
These are your investigation targets.

### Step 3 — argument inspection at each call site

Open each file at the returned line and inspect the `userId` argument:

```
lib/content/classify-content.ts:47    CONSTANT  PIPELINE_SYSTEM_USER_ID  → satisfies UUID contract ✓
app/api/content/classify/route.ts:31  PARAMETER userId (from POST body)   → trace required
lib/content/classify-content.ts:89    LITERAL   'admin'                   → VIOLATION — not a UUID ✗
__tests__/lib/content/classify-content.test.ts:54  LITERAL  '00000000-0000-4000-a000-000000000001' → satisfies UUID ✓
```

The `PARAMETER` case at `route.ts:31` requires one more level of tracing:
read the `POST` handler to see where `userId` comes from. If it comes from
`getAuthorisedClient()` → `auth.session.user.id`, it is a UUID (auth tokens
carry UUID user IDs). If it comes from a request body field that is not
validated, it may not be.

### Step 4 — pin report

```
CALL-CHAIN PIN REPORT
  Function:    lib/content/classify-content.ts:classifyContent
  Argument:    userId
  Contract:    UUID v4 (matches /^[0-9a-f]{8}-...-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
               OR pipeline service account UUID a0000000-0000-4000-8000-000000000001

Callers found:
  gitnexus direct callers:  2
  ast-dataflow total:        4
  Additional indirect:       2  (Promise.all arrow-fn + test helper)

Call-site inspection:
  lib/content/classify-content.ts:47           CONSTANT  PIPELINE_SYSTEM_USER_ID → satisfies contract ✓
  app/api/content/classify/route.ts:31         PARAMETER userId (POST body)       → needs trace ⚠
  lib/content/classify-content.ts:89           LITERAL   'admin'                  → VIOLATION ✗
  __tests__/lib/content/classify-content.test.ts:54  LITERAL  '00000000-...'     → satisfies contract ✓

BUG LOCATION:
  lib/content/classify-content.ts:89 — passes 'admin' (expected: UUID v4)
  Fix: replace with PIPELINE_SYSTEM_USER_ID constant from @/lib/content/constants

SAFE CALL SITES: 2 confirmed correct; 1 needs further trace
```

---

## Generalising to other wrong-argument bug classes

The same four-step workflow applies to any argument-value contract:

| Contract class | What to look for in Step 3 |
|---|---|
| UUID vs. string literal | Literal values matching `/^[0-9a-f]{8}-/` or not |
| Typed Supabase client | Argument is `getAuthorisedClient()` return or raw `createClient()` |
| Auth-checked vs. raw call | Route handler goes through `getAuthorisedClient()` before the call |
| `sb()` wrapper vs. raw `.from()` | `callers` on `lib/supabase/safe.ts:sb` to find where raw calls bypass the wrapper |
| Number shape (pagination offset) | Literal numeric values: are they 0-indexed or 1-indexed? |

---

## Self-evaluation checklist

After running this skill, use the following checklist:

- [ ] **gitnexus_context executed** — `Incoming calls` and process step recorded.
- [ ] **ast-dataflow callers executed** — result count compared with
  gitnexus direct-caller count. Any delta investigated.
- [ ] **All call sites inspected** — each row opened at file:line and
  argument classified (CONSTANT / LITERAL / PARAMETER / COMPUTED).
- [ ] **PARAMETER cases traced** — for any PARAMETER classification, the
  enclosing function's callers were checked to confirm the value satisfies
  the contract at the source.
- [ ] **Pin report produced** — bug location(s), safe sites, and action
  items written up.
- [ ] **Fix applied at bug location** — not just a comment or a type
  annotation — the argument expression changed to pass the correct value.
- [ ] **Tests pass** — `bun run test` passes after the fix.

---

## Related

- `ast-dataflow-rename-sweep` — Pattern 4: post-rename verification
  (sibling skill, same family)
- `.claude/skills/ast-dataflow/SKILL.md` — catalogue of all queries + all
  9 cross-tool patterns
- `${KH_PRIVATE_DOCS_DIR}/src/content/docs/specs/id-50-ast-dataflow-tool/investigations/R-WP11-cross-tool-integration.md`
  §Pattern 5 — original investigation brief with rationale and open questions
- `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` — upstream step:
  execution-flow debugging before narrowing to argument inspection
- CLAUDE.md §Gotchas — "`classifyContent` userId must be a UUID" (Data &
  Architecture section)

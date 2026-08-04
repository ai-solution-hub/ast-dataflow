# Gap register

Two independent efficacy trials were run against a real production repository — not a
fixture corpus — each verified by a second reviewer working from the raw output. Both
trials had the shape this tool is actually used for: sweeping a codebase for the residue
of a rename, and proving a retired vocabulary is really gone. Every site behind a
correctness claim below was opened by hand.

This is the register those trials produced. It exists because the numbers in it are the
only honest basis for deciding which answers to trust, and because publishing a tool's
measured failure rate is more useful than publishing its feature list.

Priorities and current status are in [`../ROADMAP.md`](../ROADMAP.md).

## Verdict

**Cleared as a precision instrument. Not cleared as an inventory instrument.**

Cleared for _"is this specific thing still there, still reachable?"_. Not cleared for
_"how many sites are there?"_.

The distinction is not pedantic. The queries that answer the first question resolve
through the type checker and are right about the sites they name. The queries that would
answer the second one over-count in a way that varies by table shape, so the count is
wrong by an amount you cannot estimate without opening every site — at which point the
count was not the thing you needed.

### What it drove end to end, unaided

Worth stating alongside the failures, because the same trials produced both. A tool-name
sweep across 36 sites with zero noise. The named-symbol half of a rename sweep — 5 of 5,
11 of 11, 8 of 8 — with comments and string labels correctly excluded and no bleed into
three same-named local declarations. Correct-zero confirmations that two retired concepts
really were gone. A loud, structured error on a dropped table where a silent empty result
would have read as "no callers". And a cross-language schema verdict that re-graded 183 of
807 columns, moving six out of "unwired" once evidence from another language was merged.

## The four binding caveats

Each is measured, and each binds until the gap named beside it lands.

**1. Never quote a `column-writes` count.** Column attribution is table-level wherever the
client is not type-instantiated: 18.5 % pooled false positives across 65 hand-checked
sites, and around 44 % of returned rows come back for any real column name whatsoever.
Open every site, or wait for **G8**. A column that is not in the target repo's generated
types no longer returns rows at all — it errors — but for columns that _do_ exist the
attribution is unchanged.

**2. Never read a `string-literal-uses` zero as absence.** A zero means "no call-site
argument literal", not "no literal". Comparisons, property values and array elements are
dropped silently. Measured 0 of 24 on one sweep (**G1**).

**3. Never read any zero as corpus-covered.** Membership is transitive over the tsconfig
import graph — unpredictable, and unstable across refactors that have nothing to do with
your query (**G12**).

**4. `schema-coverage --evidence` is the one surface cleared for verdict-grade use.** Run
it with the sidecar or not at all. It is also the only surface that handles the G8 counter
correctly.

## Ranked gaps

Ranked by impact times effort, where impact asks one question: does the gap produce a
_wrong_ verdict, or merely a slow one? Every wrong-verdict gap outranks every ergonomics
gap. "Two-directional" marks a gap both trials hit independently from different task
shapes — the strongest signal here, because the trials shared no methodology.

| rank | id            | impact                             | effort     | two-dir | one line                                                 |
| ---- | ------------- | ---------------------------------- | ---------- | ------- | -------------------------------------------------------- |
| 1    | **G8**        | wrong verdict — measured           | low–med    | yes     | `column-writes` fabricates column attribution            |
| 2    | **G1**        | wrong verdict — silent zeros       | med        | yes     | `string-literal-uses` drops the dominant literal shapes  |
| 3    | **G2+G3**     | makes every other gap invisible    | low        | yes     | zeros and unknown tables carry no caveat _(closed)_      |
| 4    | **G12** (⊃G6) | wrong verdict — retroactively      | low / high | yes     | corpus membership is transitive, unpredictable, unstable |
| 5    | **G11**       | coverage hole — largest measured   | low        | —       | no identifier-text query exists                          |
| 6    | **G9**        | blocks provable closure            | med        | —       | `references` has no member-level resolution              |
| 7    | **G4**        | wrong error kind on a common idiom | low        | —       | `enum-uses` blind to as-const arrays                     |
| 8    | **G10**       | ergonomics                         | low        | —       | truncation has no narrowing path _(closed)_              |
| 9    | **G5**        | ergonomics                         | low        | —       | `fixture-uses` is whole-token only                       |
| 10   | **G7**        | throughput                         | low        | yes     | 5–12 s cold load per literal query                       |

### G8 — `column-writes` fabricates column attribution

The register's headline, and a correctness defect in a query that earlier guidance told
readers to trust. It is what refuted the first trial's own scorecard line claiming the
column queries were the stars with zero over-reports.

Measured twice, independently, on disjoint column sets, with every site opened:

| measurement                                    | sites  | false  | rate       |
| ---------------------------------------------- | ------ | ------ | ---------- |
| trial B — three columns, two tables            | 17     | 4      | 23.5 %     |
| trial B verifier — three columns, three tables | 48     | 8      | 16.7 %     |
| **pooled — 6 columns / 5 tables**              | **65** | **12** | **18.5 %** |

**The sharpest repro: the column argument carries no information at all.** Querying a wide
table for a column name that does not exist returned 10 hits, each stamped with the
nonexistent column. Ten of the twelve genuine hits for a _real_ column on that table were
in the same set, so only 2 of 12 were actually column-attributable. Per-table noise floors
across the five tables ran 3, 4, 4, 7 and 10 rows — **21 of 48 rows, 44 %, come back for
any column name whatsoever.**

Two mechanism findings any fix has to absorb:

- **`confidence` does not discriminate.** All 65 pooled rows came back `indirect` and
  `isTyped: false`. The path that would emit `exact` requires a type-instantiated client,
  and the detection returned false on every chain probed. Where every row is `indirect`,
  the label separates nothing. Repo-wide, 115 of 807 columns had any exact write evidence
  against 616 with indirect.
- **The one-hop chase is too narrow.** Payload resolution follows `const x = { … }` and
  stops. A payload built by `.map()`, assembled in a loop, or wrapped in `satisfies` /
  `as` all fall through to "cannot rule out", which is why fixture builders dominate the
  false set.
- **The clearest single symptom:** one line was returned as a write site for two different
  columns of the same table, one of which it genuinely writes and one of which it does
  not.

The false-positive rate is **not uniform**. It tracks how many of a table's columns a
typical payload omits, so wide tables with many optional columns are worst and
NOT-NULL-heavy tables look clean. That is exactly backwards from what a retirement sweep
needs, because the wide optional tables are the ones with dead columns in them.

**Proposed fix.** Give writes the wildcard honesty reads already have: when the queried
column is not provably a key of the payload, emit `columnPath: "*"` with
`confidence: "wildcard"` — or an explicit "writes an unattributed column of this table" —
so the count stops reading as a per-column answer. A flag can preserve today's behaviour
for callers who want the superset. A reference implementation already ships in this
package on the Python side: an attributable payload key is `exact`, an unattributable
resolved site emits a table-scoped `*` row plus a loud caveat. The fix is the
declaration-versus-proof discipline of [`SIDECAR.md`](./SIDECAR.md) applied to
`column-writes`' presentation layer.

#### A reasoning pattern this retires

One earlier analysis concluded it had found an _exhaustive_ writer set, on the grounds
that running `column-writes` against two different columns of the same table returned the
same answer. Under G8, identical-across-columns is the **fingerprint of the defect, not
corroboration of exhaustiveness** — a table-level result is invariant in the column
argument by construction.

The same class of mistake can be written into an acceptance criterion. "Query X shows no
writer" is not executable against a table with a measured ten-row noise floor for any
column name: the query can never show zero, so the criterion can only be discharged by
opening all ten rows by hand. If you are writing a gate that depends on a `column-writes`
zero, it is not a gate.

### G1 — `string-literal-uses` drops the dominant literal shapes

Two-directional, and the only gap that produced silent zeros over load-bearing production
code in both trials.

The query classifies five call-site contexts — `viMock`, `jsxProp`, `sqlTag`, `envKey`,
`argument` — and drops comparisons, object-property values, array elements, type-position
literals, return statements and const initialisers. This is intentional by design: it is a
call-site context search, not a raw text search. It is also exactly wrong for the rename
and retirement sweeps that are the tool's most common job.

Measured: 6 of one trial's 8 literal classes under-report, three of them to zero, and two
of the zeros were load-bearing — an equality comparison driving a freshness rule, and
another driving an inference rule. The other trial measured 0 of 24 property-value sites,
0 of 7 array-element sites, and 0 of 6 telemetry-value sites. **Property-value is the
single most common persisted-enum shape** in a typical TypeScript codebase, and it is
invisible.

**Fix:** add `comparison`, `caseClause`, `propertyValue`, `arrayElement`, `typeLiteral`
and `initializer` kinds — or an all-contexts flag defaulting on — keeping today's set as a
filter. For `comparison`, carry the left-hand expression text: that is what makes
load-bearing-versus-stale triage mechanical instead of manual (see O2).

Both trials independently reached the same secondary conclusion, and it is the reason to
fix this query rather than abandon it for a text search: **with those kinds, it would beat
`rg`.** Its silence on 221 comment-only files is exactly right. Its ten correct
suppressions of lint-rule fixture strings are noise a text search cannot filter. And its
correct zero on one needle — where every survivor was a comment — is the proof.

### G2 + G3 — the silence problem (closed)

Recorded because it explains the shape of the fix that landed, and because the reference
implementation argument generalises.

- **G2** — zero results carried no caveat. Neither the kind filter of G1 nor the corpus
  membership of G12 was stated in any response, so "no sites exist", "no sites in the
  shapes I search" and "your target is not in my corpus" were structurally identical
  payloads.
- **G3** — `column-reads` and `column-writes` on an unknown column _or_ unknown table
  returned a silent `[]`, while `schema-coverage` — same binary, same generated types —
  reported the unknown table loudly with a hint. One trial hit this live on a dropped
  column, where "zero readers" and "the column no longer exists" were indistinguishable.

The refinement that mattered: for an unknown column on a _real_ table the two queries
diverged. `column-reads` returned honestly labelled wildcard rows; `column-writes`
returned rows falsely stamped with the bogus column name. "Silent `[]`" understated it —
**it fabricated**, which is G8 reached from the other side.

**Fix, shipped:** treat the `schema-coverage` response envelope as the house style and
retrofit it to every query — a caveats block naming the kinds searched, the corpus, and
the excluded surfaces; loud `unknown_table` / `unknown_column` errors with near-miss
hints; and a summary histogram. No new analysis was required, because the good
implementation already existed in one query. Lowest effort and highest leverage in the
register. Residual holes are tracked in the roadmap.

### G12 — corpus membership is unstable

A widening of an earlier gap about which directories are in scope, and the finding that
promoted it from tidiness to correctness.

The boundary is not "scripts are excluded". In the trial repo, a `tsconfig` excluding a
scripts directory still pulled **51 of 82 files in it into the corpus** by transitive
import from tests. One script was in, a neighbouring one was out, with nothing on the CLI
to tell you which.

Worse: **membership is not stable across unrelated refactors.** Proven by checking out a
detached worktree at an older commit and running _that commit's own binary_: a literal
query returned 27 hits across 11 files, of which 17 came from a single script. The same
query today returns 7. A refactor rewrote that script and its test, dropping it out of the
import graph — so a fixed query silently changed meaning because of work that had nothing
to do with it. Ruled out as a methodology artefact: the query implementation had two
commits in the interval and the later one only swapped a truncation helper; the
classification logic was untouched.

**Fix:** short term, a CLI `corpus-info` (MCP-only today) plus per-target membership in
the response — whether the `--file` or `--symbol` you asked about is actually in the
corpus. Long term, a decision on pinning or declaring the corpus. The trials supply the
evidence that this is a correctness question rather than a tidiness one.

### G11 — no identifier-text query exists

The largest pure coverage hole measured. The dominant residual shape in a vocabulary
retirement is neither a literal nor a symbol: it is an identifier — response keys, count
fields, foreign-key names sharing a stem. On one needle this was 24 files; across three
needles, 306 TypeScript files.

It is addressable by neither `string-literal-uses` (not a literal) nor `references` (no
single declaration — the same key is an independent member of roughly ten unrelated
interfaces).

**Fix:** an `identifier-uses --name <ident>` query over `Identifier`, `PropertyAssignment`
and `PropertySignature` nodes. Cheap, no type resolution needed. This one is explicitly a
build-versus-integrate question rather than an obvious build: a text search already
answers it approximately, and an LSP "find references" answers part of it.

### G9, G4, G10, G5, G7

- **G9** — `references` has no member-level resolution. Addressing an interface or type
  property as `file.ts:propName` errors `out_of_corpus`, which is the wrong error kind —
  the same mis-kind as G4, reporting "unsupported granularity" as "not in corpus". This is
  what blocked provable closure on both of one trial's atomic-set problems, which is
  exactly the case where a rename must be provably complete rather than probably complete.
  Fix: support `File.ts:Interface.member` addressing, and distinguish
  `unsupported_granularity` from `out_of_corpus`.
- **G4** — `enum-uses` supports enums and as-const _objects_ but not as-const _arrays_,
  which is a common convention for controlled vocabularies in TypeScript. Both live probes
  against as-const arrays errored `out_of_corpus`; 3 of 3 probes failed. Cheap to fix.
- **G10** — `references` on a hub object returned 200 rows with `truncated: true` and an
  honest total of 285, but no offset, no limit hint and no narrowing path, so the 85
  unseen rows were unreachable and closure unprovable. Fixed by the envelope work; a
  residual hole in one query's truncation accounting is tracked in the roadmap.
- **G5** — `fixture-uses --needle` is whole-token exact-match, so a needle appearing
  inside a longer path or identifier is invisible with no flag to widen. Fix: a substring
  mode, or substring by default with a `matched` field showing the containing token.
- **G7** — around 0.5–1.4 s for `references` but **5–12 s per `string-literal-uses`**,
  where cold project load dominates. One trial spent roughly 2.5 minutes on redundant
  loads across 20 queries. Fix: accept several `--value` arguments per invocation to
  amortise one load across a literal set. Cheaper than the alternative of running the MCP
  server for everything.

## Opportunities

Not gaps — nothing here returns a wrong answer — but each is real leverage.

| id     | what                                                                                                                                                                                                                                                                                                                       |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **O1** | No query connects a const to its literal value. `references` tracks the symbol, `string-literal-uses` tracks the string, and nothing joins them. Fix: carry `literalValue` on `references` rows for string-const declarations                                                                                              |
| **O2** | Load-bearing-versus-stale classification stays human judgement. A `comparison` kind carrying the left-hand expression text gets most of the way                                                                                                                                                                            |
| **O3** | `schema-coverage` was the reference implementation for output ergonomics; retrofitting its envelope closed G2 and G3 with existing code. _(done)_                                                                                                                                                                          |
| **O4** | `unwired` is under-qualified. In one run, 6 of 85 `unwired` verdicts (7 %) were columns written live from another language. The caveat names the unmeasured surface, but the verdict _token_ reads as "dead". Fix: an `unwired-in-ts` token, or a per-row `externalSurfacesUnmeasured` flag whenever no sidecar was merged |
| **O5** | Absence guards in a test suite are a first-class artefact of any retirement and are currently invisible. Once G1 lands, a kind-filtered sweep makes finding them mechanical — worth a documented recipe                                                                                                                    |

## Why the acceptance corpus could not adjudicate this register

Stated plainly, because it is itself a finding.

Every proposal above was checked against the 25-case acceptance corpus that existed at the
time. G8's proposed fix newly covers four of the hard cases — all four being "the payload
is not a resolvable literal", which is precisely the class the one-hop chase falls through
on. Two others stay unaddressed, because they are a detector question rather than an
attribution one. **G1, G2, G3, G4, G5, G7, G9, G10, G11 and G12 cover none of the 25.**

**The gate is mis-scoped, not the proposals.** Those 25 cases are a _Python declarative
write_ acceptance corpus. Ten of the twelve gaps are _TypeScript-surface_ detector and
output-contract gaps it was never built to adjudicate. G12 illustrates it cleanly: the
corpus cannot speak to corpus instability at all, because the Python scanner walks a
directory and never touches tsconfig reachability, so the failure mode does not exist on
that side.

Applying "reject proposals that cover nothing in the corpus" literally would reject eleven
of twelve, ten of which are backed by direct measurement on real code — 18.5 % false
positives over 65 opened sites, 0 detected of 24, and a proven retroactive change of
meaning. Nothing is rejected on corpus grounds. The trials' own measurements are the
stronger gate, and the honest conclusion is that the missing artefact is the corpus:

> **T1 — build the TypeScript acceptance corpus.** There is no TypeScript equivalent of
> the Python declarative-surface inventory, and that is why the TypeScript queries shipped
> with these gaps undetected. The trials already produced the seed: 65 hand-checked write
> sites with per-site verdicts, a 345-file decomposition of one identifier sweep into
> visible / literal-in-unhandled-position / identifier-only / comment-only / out-of-corpus
> buckets, and eight literal classes with per-class ground truth. It gates the detector
> work rather than sitting beside it.

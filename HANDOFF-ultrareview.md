# Handoff: ultrareview session (parallel to the main working session)

Untracked scratch file — delete after use, do not commit.

## Your one job

Run the deep review and report findings. Do **not** fix, commit, merge, or touch
branches — a parallel session (the one that wrote this) holds all merges and will
action the findings. If you feel compelled to fix something, write it down instead.

## What to run

Recommended target — the unmerged MCP-server migration, this repo's largest and
newest code surface:

```
/code-review ultra 12
```

PR #12 (`issue-2-registertool`): migrates the MCP server from a hand-rolled
low-level `Server` to `McpServer.registerTool` with strict per-query Zod schemas,
adds `outputSchema`/`structuredContent`/tool annotations, uniform `isError`, and
implements `dead-exports --scope`. Key files: `tools/ast-dataflow/mcp-server.ts`,
`tools/ast-dataflow/mcp-schemas.ts`, `tools/ast-dataflow/dispatch.ts`,
`tools/ast-dataflow/queries/dead-exports.ts`, `tools/ast-dataflow/__tests__/mcp-server.test.ts`.

**Timing**: a rebase of PR #12 onto current main is in flight right now. Before
launching, check the PR page — start once the branch shows no conflicts with main
and CI is green on the rebased head. If it still shows conflicts, wait a few
minutes.

## Repo state (as of this handoff)

- main `d37927f`: PR #11 (identifier-leak sweep, closes #10) and PR #17
  (ADRs 0001/0002 in `docs/adr/`) both merged today. CI green.
- PR #12 is verified but deliberately unmerged, held for this review. It already
  survived two independent fresh-context verification passes (56 wire-level
  probes: strict-args rejection on all 15 queries, read-only proof via file-tree
  snapshot, path-confinement equivalence for existing vs missing targets), so
  the easy surface is covered — latent, subtle, or structural bugs are what's
  left and what ultra is for.
- Suites at the rebased head should be ~403 TS + 39 Python, zero failures.

## Known and deliberate — do not re-report

- **Deferred to issue #3** (tracked, intentional): no pagination/offset, no
  `responseFormat` markdown option over MCP, no character/size cap on responses,
  thin stdio-transport test coverage.
- **Measured product gaps, tracked in ROADMAP.md / gap register** (not PR #12
  defects): `column-writes` table-level attribution (G8), `string-literal-uses`
  dropped contexts (G1), corpus-membership instability (G12).
- **Issue #7** already catalogues spec-conformance defects on the CLI side
  (e.g. `type-drift-detect --ci` writing into cwd) — new findings there are
  valuable, duplicates of #7's list are not.
- CLI path arguments are unconfined **by design** (see README "Path
  confinement") — only the MCP surface is allowlist-confined.

## Where context lives

- `README.md` — external contract (envelope, path confinement, caveats)
- `ROADMAP.md` + `docs/gap-register.md` — measured gaps and their status
- `docs/audits/mcp-audit-2026-08-04.md` — the audit PR #12 answers
- `docs/adr/0001`, `docs/adr/0002` — warm-path and evidence-sidecar decisions
- Open issues: #3, #4 (two envelope holes remain), #7, #13–#16 (migrated backlog)

## After the review

Paste or summarise the findings back to the main session (or leave them in the
review's output for it to pick up). The main session will rebase-merge PR #12
once findings are triaged.

/**
 * Zod schemas for the MCP surface (issue #2, audit HIGH-2/HIGH-3 and
 * MEDIUM-4 in docs/audits/mcp-audit-2026-08-04.md).
 *
 * The old server advertised `args` as a bare `{type:'object'}`, so an
 * unknown or misspelled flag was silently accepted, ignored, and echoed back
 * as if honoured (measured: `excludeTests` on `callers` no-oped; `limmit: 1`
 * dropped). Here every query gets a STRICT schema mirroring its args type in
 * types.ts: unknown keys are rejected with a message naming the valid keys,
 * before any query code runs.
 *
 * `QUERY_ARG_SCHEMAS` is an exhaustive `Record<QueryName, …>` — the same
 * structural-parity argument dispatch.ts and caveats.ts make: adding a query
 * to QUERY_NAMES without declaring its wire schema is a compile error, not a
 * silently unvalidated tool argument.
 *
 * The CLI keeps its own flag parsing (exit-2 messages stay byte-identical);
 * these schemas govern the MCP surface only.
 */

import { z } from 'zod';
import { QUERY_NAMES } from './dispatch';
import type { QueryName } from './dispatch';

const limit = z.number().int().min(1).optional();
const scope = z.string().min(1).optional();
const excludeTests = z.boolean().optional();

/**
 * One strict schema per query, mirroring the `<Query>Args` interfaces in
 * types.ts. Every declared argument is honoured by the query it belongs to —
 * advertising an inert argument would recreate the defect this file fixes
 * (`DeadExportsArgs.scope` was exactly that until issue #2 implemented it).
 */
export const QUERY_ARG_SCHEMAS: Record<
  QueryName,
  z.ZodObject<z.ZodRawShape>
> = {
  callers: z.strictObject({ symbol: z.string().min(1), limit, scope }),
  callees: z.strictObject({
    symbol: z.string().min(1),
    limit,
    includeExternal: z.boolean().optional(),
  }),
  importers: z.strictObject({ modulePath: z.string().min(1), limit }),
  references: z.strictObject({
    symbol: z.string().min(1),
    limit,
    kind: z
      .enum([
        'read',
        'write',
        'typeReference',
        'jsxComponent',
        'reexport',
        'typeOnly',
      ])
      .optional(),
    scope,
  }),
  'column-reads': z.strictObject({
    table: z.string().min(1),
    column: z.string().min(1),
    limit,
    excludeTests,
  }),
  'column-writes': z.strictObject({
    table: z.string().min(1),
    column: z.string().min(1),
    limit,
    excludeTests,
  }),
  'type-evolution': z.strictObject({
    type: z.string().min(1),
    property: z.string().min(1),
    file: z.string().min(1).optional(),
    limit,
    excludeTests,
  }),
  'dead-exports': z.strictObject({
    scope,
    excludeTests,
    symbol: z.string().min(1).optional(),
    symbolsFile: z.string().min(1).optional(),
    limit,
  }),
  'reexport-chain': z.strictObject({
    symbol: z.string().min(1),
    from: z.string().min(1).optional(),
    excludeTests,
    limit,
  }),
  'enum-uses': z.strictObject({
    enum: z.string().min(1),
    member: z.string().min(1).optional(),
    limit,
  }),
  'string-literal-uses': z.strictObject({ value: z.string().min(1), limit }),
  'fixture-uses': z.strictObject({
    needle: z.string().min(1),
    kinds: z.array(z.enum(['key', 'value'])).optional(),
    scope,
    limit,
  }),
  'flow-trace': z.strictObject({
    originFile: z.string().min(1),
    originLine: z.number().int().min(1),
    originColumn: z.number().int().min(1),
    maxDepth: z.number().int().min(1).max(20).optional(),
    interFunction: z.boolean().optional(),
    limit,
    excludeTests,
  }),
  // ci / updateBaseline / json / pretty are deliberately ABSENT (audit
  // UNDECIDABLE-2, decided here): they are CLI presentation and
  // baseline-write modes, inert over MCP (verified: the query function only
  // READS the baseline; all writes live in cli.ts). Accepting them would be
  // the silently-honoured-flag defect again; rejecting keeps the tool's
  // readOnlyHint honest. unknownArgsMessage names them when they arrive.
  'type-drift-detect': z.strictObject({
    scope,
    limit,
    interfacePattern: z.string().min(1).optional(),
  }),
  'schema-coverage': z.strictObject({
    table: z.string().min(1).optional(),
    column: z.string().min(1).optional(),
    scope,
    limit,
    evidence: z.array(z.string().min(1)).optional(),
  }),
};

const TYPE_DRIFT_CLI_ONLY = new Set(['ci', 'updateBaseline', 'json', 'pretty']);

function unknownArgsMessage(query: QueryName, keys: string[]): string {
  const valid = Object.keys(QUERY_ARG_SCHEMAS[query].shape);
  const plural = keys.length > 1 ? 's' : '';
  const base =
    `Unknown argument${plural} ${keys.map((k) => `'${k}'`).join(', ')} for query '${query}'. ` +
    `Valid arguments: ${valid.join(', ')}.`;
  if (
    query === 'type-drift-detect' &&
    keys.some((k) => TYPE_DRIFT_CLI_ONLY.has(k))
  ) {
    return (
      base +
      ' The ci, updateBaseline, json and pretty flags are CLI presentation/baseline modes; ' +
      'over MCP the response is always the JSON envelope and nothing is written.'
    );
  }
  return base;
}

/**
 * The `ast_dataflow` tool input: `{query, args}` — the same wire shape the
 * old server accepted, so no caller changes — but validated as a
 * discriminated union on `query`: the strict per-variant schema for the
 * chosen query judges `args`, and both levels reject unknown keys.
 *
 * The union is applied via `superRefine` on a strict object rather than as a
 * top-level `z.discriminatedUnion`, because the SDK can only advertise an
 * OBJECT schema in `tools/list` — a top-level union would list as an empty
 * `{type:'object'}`, trading away the discoverability this migration exists
 * to add. Validation is identical either way: the refinement runs the
 * variant schema and re-raises its issues under `args.…` paths.
 */
export const AST_DATAFLOW_INPUT = z
  .strictObject({
    query: z.enum(QUERY_NAMES).describe('The query to run.'),
    args: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Query arguments (camelCase keys, same shapes as the CLI flags). ' +
          'Validated strictly against the chosen query — unknown keys are rejected, never ignored.',
      ),
  })
  .superRefine((val, ctx) => {
    const parsed = QUERY_ARG_SCHEMAS[val.query].safeParse(val.args ?? {});
    if (parsed.success) return;
    for (const issue of parsed.error.issues) {
      if (issue.code === 'unrecognized_keys') {
        ctx.addIssue({
          code: 'custom',
          path: ['args'],
          message: unknownArgsMessage(val.query, issue.keys),
        });
      } else {
        ctx.addIssue({
          code: 'custom',
          path: ['args', ...issue.path],
          message: issue.message,
        });
      }
    }
  });

/**
 * Input schema for nullary tools: no arguments, strictly enforced — junk
 * keys are rejected, but a client that omits `arguments` entirely (the field
 * is optional in the protocol) still passes.
 */
export const NO_ARGS_INPUT = z.preprocess(
  (value) => value ?? {},
  z.strictObject({}),
);

/** The per-call staleness sweep every warm response carries (inv 22). */
const STALENESS_META = z
  .object({
    refreshedFiles: z.array(z.string()),
    addedFiles: z.array(z.string()),
    removedFiles: z.array(z.string()),
    staleFiles: z
      .array(z.string())
      .describe(
        'Files that could not be refreshed this call — answers may be stale for them.',
      ),
  })
  .describe('Per-call staleness sweep over the warm corpus.');

/**
 * The uniform response envelope (see README "Response envelope"), declared
 * as the tool's outputSchema so clients get `structuredContent` they can
 * consume without parsing text (audit MEDIUM-4).
 *
 * Loose objects throughout: the envelope's documented core is pinned, while
 * per-query extras (callees `externalCount`, schema-coverage's richer
 * caveats) flow through rather than failing output validation.
 */
export const AST_DATAFLOW_OUTPUT = z.looseObject({
  query: z.string(),
  args: z
    .record(z.string(), z.unknown())
    .describe('The arguments the query ran with, defaults filled in.'),
  results: z.array(z.unknown()),
  truncated: z.boolean(),
  totalEstimated: z.number().optional(),
  durationMs: z.number(),
  summary: z
    .record(z.string(), z.number())
    .optional()
    .describe(
      "Histogram over the query's natural buckets; caveats.summaryBasis says whether it covers all rows or only the shown ones.",
    ),
  caveats: z
    .looseObject({
      scan: z.string(),
      searched: z.array(z.string()),
      invisibleSurfaces: z.array(z.string()),
      corpus: z.looseObject({
        fileCount: z.number(),
        tsconfigPath: z.string(),
        testFilesExcluded: z.boolean(),
        scope: z.string().optional(),
      }),
      summaryBasis: z.enum(['all-rows', 'shown-rows']),
      narrowing: z.array(z.string()).optional(),
    })
    .optional()
    .describe(
      'Why a zero-row answer might be zero — read before treating absence of rows as absence of sites.',
    ),
  error: z
    .object({
      kind: z.string(),
      message: z.string(),
      hint: z.string().optional(),
    })
    .optional()
    .describe(
      'Structured error when the query could not be executed; the result is also flagged isError.',
    ),
  meta: STALENESS_META,
});

/** Output schema for the `corpus_info` tool. */
export const CORPUS_INFO_OUTPUT = z.looseObject({
  fileCount: z.number(),
  tsconfigPath: z.string(),
  meta: STALENESS_META,
});

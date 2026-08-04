/**
 * The uniform response envelope: caveats, bucket histogram, and truncation
 * narrowing, for every query in the catalogue.
 *
 * schema-coverage already shipped this contract (scan statement, invisible
 * surfaces, a verdict histogram); every other query returned rows and nothing
 * else. That asymmetry made a zero-row answer uninterpretable — "no sites
 * exist", "no sites in the shapes I search" and "your target is not in my
 * corpus" were the same payload — so it is generalised here and attached in
 * dispatch.ts, which both the CLI and the MCP server route through.
 *
 * `QUERY_CAVEATS` is an exhaustive `Record<QueryName, …>`: adding a query to
 * QUERY_NAMES without describing what it searches is a compile error, not a
 * silently envelope-less query. That is the same structural-parity argument
 * dispatch.ts makes for the CLI/MCP catalogue.
 */

import { relative } from 'node:path';
import type { Project } from 'ts-morph';
import type { QueryName } from './dispatch';
import { lookupTableColumn } from './schema';
import type { CorpusSummary, QueryCaveats } from './types';

/**
 * One narrowing lever, named on both surfaces: a truncated response tells the
 * caller what to do next, and the caller may be driving the CLI or the MCP
 * tool. Only levers the query ACTUALLY honours belong here — advertising an
 * inert flag would be a worse failure than saying nothing.
 */
interface FilterHint {
  /** CLI flag, e.g. '--kind'. */
  flag: string;
  /** MCP / library argument key, e.g. 'kind'. */
  arg: string;
  /** Value placeholder shown after the flag. */
  value?: string;
  /** What it narrows. */
  effect: string;
}

export interface CaveatSpec {
  /** What evidence this answer rests on, in one sentence. */
  scan: string;
  /** The AST shapes / node kinds the query matches on. */
  searched: string[];
  /** Surfaces the scan structurally cannot see, whatever the row count. */
  invisibleSurfaces: string[];
  /** Narrowing levers offered when the response truncates. */
  filters: FilterHint[];
  /** The row field this query histograms on, if it has natural buckets. */
  bucketKey?: string;
  /**
   * The query addresses the database schema by `table` + `column`, so its
   * caveats must disclose whether those arguments were validated against the
   * generated types. Without that line a zero-row answer cannot be told apart
   * from a typo (G3).
   */
  schemaAddressed?: boolean;
}

const CORPUS_BLIND =
  'files outside the tsconfig corpus (node_modules, generated output, other packages)';

const LIMIT_FILTER: FilterHint = {
  flag: '--limit',
  arg: 'limit',
  value: 'N',
  effect: 'raise the row cap',
};

const SCOPE_FILTER: FilterHint = {
  flag: '--scope',
  arg: 'scope',
  value: "'lib/**,app/**'",
  effect: 'restrict the walk to files matching comma-separated globs',
};

const EXCLUDE_TESTS_FILTER: FilterHint = {
  flag: '--exclude-tests',
  arg: 'excludeTests',
  effect: 'drop test files from the walk',
};

const SUPABASE_BLIND = [
  'raw SQL and RPC function bodies',
  'PostgREST and other non-TypeScript consumers of the same table',
  'dynamic `.from(<expr>)` sites whose argument does not resolve one hop to a string literal',
  'column names assembled at runtime (concatenation, template substitution, variable keys)',
];

export const QUERY_CAVEATS: Record<QueryName, CaveatSpec> = {
  callers: {
    scan: 'Call sites are type-checker references to the resolved declaration that sit in callee position; nothing is matched by name.',
    searched: [
      'CallExpression whose callee resolves to the symbol',
      'NewExpression (`new Symbol()`)',
      'calls through property-access chains and non-null assertions (`a.b.sym()`, `sym!()`)',
    ],
    invisibleSurfaces: [
      'dynamic dispatch through a computed key (`table[name]()`)',
      'calls through `any`-typed or structurally-typed values the checker cannot resolve',
      'runtime wiring that never names the symbol (DI containers, JSON/route config)',
      CORPUS_BLIND,
    ],
    filters: [SCOPE_FILTER, LIMIT_FILTER],
    bucketKey: 'resolution',
  },
  callees: {
    scan: "Calls made inside the resolved symbol's own body, resolved through the type checker to their declarations.",
    searched: [
      'CallExpression / NewExpression / super() / this.method() inside the body',
      'nested closures within the body (callbacks, IIFEs)',
    ],
    invisibleSurfaces: [
      'callees reached through a computed property (`obj[k]()`)',
      'functions passed in as arguments and invoked indirectly',
      'declarations outside the corpus, unless `includeExternal` is set (they are counted in `externalCount`)',
      CORPUS_BLIND,
    ],
    filters: [
      {
        flag: '--include-external',
        arg: 'includeExternal',
        effect:
          'include (rather than only count) callees declared outside the corpus',
      },
      LIMIT_FILTER,
    ],
    bucketKey: 'callKind',
  },
  importers: {
    scan: 'Import and re-export declarations whose module specifier resolves to the target module file.',
    searched: [
      'ImportDeclaration (named, default, namespace, type-only)',
      "ExportDeclaration re-exporting from the module (`export … from '…'`)",
    ],
    invisibleSurfaces: [
      'dynamic `import()` with a computed specifier',
      'CommonJS `require()` in untyped files',
      'module aliases that resolve outside the corpus',
      CORPUS_BLIND,
    ],
    filters: [LIMIT_FILTER],
    bucketKey: 'importStyle',
  },
  references: {
    scan: 'Every type-checker reference to the resolved declaration, classified by syntactic position.',
    searched: [
      'value reads and writes',
      'type positions (annotations, generics, `typeof` queries)',
      'JSX component tags',
      're-export specifiers',
      'type-only imports',
    ],
    invisibleSurfaces: [
      'string literals that merely spell the name (use string-literal-uses)',
      'dynamic property access resolved at runtime',
      CORPUS_BLIND,
    ],
    filters: [
      {
        flag: '--kind',
        arg: 'kind',
        value: 'read|write|typeReference|jsxComponent|reexport|typeOnly',
        effect: 'restrict to one reference kind',
      },
      SCOPE_FILTER,
      LIMIT_FILTER,
    ],
    bucketKey: 'kind',
  },
  'column-reads': {
    scan: "Read and filter sites on Supabase query chains rooted at `.from('<table>')`, plus `.rpc()` payload keys. No SQL is parsed.",
    searched: [
      ".select('…') column lists, including colon aliases and nested relation blocks",
      ".select('*') — reported as a wildcard-confidence row, never as proof the column is read",
      '.eq() and the filter methods (neq, gt, gte, lt, lte, like, ilike, is, in, contains, containedBy, overlaps, textSearch)',
      '.order() sort keys',
      '.match({ column: value }) object filters',
      ".rpc('fn', { column: value }) payload keys",
    ],
    invisibleSurfaces: SUPABASE_BLIND,
    filters: [EXCLUDE_TESTS_FILTER, LIMIT_FILTER],
    bucketKey: 'method',
    schemaAddressed: true,
  },
  'column-writes': {
    scan: "Mutation payloads on Supabase query chains rooted at `.from('<table>')`. No SQL is parsed.",
    searched: [
      '.insert(obj | obj[]) payload keys',
      '.update(obj) payload keys',
      '.upsert(obj | obj[]) payload keys',
      '.match(obj) filter keys (a column reference, not a mutation)',
      'one-hop resolution of an identifier payload to a local object literal',
    ],
    invisibleSurfaces: [
      ...SUPABASE_BLIND,
      "`.rpc()` payload writes — declared in the method union but not yet detected, so an RPC-only write surface reports as zero rows here (use schema-coverage's merged evidence for the wider picture)",
      'spread-carried keys are reported as indirect rows: present-or-absent cannot be decided statically',
    ],
    filters: [EXCLUDE_TESTS_FILTER, LIMIT_FILTER],
    bucketKey: 'method',
    schemaAddressed: true,
  },
  'type-evolution': {
    scan: 'Sites where the named property of the named type is referenced, in both type and value position.',
    searched: [
      'parameter and variable type annotations',
      'return-type annotations',
      'generic type arguments',
      '`satisfies` clauses',
      'runtime property access on a value typed as the target',
      'destructuring patterns off a value typed as the target',
    ],
    invisibleSurfaces: [
      'property access through `any`, index signatures, or a widened supertype',
      'structural duck-typing that never names the type',
      CORPUS_BLIND,
    ],
    filters: [
      {
        flag: '--file',
        arg: 'file',
        value: '<relative-path>',
        effect: 'pin which declaration of the type is meant',
      },
      EXCLUDE_TESTS_FILTER,
      LIMIT_FILTER,
    ],
    bucketKey: 'kind',
  },
  'dead-exports': {
    scan: 'Exported declarations with zero non-self importers, counted through the type checker plus one hop of barrel re-export.',
    searched: [
      'named, default, and `export … from` declarations',
      'importer counts via type-checker references',
      'one barrel hop (a re-export chain longer than one hop is NOT followed)',
    ],
    invisibleSurfaces: [
      'consumers outside the corpus (other packages, generated code, runtime plugin loaders)',
      'dynamic `import()` and string-keyed registries',
      're-export chains deeper than one barrel hop',
      'entry points consumed by tooling rather than by TypeScript imports',
    ],
    filters: [
      {
        flag: '--symbol',
        arg: 'symbol',
        value: '<name>',
        effect: 'check a single export instead of the whole corpus',
      },
      EXCLUDE_TESTS_FILTER,
      LIMIT_FILTER,
    ],
    bucketKey: 'exportKind',
  },
  'reexport-chain': {
    scan: 'The declaration site, every barrel that re-exports the symbol, and the consumers that import it.',
    searched: [
      'the original declaration',
      "`export { X } from '…'` and `export * from '…'` barrels",
      'importers, with their distance in barrel hops from the declaration',
    ],
    invisibleSurfaces: [
      'dynamic re-export patterns built at runtime',
      'renames that break the symbol-name match',
      CORPUS_BLIND,
    ],
    filters: [
      {
        flag: '--from',
        arg: 'from',
        value: '<file>',
        effect: 'pin the declaring file when the name is ambiguous',
      },
      EXCLUDE_TESTS_FILTER,
      LIMIT_FILTER,
    ],
    bucketKey: 'kind',
  },
  'enum-uses': {
    scan: 'Declaration, member-access, and type-position sites of the named TypeScript enum.',
    searched: [
      'the enum declaration and its member declarations',
      '`EnumName.MEMBER` property access',
      'the enum name in type position (annotations, generics, `satisfies`, alias RHS)',
    ],
    invisibleSurfaces: [
      'string-literal unions used in place of the enum',
      'the enum VALUE appearing as a bare literal (use string-literal-uses)',
      'computed member access (`Enum[key]`)',
      CORPUS_BLIND,
    ],
    filters: [
      {
        flag: '--member',
        arg: 'member',
        value: '<MemberName>',
        effect: 'restrict member-access rows to one member',
      },
      LIMIT_FILTER,
    ],
    bucketKey: 'kind',
  },
  'string-literal-uses': {
    scan: 'Exact string-literal occurrences of the value, classified by call-site context.',
    searched: [
      'vi.mock() first arguments',
      'JSX attribute values',
      'sql`` tagged-template contents',
      "process.env['KEY'] bracket keys",
      'generic call-expression string arguments',
    ],
    invisibleSurfaces: [
      'values built by concatenation or by a template with substitutions',
      'the value reaching the site through a variable or constant',
      'occurrences in non-TypeScript files (use fixture-uses)',
      CORPUS_BLIND,
    ],
    filters: [LIMIT_FILTER],
    bucketKey: 'kind',
  },
  'fixture-uses': {
    scan: 'Heuristic text search over JSON, YAML front-matter, and TypeScript data files — every row is indirect confidence by construction.',
    searched: [
      'JSON object keys and string values',
      'YAML mapping keys and string values in Markdown front-matter',
      'TypeScript object-literal and type-literal property names',
      'TypeScript string and template literals',
    ],
    invisibleSurfaces: [
      'binary and non-routed file types (only json / ts / md front-matter are read)',
      'values assembled at runtime',
      'files outside the scanned scope',
    ],
    filters: [
      {
        flag: '--kinds',
        arg: 'kinds',
        value: 'key,value',
        effect: 'restrict to field-name or data occurrences',
      },
      SCOPE_FILTER,
      LIMIT_FILTER,
    ],
    bucketKey: 'kind',
  },
  'flow-trace': {
    scan: 'A depth-first walk of value flow from one origin declaration; rows are ordered hops, not a coverage set.',
    searched: [
      'assignment, destructuring, argument, return, spread, and mutation hops',
      'API-call and external-write sinks',
      'synthetic cycle and depth cutoffs (reported as rows, never dropped)',
    ],
    invisibleSurfaces: [
      'flow through the heap (objects mutated elsewhere, module-level mutable state)',
      'cross-function flow, unless `interFunction` is set',
      'anything beyond `maxDepth` — reported as a depthCutoff hop rather than silence',
      CORPUS_BLIND,
    ],
    filters: [
      {
        flag: '--max-depth',
        arg: 'maxDepth',
        value: 'N',
        effect: 'shorten or lengthen each branch (1–20)',
      },
      {
        flag: '--inter-function',
        arg: 'interFunction',
        effect:
          'follow argument hops into the callee (widens, does not narrow)',
      },
      EXCLUDE_TESTS_FILTER,
      LIMIT_FILTER,
    ],
    bucketKey: 'kind',
  },
  'type-drift-detect': {
    scan: 'Response-shaped interfaces joined to the fetcher generics and route return annotations that should agree on them.',
    searched: [
      'interface and type-alias declarations matching the response-name patterns',
      'fetchJson / mutationFetchJson generic arguments',
      'route-handler return-type annotations',
      'routes that import an interface without annotating with it',
    ],
    invisibleSurfaces: [
      'fetchers that do not go through the known wrappers',
      'response shapes declared inline rather than as a named interface',
      'URL matching that depends on runtime values',
    ],
    filters: [
      {
        flag: '--interface-pattern',
        arg: 'interfacePattern',
        value: '<regex>',
        effect: 'additively widen which names count as response interfaces',
      },
      SCOPE_FILTER,
      LIMIT_FILTER,
    ],
    bucketKey: 'classification',
  },
  'schema-coverage': {
    scan: 'Per-column wiring verdicts from TypeScript query-chain evidence. (This query builds its own richer caveats; the shared block only supplies corpus and shape context.)',
    searched: [
      "every `.from()` chain in scope, joined to Database['public']['Tables']",
      'read sites (select / filters / order / match) and mutation payloads',
      'dynamic `.from()` arguments bounded by their type, as table-scoped smoke',
      'merged external evidence sidecars, when supplied',
    ],
    invisibleSurfaces: [
      'RPC function bodies (SQL)',
      'api-schema views',
      'external PostgREST consumers',
      'the Python pipeline, unless its evidence sidecar is merged',
    ],
    filters: [
      {
        flag: '--table',
        arg: 'table',
        value: '<table-name>',
        effect: 'scope the report to one table',
      },
      SCOPE_FILTER,
      LIMIT_FILTER,
    ],
    bucketKey: 'verdict',
  },
};

/**
 * Describe the corpus the answer was computed over. `fileCount` is the live
 * ts-morph file count, so a warm MCP server reports the corpus as it stands
 * at THIS call, not as it stood at process start.
 */
export function corpusSummary(
  project: Project,
  repoRoot: string,
  args: Record<string, unknown>,
): CorpusSummary {
  const configPath = project.getCompilerOptions().configFilePath;
  const tsconfigPath =
    typeof configPath === 'string'
      ? relative(repoRoot, configPath).split('\\').join('/') || configPath
      : 'tsconfig.json (unresolved — project was not built from a tsconfig)';

  return {
    fileCount: project.getSourceFiles().length,
    tsconfigPath,
    testFilesExcluded: args.excludeTests === true,
    ...(typeof args.scope === 'string' && args.scope
      ? { scope: args.scope }
      : {}),
  };
}

/** Histogram of a row set over the query's natural bucket field. */
export function bucketHistogram(
  rows: readonly unknown[],
  bucketKey: string | undefined,
): Record<string, number> | undefined {
  if (!bucketKey) return undefined;
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const value = (row as Record<string, unknown>)[bucketKey];
    if (typeof value !== 'string') continue;
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

/** Render one filter as a line a caller can act on directly. */
function renderFilter(hint: FilterHint, applied: boolean): string {
  const cli = hint.value ? `${hint.flag} ${hint.value}` : hint.flag;
  const state = applied ? ' — already applied; tighten it further' : '';
  return `${cli}  (arg: ${hint.arg}) — ${hint.effect}${state}`;
}

/**
 * The narrowing block (G10): a truncated response must say what to do next.
 * Only filters this query honours are listed, and the current cap is named so
 * "raise the limit" is an instruction rather than a suggestion.
 */
export function narrowingFor(
  spec: CaveatSpec,
  args: Record<string, unknown>,
  shown: number,
  totalEstimated: number | undefined,
): string[] {
  const total = totalEstimated ?? shown;
  const limit = typeof args.limit === 'number' ? args.limit : shown;
  const lines = [
    `Showing ${shown} of ${total} rows. Rows are dropped by spatial-coverage truncation: distinct files are kept first, and the extra hits of heavily-hit files are thinned last — so the file LIST is close to complete while per-file depth is not.`,
    'Narrow with any of:',
  ];
  for (const hint of spec.filters) {
    if (hint === LIMIT_FILTER) continue;
    lines.push(`  ${renderFilter(hint, args[hint.arg] !== undefined)}`);
  }
  // Suggest the cap that would show everything, unless that is absurdly large
  // for a terminal — then suggest a step up instead of a number nobody runs.
  const suggested = Math.min(total, Math.max(limit * 5, 1000));
  lines.push(
    `  --limit ${suggested}  (arg: limit) — raise the cap; it is currently ${limit} and ${total} rows matched.`,
  );
  return lines;
}

/** The response fields the envelope owns. */
export interface Envelope {
  caveats: QueryCaveats;
  summary?: Record<string, number>;
}

/**
 * Build the shared envelope for one response.
 *
 * `summaryBasis` is honest about truncation: the histogram is computed over
 * the rows the response actually carries, so when rows were dropped it
 * describes the shown rows only and says so, rather than implying it covers
 * the full match set.
 */
export function buildEnvelope(
  query: QueryName,
  args: Record<string, unknown>,
  rows: readonly unknown[],
  truncated: boolean,
  totalEstimated: number | undefined,
  project: Project,
  repoRoot: string,
): Envelope {
  const spec = QUERY_CAVEATS[query];
  const caveats: QueryCaveats = {
    scan: spec.scan,
    searched: spec.searched,
    invisibleSurfaces: spec.invisibleSurfaces,
    corpus: corpusSummary(project, repoRoot, args),
    summaryBasis: truncated ? 'shown-rows' : 'all-rows',
    ...(truncated
      ? { narrowing: narrowingFor(spec, args, rows.length, totalEstimated) }
      : {}),
    // Disclosed for schema-addressed queries whatever the row count: the
    // caller cannot read a zero without knowing whether the table and column
    // were checked to exist. The lookup is cached, so the query's own
    // validation call and this one share a single parse.
    ...(spec.schemaAddressed &&
    typeof args.table === 'string' &&
    typeof args.column === 'string'
      ? {
          schemaValidation: lookupTableColumn(repoRoot, args.table, args.column)
            .validation,
        }
      : {}),
  };
  const summary = bucketHistogram(rows, spec.bucketKey);
  return { caveats, ...(summary ? { summary } : {}) };
}

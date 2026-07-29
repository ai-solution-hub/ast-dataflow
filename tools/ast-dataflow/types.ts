export type Confidence = 'exact' | 'wildcard' | 'indirect';

export type CallResolution =
  | 'direct'
  | 'reexport'
  | 'aliased'
  | 'destructured'
  | 'computed-property'
  | 'indirect';

export interface BaseResult {
  file: string;
  line: number;
  column: number;
  confidence: Confidence;
}

export interface CallSiteResult extends BaseResult {
  enclosing: string;
  resolution: CallResolution;
  importAlias?: string;
}

/**
 * Structured error kinds (PRODUCT.md invariant 29).
 *
 * - unknown_file    — the file path supplied to a symbol query is not in the
 *                     ts-morph project (not in tsconfig.json's file set), or
 *                     (schema-coverage) an --evidence sidecar is unreadable.
 * - parse_error     — the input is syntactically malformed (e.g. symbol string
 *                     with no colon separator, empty required argument).
 * - ambiguous_symbol — the symbol name resolves to more than one distinct
 *                     declaration after de-duplication; the caller must
 *                     supply a more specific path.
 * - out_of_corpus   — the file is in the project but the named symbol is not
 *                     exported or declared there.
 * - ORIGIN_NOT_RESOLVABLE — flow-trace: no AST node at the given (file, line,
 *                     column), or the resolved node is not a
 *                     VariableDeclaration, ParameterDeclaration, or
 *                     BindingElement.
 * - ORIGIN_NOT_VALUE_PRODUCING — flow-trace: the resolved node is a valid
 *                     declaration kind but has no value (e.g. a type-only alias).
 * - not_callable    — callees: the resolved symbol has no callable body
 *                     (interface, plain const, type alias, or a bodyless
 *                     overload/ambient signature).
 * - unknown_table   — schema-coverage: args.table is not a table in
 *                     Database['public']['Tables'] (kills the silent-0/0
 *                     dropped-table failure mode).
 * - unknown_column  — schema-coverage: args.column is not a Row column of the
 *                     given table.
 */
export type ErrorKind =
  | 'unknown_file'
  | 'parse_error'
  | 'ambiguous_symbol'
  | 'out_of_corpus'
  | 'not_callable'
  | 'unknown_table'
  | 'unknown_column'
  | 'ORIGIN_NOT_RESOLVABLE'
  | 'ORIGIN_NOT_VALUE_PRODUCING'
  | 'no-fetchers-found';

export interface QueryResponse<R extends BaseResult> {
  query: string;
  args: Record<string, unknown>;
  results: R[];
  truncated: boolean;
  totalEstimated?: number;
  durationMs: number;
  /** Present when the query cannot be executed due to a structured error. */
  error?: {
    kind: ErrorKind;
    message: string;
    hint?: string;
  };
}

export interface CallersArgs {
  symbol: string;
  limit?: number;
  scope?: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// callees query (PRODUCT.md invariant 2)
// ──────────────────────────────────────────────────────────────────────────────

/** How the call is spelled at the call site. */
export type CalleeCallKind = 'call' | 'new' | 'super' | 'thisMethod';

export interface CalleesArgs {
  /** '<file>:<name>' — same shape as callers. */
  symbol: string;
  /** Max result rows; default 200. */
  limit?: number;
  /**
   * When true, callees whose declaration resolves outside the tsconfig corpus
   * (node_modules / lib.d.ts) are emitted as rows with `external: true` and
   * null callee positions. Default false: external callees are excluded from
   * rows and only counted in the response-level `externalCount`.
   */
  includeExternal?: boolean;
}

/** BaseResult position = the CALL SITE (inside the subject's body). */
export interface CalleeResult extends BaseResult {
  /** findEnclosing(callExpr) — names the nested closure host. */
  enclosing: string;
  /**
   * Rightmost identifier ('c' for a.b.c()), '<computed>' for obj[k](),
   * '<anonymous>' for IIFEs.
   */
  calleeName: string;
  callKind: CalleeCallKind;
  /**
   * The call mechanism (reexport unused here). `confidence` is 'exact'
   * whenever the checker resolved a declaration — even for 'indirect'
   * resolution, where the variable/parameter declaration is exactly
   * resolved — and 'indirect' only when no symbol resolves at all.
   */
  resolution: CallResolution;
  /** Present when resolution === 'aliased'. */
  importAlias?: string;
  /** Declared-side context. Null file/line when unresolved or external. */
  callee: { file: string | null; line: number | null };
  /** Declaration resolves outside the tsconfig corpus (node_modules / lib.d.ts). */
  external?: true;
}

/**
 * Response envelope for callees. `externalCount` reports call sites whose
 * callee declaration resolves outside the corpus, so nothing is silently
 * invisible when external rows are excluded (the default).
 */
export interface CalleesResponse extends QueryResponse<CalleeResult> {
  externalCount: number;
}

export interface ImportersArgs {
  modulePath: string; // '@/lib/ai/change-reports' or 'lib/ai/change-reports.ts'
  limit?: number; // default 200
}

export type ImportStyle =
  | 'named'
  | 'default'
  | 'namespace'
  | 'typeOnly'
  | 'reexport';

export type ReferenceKind =
  | 'typeReference'
  | 'jsxComponent'
  | 'read'
  | 'write'
  | 'reexport'
  | 'typeOnly';

export interface ReferencesArgs {
  symbol: string;
  limit?: number;
  kind?: ReferenceKind;
}

export interface ReferenceResult extends BaseResult {
  confidence: 'exact';
  kind: ReferenceKind;
  enclosing: string;
  isDefinition: boolean;
}

export interface ImporterResult extends BaseResult {
  confidence: 'exact';
  namedImports: string[];
  importStyle: ImportStyle;
  isReexportOnly: boolean;
  unused: boolean;
}

export interface ColumnReadsArgs {
  table: string;
  column: string;
  limit?: number;
  excludeTests?: boolean;
}

/**
 * - select      — `.select('…col…')` or `.select('*')` (wildcard confidence).
 * - eq          — `.eq('col', v)` equality filter (kept as a dedicated value
 *                 for backwards compatibility).
 * - filter      — any other filter method naming the column as its first
 *                 string argument (`.neq/.gt/.gte/.lt/.lte/.like/.ilike/.is/
 *                 .in/.contains/.containedBy/.overlaps/.textSearch`); the
 *                 concrete method is reported in `chainMethod`.
 * - order       — `.order('col')` sort key.
 * - match       — `.match({ col: v })` object filter.
 * - rpc-payload — `.rpc('fn', { col: v })` payload key.
 */
export type ColumnReadMethod =
  | 'select'
  | 'eq'
  | 'filter'
  | 'order'
  | 'match'
  | 'rpc-payload';

export interface ColumnReadResult extends BaseResult {
  method: ColumnReadMethod;
  columnPath: string; // the matched column literal or object key
  table: string; // echo of the table arg
  isTyped: boolean; // true if the Supabase client is type-instantiated with a row type
  /** For method 'filter': the concrete chain method (e.g. 'in', 'gte'). */
  chainMethod?: string;
}

export interface ColumnWritesArgs {
  table: string;
  column: string;
  limit?: number;
  excludeTests?: boolean;
}

/**
 * The write methods that column-writes detects.
 *
 * - insert       — `.insert(obj | obj[])` — row creation.
 * - update       — `.update(obj)` — partial or full row update.
 * - upsert       — `.upsert(obj | obj[])` — insert-or-update.
 * - match        — `.match(obj)` — WHERE-clause filter; treated as a column
 *                  reference site since it names a column to match on.
 * - rpc-payload  — `.rpc('fn', { col: x })` payload key. Union member is
 *                  declared per PRODUCT.md invariant 6; detection is deferred
 *                  to a follow-up (S5+) — no production RPC payloads in the KH
 *                  corpus name `bid_questions.project_id`, so the false-negative
 *                  surface is empty today.
 */
export type ColumnWriteMethod =
  | 'insert'
  | 'update'
  | 'upsert'
  | 'match'
  | 'rpc-payload';

export interface ColumnWriteResult extends BaseResult {
  method: ColumnWriteMethod;
  columnPath: string; // the matched object property key
  table: string; // echo of the table arg
  isTyped: boolean; // true if the Supabase client is type-instantiated
}

/**
 * Arguments for the dead-exports query (PRODUCT.md inv. 9).
 *
 * - scope          — optional glob or directory to restrict the search.
 *                    When omitted, the full ts-morph project is scanned.
 * - excludeTests   — when true, exports whose ONLY importers are test files
 *                    are treated as unused (mirrors column-reads behaviour).
 * - symbol         — check a single named export (one-off mode).
 * - symbolsFile    — path to a file listing one symbol name per line (batch
 *                    mode for piping Knip output into dead-exports).
 * - limit          — max result rows; default 200.
 */
export interface DeadExportsArgs {
  scope?: string;
  excludeTests?: boolean;
  symbol?: string;
  symbolsFile?: string;
  limit?: number;
}

/**
 * One result row for the dead-exports query (OQ-R2: per-row JSONL, Shape A).
 *
 * - symbol               — the exported name.
 * - exportKind           — how it is exported (named, default, reexport-from).
 * - reachableImporters   — count of non-self, non-same-file importers in the
 *                          production corpus (test files counted separately;
 *                          see testOnlyImporters).
 * - testOnlyImporters    — count of importers that are test files only.
 * - testOnly             — true when reachableImporters === 0 and
 *                          testOnlyImporters > 0: exported but only consumed
 *                          by tests — not a "real" dead export if tests count.
 * - barrelChain          — when the barrel walker finds a re-export path, the
 *                          chain of intermediate barrel files that carry the
 *                          symbol. Non-empty means Knip may have missed a real
 *                          consumer via barrel hops.
 * - confidence           — always 'exact' for dead-exports (ts-morph resolver
 *                          is used directly, not heuristic matching).
 */
export type DeadExportKind = 'named' | 'default' | 'reexport-from';

export interface DeadExportResult extends BaseResult {
  confidence: 'exact';
  symbol: string;
  exportKind: DeadExportKind;
  reachableImporters: number;
  testOnlyImporters: number;
  testOnly: boolean;
  barrelChain: string[];
}

// ──────────────────────────────────────────────────────────────────────────────
// type-evolution query (PRODUCT.md invariant 7, R-WP3)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * The six kinds of reference site that type-evolution reports:
 *
 * - annotation     — the type appears as a parameter type annotation.
 *                    `function f(x: TargetType)`
 * - returnType     — the type appears as a function return type annotation.
 *                    `function f(): TargetType`
 * - generic        — the type appears as a generic type argument.
 *                    `Array<TargetType>`, `Promise<TargetType>`
 * - satisfies      — the type appears in a `satisfies` clause.
 *                    `const x = { … } satisfies TargetType`
 * - propertyAccess — a runtime access `obj.property` where `obj` is typed as T.
 * - destructuring  — a destructuring pattern `const { property } = obj` where
 *                    `obj` is typed as T.
 */
export type TypeEvolutionKind =
  | 'annotation'
  | 'returnType'
  | 'generic'
  | 'satisfies'
  | 'propertyAccess'
  | 'destructuring';

export interface TypeEvolutionArgs {
  /** The TypeScript type / interface name to probe. E.g. `'ProcurementQuestion'`. */
  type: string;
  /** The property name to probe within that type. E.g. `'project_id'`. */
  property: string;
  /**
   * Optional repo-root-relative file path where the type is declared.
   * When omitted, the query searches all source files for an exported
   * declaration matching `type`.
   */
  file?: string;
  limit?: number;
  excludeTests?: boolean;
}

export interface TypeEvolutionResult extends BaseResult {
  confidence: 'exact';
  kind: TypeEvolutionKind;
  /** True when the reference exists only in the type system (no runtime access). */
  isTypeOnly: boolean;
  /** Nearest enclosing function/method/class name via findEnclosing. */
  enclosing: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// reexport-chain query (PRODUCT.md invariant 8, R-WP2)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * The three kinds of row returned by reexport-chain:
 *
 * - declaration — the file where the symbol is originally declared.
 *                 distance is always 0; throughBarrel is always null.
 * - reexport    — a barrel file that re-exports the symbol. distance
 *                 increases by 1 per hop. throughBarrel equals the file
 *                 itself (the barrel performing the re-export).
 * - importer    — a real consumer that imports the symbol (directly or
 *                 via a barrel). distance reflects the number of barrel
 *                 hops between declaration and this consumer.
 *                 throughBarrel is null.
 */
export type ReexportChainKind = 'declaration' | 'reexport' | 'importer';

/**
 * Arguments for the reexport-chain query (PRODUCT.md inv. 8).
 *
 * - symbol        — the exported symbol name to trace.
 * - from          — optional repo-root-relative file path that declares
 *                   the symbol. When omitted the query searches all source
 *                   files for an exported declaration matching `symbol`.
 * - excludeTests  — when true, test-file importers are excluded from the
 *                   importer rows (mirrors dead-exports / column-reads
 *                   behaviour).
 * - limit         — max result rows; default 200.
 */
export interface ReexportChainArgs {
  symbol: string;
  from?: string;
  excludeTests?: boolean;
  limit?: number;
}

/**
 * One result row for the reexport-chain query.
 *
 * - file          — repo-relative POSIX path.
 * - line, column  — 1-based position of the declaration/re-export/import.
 * - kind          — 'declaration' | 'reexport' | 'importer'
 * - symbolName    — the original symbol name as declared in the source file.
 *                   Preserved across renames (e.g. `export { foo as bar }`
 *                   still reports symbolName='foo').
 * - throughBarrel — for reexport rows: the barrel file performing the
 *                   re-export. null for declaration and importer rows.
 * - distance      — 0 at the declaration; +1 per barrel hop. Importers
 *                   carry the cumulative distance from the declaration.
 * - confidence    — always 'exact' (ts-morph resolver is used directly).
 */
export interface ReexportChainResult extends BaseResult {
  confidence: 'exact';
  kind: ReexportChainKind;
  symbolName: string;
  throughBarrel: string | null;
  distance: number;
}

// --- enum-uses ---

/**
 * Arguments for the enum-uses query (PRODUCT.md inv. 11, R-WP5).
 *
 * - enum    — the TypeScript enum name to probe. E.g. `'OrderStatus'`.
 * - member  — optional member name to filter results. E.g. `'PENDING'`.
 *             When supplied, memberAccess rows are filtered to that member only;
 *             declaration/typePosition rows for irrelevant members are dropped.
 *             The enum-level declaration row is always included.
 * - limit   — max result rows; default 200.
 */
export interface EnumUsesArgs {
  enum: string;
  member?: string;
  limit?: number;
}

/**
 * The three kinds of row returned by enum-uses:
 *
 * - declaration  — the site where the enum or one of its members is declared.
 * - memberAccess — a PropertyAccessExpression `EnumName.MEMBER` at a call site.
 * - typePosition — the enum name appears in a type-annotation position
 *                  (parameter type, return type, generic argument, satisfies clause,
 *                  variable annotation, type alias RHS).
 */
export type EnumUseKind = 'declaration' | 'memberAccess' | 'typePosition';

/**
 * One result row for the enum-uses query.
 *
 * - file       — repo-relative POSIX path.
 * - line       — 1-based line number.
 * - column     — 1-based column number.
 * - kind       — 'declaration' | 'memberAccess' | 'typePosition'
 * - memberName — for declaration rows: the enum member name (or null for the
 *                enum-level declaration itself). For memberAccess rows: the
 *                accessed member name. For typePosition rows: null (the whole
 *                enum is referenced as a type, not a specific member).
 * - enclosing  — nearest enclosing named function/method/module scope via
 *                findEnclosing.
 * - confidence — always 'exact' (ts-morph resolver is used directly).
 */
export interface EnumUseResult extends BaseResult {
  confidence: 'exact';
  kind: EnumUseKind;
  memberName: string | null;
  enclosing: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// string-literal-uses query (PRODUCT.md invariant 10, R-WP4)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * The five call-site context kinds that string-literal-uses classifies.
 *
 * - viMock    — the string is the first argument to vi.mock(...)
 *               (the path Vitest will stub at module resolution time).
 * - jsxProp   — the string is the value of a JSX attribute.
 *               e.g. `<a href="/page" />`, `<img src="..." />`
 * - sqlTag    — the string is the content of a sql`` tagged template literal.
 *               e.g. `sql\`SELECT * FROM foo\``
 * - envKey    — the string is the bracket-access key on process.env.
 *               e.g. `process.env['MY_KEY']`
 * - argument  — the string is a generic argument in a CallExpression that
 *               does not match any of the more-specific kinds above.
 */
export type StringLiteralUseKind =
  | 'viMock'
  | 'jsxProp'
  | 'sqlTag'
  | 'envKey'
  | 'argument';

/**
 * Arguments for the string-literal-uses query (PRODUCT.md inv. 10).
 *
 * - value  — the exact string literal value to search for (required).
 *            e.g. '@/lib/foo', 'BID_DRAFT', 'project_id'.
 * - limit  — max result rows; default 200.
 */
export interface StringLiteralUsesArgs {
  value: string;
  limit?: number;
}

/**
 * One result row for the string-literal-uses query.
 *
 * - file      — repo-relative POSIX path.
 * - line      — 1-based line number of the string literal.
 * - column    — 1-based column number of the string literal.
 * - kind      — the call-site context classification.
 * - enclosing — FQN of the nearest enclosing function/method/class via
 *               findEnclosing (e.g. 'fn:myHelper', 'method:MyClass.doThing',
 *               'moduleTopLevel').
 * - confidence — always 'exact' (literal value is matched directly, not
 *                heuristically).
 */
export interface StringLiteralUseResult extends BaseResult {
  confidence: 'exact';
  kind: StringLiteralUseKind;
  enclosing: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// fixture-uses query (PRODUCT.md invariant 11)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * The two kinds of fixture occurrence (PRODUCT.md inv. 11's key/value split):
 *
 * - key   — the needle names a field: a JSON object key, a YAML mapping key,
 *           a TS object-literal / type-literal property name (including the
 *           `database.types.ts` PropertySignature case), or a quoted
 *           property/enum-member name.
 * - value — the needle is data: a JSON/YAML string value or a TS string /
 *           template literal, including string-literal union members in
 *           `database.types.ts` (enum-ish values).
 */
export type FixtureUseKind = 'key' | 'value';

export type FixtureFileType = 'json' | 'ts' | 'md-frontmatter';

/**
 * Arguments for the fixture-uses query (PRODUCT.md inv. 11).
 *
 * - needle — exact string to find (column/table/magic literal).
 * - kinds  — filter; default both.
 * - scope  — optional comma-separated glob override of the default target set
 *            (same extension routing applies; non-json/ts/md files are skipped).
 * - limit  — max result rows; default 200.
 */
export interface FixtureUsesArgs {
  needle: string;
  kinds?: FixtureUseKind[];
  scope?: string;
  limit?: number;
}

export interface FixtureUseResult extends BaseResult {
  /** Inv 15: fixture grep is heuristic — always indirect. */
  confidence: 'indirect';
  /** JSON/YAML/TS object-or-type KEY vs string VALUE (inv 11's split). */
  kind: FixtureUseKind;
  fileType: FixtureFileType;
  /** Where in the structure: JSON path ('rows[2].project_id'), YAML path
   *  ('baseline_values[0].key'), or TS enclosing via findEnclosing. */
  context: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// flow-trace query (ROADMAP R-WP6; see TECH.md §Query implementations → flow-trace)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Hop classification for flow-trace.
 *
 * Real hop kinds (WP1 + WP2):
 * - assignment  — value is bound to a new identifier.
 * - destructure — value is unpacked from an object/array pattern.
 * - argument    — value is passed as a function argument.
 * - return      — value is returned from a function.
 * - spread      — value is spread into an object or array literal.
 * - mutation    — a mutating method is called on the value.
 * - apiCall     — value flows into a known API call (Supabase, fetch, etc.).
 * - write       — value is written to a file or external channel.
 *
 * Synthetic termination kinds (WP3):
 * - cycleCutoff — emitted when the walker detects a visited position.
 * - depthCutoff — emitted when the branch would exceed maxDepth.
 */
export type FlowTraceHopKind =
  | 'assignment'
  | 'destructure'
  | 'argument'
  | 'return'
  | 'spread'
  | 'mutation'
  | 'apiCall'
  | 'write'
  | 'cycleCutoff'
  | 'depthCutoff';

/**
 * Arguments for the flow-trace query.
 */
export interface FlowTraceArgs {
  /** Repo-root-relative path to the file containing the origin node. */
  originFile: string;
  /** 1-based line number of the origin declaration. */
  originLine: number;
  /** 1-based column number of the origin declaration. */
  originColumn: number;
  /**
   * Maximum number of hops per branch.
   * Default: 8. Minimum: 1. Maximum: 20.
   */
  maxDepth?: number;
  /**
   * When true, on an `argument` hop the walk descends into the resolved
   * callee's parameter and continues. Counts against maxDepth.
   * Default: false (intra-function only).
   */
  interFunction?: boolean;
  /** Maximum result rows (cap). Default: 200. */
  limit?: number;
  /** Exclude test files from the walk. Default: false. */
  excludeTests?: boolean;
}

/**
 * One result row for the flow-trace query.
 *
 * - hop         — 1-indexed hop number within the full trace (depth-first pre-order).
 * - parentHop   — hop index of the upstream hop. Absent for hop 1 (origin row).
 * - kind        — hop classification.
 * - file        — repo-root-relative path.
 * - line        — 1-based line of the hop node.
 * - column      — 1-based column of the hop node.
 * - confidence  — resolution confidence of this hop.
 * - enclosing   — nearest enclosing function / method / 'module top-level'.
 * - origin      — the origin declaration (same for every row in the trace).
 */
export interface FlowTraceRow extends BaseResult {
  hop: number;
  parentHop?: number;
  kind: FlowTraceHopKind;
  enclosing: string;
  origin: {
    file: string;
    line: number;
    column: number;
    /** Identifier name at the origin site. */
    symbol: string;
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// type-drift-detect query (PRODUCT.md WP-D, R-WP17)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Arguments for the type-drift-detect query.
 *
 * - scope            — comma-separated glob patterns. Only files matching the
 *                      globs are inspected for fetcher/route call sites; the
 *                      interface declarations in types/ are always scanned.
 *                      When omitted, the default scope applies.
 * - limit            — max result rows; default 500.
 * - interfacePattern — additive regex; names matching this are treated as
 *                      response-interface candidates in addition to the
 *                      default name patterns.
 * - ci               — CI mode: diff against baseline, exit non-zero on new
 *                      fetcher-only rows.
 * - updateBaseline   — write back new fetcher-only rows to the baseline file
 *                      (never combined with --ci).
 * - json             — JSONL output (one row per line). Implied by --ci.
 * - pretty           — human-readable Markdown output (default when no other
 *                      output flag is set).
 */
export interface TypeDriftDetectArgs {
  scope?: string;
  limit?: number;
  interfacePattern?: string;
  ci?: boolean;
  updateBaseline?: boolean;
  json?: boolean;
  pretty?: boolean;
}

/**
 * One result row for the type-drift-detect query (PRODUCT.md WP-D D-11).
 *
 * Extends BaseResult — `file`, `line`, `column`, `confidence` are inherited
 * from the `declaredAt` position.
 */
export interface TypeDriftResult extends BaseResult {
  /** The interface or type-alias name. */
  interface: string;
  /** Primary declaration location (repo-root-relative POSIX path). */
  declaredAt: { file: string; line: number; column: number };
  /** Classification bucket. */
  classification: 'enforced' | 'fetcher-only' | 'route-only' | 'unused';
  /** Fetcher call sites that use this interface as a generic. */
  fetchers: Array<{
    file: string;
    line: number;
    column: number;
    url: string | null;
  }>;
  /** Route handler sites that declare this interface as a return type. */
  routes: Array<{
    file: string;
    line: number;
    column: number;
    confidence: Confidence;
  }>;
  /** Routes that import the interface but do not annotate with it. */
  candidateRoutes: Array<{
    file: string;
    line: number;
    column: number;
    matchReason: 'imported-not-annotated' | 'url-match' | 'naming-convention';
    confidence: Confidence;
  }>;
  /** Minimal change that would flip this row to enforced. */
  remediationHint: string;
  /** True when the interface is referenced only in __tests__/**. */
  testOnly?: boolean;
  /** Populated when the interface is in the allowlist. */
  allowlisted?: { reason: string };
  /** Informational error attached to sentinel rows (e.g. no-fetchers-found). */
  error?: { kind: ErrorKind; confidence: Confidence };
}

// ──────────────────────────────────────────────────────────────────────────────
// schema-coverage query (id-375 {375.8} — the "built-not-wired" audit)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Per-column wiring verdict. Indirect/wildcard evidence NEVER counts as
 * wiring evidence (a nonexistent column collects both — baseline audit §2).
 *
 * - wired       — ≥1 exact read AND ≥1 exact write.
 * - read-only   — exact evidence on the read side only.
 * - write-only  — exact evidence on the write side only.
 * - undecidable — only wildcard/indirect evidence on the column, OR zero
 *                 evidence but the table has smoke (wildcard/indirect rows or
 *                 table-bounded dynamic `.from()` sites) — cannot rule wiring
 *                 in or out statically.
 * - unwired     — zero rows AND zero wildcard/indirect on the column AND zero
 *                 unattributable sites bounded to the table.
 */
export type SchemaCoverageVerdict =
  | 'unwired'
  | 'undecidable'
  | 'write-only'
  | 'read-only'
  | 'wired';

/**
 * Arguments for the schema-coverage query.
 *
 * - table  — scope the report to one table (must exist in the schema, else
 *            error kind 'unknown_table'). Default: the whole schema.
 * - column — scope to one column of `table` (requires `table`; must exist in
 *            the table's Row, else 'unknown_column').
 * - scope  — comma-separated glob patterns restricting which corpus files are
 *            scanned for `.from()` chains (same contract as type-drift-detect
 *            --scope). The schema enumeration is never scoped.
 * - limit  — max result rows; default 2000 (the whole schema fits — rows are
 *            per-column verdicts, so a plain cap applies, not truncateSpatial).
 * - evidence — external evidence sidecar paths (repo-root-relative or
 *            absolute). Their rows merge into the per-column aggregation
 *            before verdicts are issued; `scope` never filters them (they
 *            describe surfaces outside the tsconfig corpus).
 */
export interface SchemaCoverageArgs {
  table?: string;
  column?: string;
  scope?: string;
  limit?: number;
  evidence?: string[];
}

// --- external evidence sidecars (contract v1) ---

/**
 * One column-access row of an evidence sidecar.
 *
 * - table/column — schema coordinates. `column: '*'` is table-scoped: the
 *                  producer knows the table was touched but not which columns.
 * - direction    — 'read' | 'write', the same split the TS scan aggregates.
 * - confidence   — 1:1 with the TS confidence buckets. Ignored for `'*'`
 *                  rows, which are re-graded as table-scoped smoke.
 * - method       — the producer's detector method (e.g. 'declare_row'),
 *                  carried for provenance; verdicts never branch on it.
 * - file/line    — the producing site, rendered as an evidence ref verbatim
 *                  (a `scripts/x.py:12` ref is self-identifying — no prefix).
 * - source       — the detector WITHIN the producing tool (the tool itself is
 *                  the sidecar's top-level `source`).
 */
export interface EvidenceSidecarRow {
  table: string;
  column: string;
  direction: 'read' | 'write';
  confidence: Confidence;
  method: string;
  file: string;
  line: number;
  source: string;
}

/**
 * An evidence sidecar file (schemaVersion 1): rows of column access observed
 * by a producer the TypeScript scan cannot see — first producer the Python
 * pipeline scanner (`source: 'ast-dataflow-py'`). Unknown top-level keys
 * (`caveats`, `sqlglot`, `generatedBy`, …) are tolerated and ignored, so a
 * producer can enrich its output without breaking this consumer.
 */
export interface EvidenceSidecar {
  schemaVersion: 1;
  /** The producing TOOL (row-level `source` names the detector within it). */
  source: string;
  rows: EvidenceSidecarRow[];
}

/** One sidecar that was successfully merged, as reported in the caveats. */
export interface MergedEvidenceSource {
  /** The sidecar's top-level `source` — the producing tool. */
  source: string;
  /** Repo-relative path when the file is under the repo root, else as given. */
  path: string;
  /** Rows read from the file (including rows that landed in the unknown map). */
  rows: number;
}

/**
 * One per-column verdict row. Not a BaseResult — rows are verdicts about
 * schema columns, not source positions, so the envelope uses a plain cap
 * (sorted worst-first) instead of spatial truncation.
 *
 * - exactReads/exactWrites       — wiring evidence (typed client + literal
 *                                  column confirmation).
 * - wildcardReads                — `.select('*')` sites on the table (poison
 *                                  every column; never wiring evidence).
 * - indirectReads/indirectWrites — untyped-client or untraceable-payload
 *                                  rows; never wiring evidence.
 * - unattributableTableSites     — dynamic `.from()` sites whose argument
 *                                  TYPE bounds them to this table (e.g.
 *                                  `.from(fn())` where fn returns a literal
 *                                  or union type). Same value for every
 *                                  column of the table; >0 downgrades
 *                                  zero-evidence columns to 'undecidable'.
 * - evidence                     — top 3 deduped `file:line` refs per
 *                                  direction, exact-confidence refs first.
 */
export interface SchemaCoverageResult {
  table: string;
  column: string;
  verdict: SchemaCoverageVerdict;
  exactReads: number;
  exactWrites: number;
  wildcardReads: number;
  indirectReads: number;
  indirectWrites: number;
  unattributableTableSites: number;
  evidence: {
    reads: string[];
    writes: string[];
  };
}

/**
 * Top-level scan caveats (PRODUCT SQL-opaque disclosure): the verdicts are
 * TS-query-chain evidence only. Static fields — no SQL parsing.
 *
 * `unattributableSites` counts dynamic `.from(<arg>)` sites whose table could
 * not be bounded even by the argument's type (plain-`string`-typed
 * identifiers etc.), keyed by repo-relative file. These are per-file counts,
 * not per-column rows — access through them is invisible to every verdict,
 * so they are reported loudly here instead of silently dropped.
 *
 * When evidence sidecars are merged, `scan` and `invisibleSurfaces` narrow to
 * match (a merged surface is no longer invisible) and two fields appear:
 * `mergedEvidence` (provenance for every sidecar) and `evidenceUnknownTables`
 * (sidecar rows naming a table or column that is not in the enumerated
 * schema, keyed `<sidecar-source>:<table>` / `<sidecar-source>:<table>.<column>`
 * — a producer drifting from the schema reports loudly instead of vanishing).
 * Both are omitted entirely when no sidecar was merged / nothing was unknown.
 */
export interface SchemaCoverageCaveats {
  scan: string;
  invisibleSurfaces: string[];
  unattributableSites: Record<string, number>;
  mergedEvidence?: MergedEvidenceSource[];
  evidenceUnknownTables?: Record<string, number>;
}

/**
 * Response envelope for schema-coverage. Mirrors QueryResponse but rows are
 * per-column verdicts (no BaseResult positions). `summary` is the verdict
 * histogram over ALL rows (computed before the limit cap, so truncation
 * never skews it).
 */
export interface SchemaCoverageResponse {
  query: string;
  args: Record<string, unknown>;
  results: SchemaCoverageResult[];
  truncated: boolean;
  totalEstimated?: number;
  durationMs: number;
  caveats?: SchemaCoverageCaveats;
  summary?: Record<SchemaCoverageVerdict, number>;
  error?: {
    kind: ErrorKind;
    message: string;
    hint?: string;
  };
}

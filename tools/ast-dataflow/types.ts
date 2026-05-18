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
 *                     ts-morph project (not in tsconfig.json's file set).
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
 */
export type ErrorKind =
  | 'unknown_file'
  | 'parse_error'
  | 'ambiguous_symbol'
  | 'out_of_corpus'
  | 'ORIGIN_NOT_RESOLVABLE'
  | 'ORIGIN_NOT_VALUE_PRODUCING';

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

export interface ImportersArgs {
  modulePath: string; // '@/lib/ai/digest' or 'lib/ai/digest.ts'
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

export type ColumnReadMethod = 'select' | 'eq' | 'match' | 'rpc-payload';

export interface ColumnReadResult extends BaseResult {
  method: ColumnReadMethod;
  columnPath: string; // the matched column literal or object key
  table: string; // echo of the table arg
  isTyped: boolean; // true if the Supabase client is type-instantiated with a row type
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
  /** The TypeScript type / interface name to probe. E.g. `'BidQuestion'`. */
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
// flow-trace query (ROADMAP R-WP6, flow-trace-TECH.md)
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
}

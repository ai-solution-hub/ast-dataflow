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
 */
export type ErrorKind =
  | 'unknown_file'
  | 'parse_error'
  | 'ambiguous_symbol'
  | 'out_of_corpus';

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
  limit?: number;     // default 200
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
  columnPath: string;   // the matched column literal or object key
  table: string;        // echo of the table arg
  isTyped: boolean;     // true if the Supabase client is type-instantiated with a row type
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
export type ColumnWriteMethod = 'insert' | 'update' | 'upsert' | 'match' | 'rpc-payload';

export interface ColumnWriteResult extends BaseResult {
  method: ColumnWriteMethod;
  columnPath: string;  // the matched object property key
  table: string;       // echo of the table arg
  isTyped: boolean;    // true if the Supabase client is type-instantiated
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

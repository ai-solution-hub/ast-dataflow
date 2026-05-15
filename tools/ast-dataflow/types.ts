export type Confidence = 'exact' | 'inferred' | 'indirect';

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

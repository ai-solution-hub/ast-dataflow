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

export interface QueryResponse<R extends BaseResult> {
  query: string;
  args: Record<string, unknown>;
  results: R[];
  truncated: boolean;
  totalEstimated?: number;
  durationMs: number;
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

export interface ImporterResult extends BaseResult {
  confidence: 'exact';
  namedImports: string[];
  importStyle: ImportStyle;
  isReexportOnly: boolean;
  unused: boolean;
}

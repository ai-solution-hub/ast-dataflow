import { resolve } from 'node:path';
import { Project } from 'ts-morph';

export { callers } from './queries/callers';
export { callees } from './queries/callees';
export { importers } from './queries/importers';
export { references } from './queries/references';
export { columnReads } from './queries/column-reads';
export { columnWrites } from './queries/column-writes';
export { deadExports } from './queries/dead-exports';
export { AstResolverError } from './resolve';
/**
 * The enveloped entry point. A library consumer should call `dispatch` rather
 * than a query function directly: the caveats, bucket histogram and truncation
 * narrowing are attached there, so a direct call gets rows without the context
 * needed to read a zero.
 */
export { dispatch, QUERY_NAMES } from './dispatch';
export type { QueryArgMap, QueryName, QueryResponseMap } from './dispatch';
export { loadSchema, lookupTableColumn, SCHEMA_TYPES_PATH } from './schema';
export type { SchemaEnumeration } from './schema';
export type {
  BaseResult,
  CorpusSummary,
  QueryCaveats,
  SchemaValidation,
  CalleeCallKind,
  CalleeResult,
  CalleesArgs,
  CalleesResponse,
  CallSiteResult,
  CallResolution,
  CallersArgs,
  ColumnReadMethod,
  ColumnReadResult,
  ColumnReadsArgs,
  ColumnWriteMethod,
  ColumnWriteResult,
  ColumnWritesArgs,
  Confidence,
  DeadExportKind,
  DeadExportResult,
  DeadExportsArgs,
  ErrorKind,
  ImporterResult,
  ImportersArgs,
  ImportStyle,
  QueryResponse,
  ReferenceKind,
  ReferenceResult,
  ReferencesArgs,
} from './types';

export interface CreateProjectOptions {
  tsConfigFilePath: string;
  repoRoot?: string;
}

export interface AstProject {
  project: Project;
  repoRoot: string;
}

export function createProject(opts: CreateProjectOptions): AstProject {
  const project = new Project({
    tsConfigFilePath: opts.tsConfigFilePath,
    skipAddingFilesFromTsConfig: false,
  });
  const repoRoot = opts.repoRoot ?? resolve(opts.tsConfigFilePath, '..');
  return { project, repoRoot };
}

export { typeEvolution } from './queries/type-evolution';
export type {
  TypeEvolutionArgs,
  TypeEvolutionKind,
  TypeEvolutionResult,
} from './types';

export { reexportChain } from './queries/reexport-chain';
export type {
  ReexportChainArgs,
  ReexportChainKind,
  ReexportChainResult,
} from './types';

// --- enum-uses ---
export { enumUses } from './queries/enum-uses';
export type { EnumUsesArgs, EnumUseKind, EnumUseResult } from './types';

// --- string-literal-uses ---
export { stringLiteralUses } from './queries/string-literal-uses';
export type {
  StringLiteralUsesArgs,
  StringLiteralUseKind,
  StringLiteralUseResult,
} from './types';

// --- fixture-uses ---
export { fixtureUses } from './queries/fixture-uses';
export type {
  FixtureFileType,
  FixtureUseKind,
  FixtureUseResult,
  FixtureUsesArgs,
} from './types';

// --- flow-trace ---
export { flowTrace } from './queries/flow-trace';
export type { FlowTraceArgs, FlowTraceHopKind, FlowTraceRow } from './types';

// --- type-drift-detect ---
export { typeDriftDetect } from './queries/type-drift-detect';
export type { TypeDriftDetectArgs, TypeDriftResult } from './types';

// --- schema-coverage ---
export {
  schemaCoverage,
  renderSchemaCoverageReport,
} from './queries/schema-coverage';
export type {
  SchemaCoverageArgs,
  SchemaCoverageCaveats,
  SchemaCoverageResponse,
  SchemaCoverageResult,
  SchemaCoverageVerdict,
} from './types';

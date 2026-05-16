import { resolve } from 'node:path';
import { Project } from 'ts-morph';

export { callers } from './queries/callers';
export { importers } from './queries/importers';
export { references } from './queries/references';
export { columnReads } from './queries/column-reads';
export { columnWrites } from './queries/column-writes';
export { deadExports } from './queries/dead-exports';
export { AstResolverError } from './resolve';
export type {
  BaseResult,
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

import { resolve } from 'node:path';
import { Project } from 'ts-morph';

export { callers } from './queries/callers';
export { importers } from './queries/importers';
export { references } from './queries/references';
export { columnReads } from './queries/column-reads';
export { columnWrites } from './queries/column-writes';
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

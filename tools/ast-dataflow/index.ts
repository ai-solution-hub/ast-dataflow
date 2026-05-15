import { resolve } from 'node:path';
import { Project } from 'ts-morph';

export { callers } from './queries/callers';
export { importers } from './queries/importers';
export type {
  BaseResult,
  CallSiteResult,
  CallResolution,
  CallersArgs,
  Confidence,
  ImporterResult,
  ImportersArgs,
  ImportStyle,
  QueryResponse,
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

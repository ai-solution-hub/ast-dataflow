import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Project } from 'ts-morph';
import { dispatch } from './dispatch';
import type { QueryArgMap, QueryName, QueryResponseMap } from './dispatch';
import { createProject } from './index';
import { toRepoRelative } from './resolve';

export interface FileStamp {
  mtimeMs: number;
  size: number;
}

/**
 * The warm-process state the MCP server holds across tool calls (fixCache.md
 * Stage 1): the live ts-morph Project plus a per-file mtime+size stamp map
 * used to detect on-disk changes between calls.
 */
export interface WarmState {
  project: Project;
  repoRoot: string;
  tsConfigFilePath: string;
  known: Map<string, FileStamp>;
}

/**
 * Per-call staleness accounting, attached to every warm response as `meta`
 * (stale-loud, PRODUCT inv 22). All paths are repo-root-relative POSIX.
 */
export interface StalenessMeta {
  refreshedFiles: string[];
  addedFiles: string[];
  removedFiles: string[];
  staleFiles: string[];
}

export function createWarmState(opts: {
  repoRoot: string;
  tsConfigFilePath?: string;
}): WarmState {
  const tsConfigFilePath =
    opts.tsConfigFilePath ?? resolve(opts.repoRoot, 'tsconfig.json');
  const { project } = createProject({
    tsConfigFilePath,
    repoRoot: opts.repoRoot,
  });
  const known = new Map<string, FileStamp>();
  for (const sf of project.getSourceFiles()) {
    const abs = sf.getFilePath();
    try {
      const stat = statSync(abs);
      known.set(abs, { mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {
      // Unreadable at construction: leave unstamped so the first sweep
      // handles it (forget on missing, stale-loud on refresh failure).
    }
  }
  return { project, repoRoot: opts.repoRoot, tsConfigFilePath, known };
}

/**
 * Bring the in-memory Project back in sync with disk (fixCache.md Stage 1
 * staleness protocol): re-enumerate the tsconfig corpus to add files created
 * since the last sweep, forget files deleted from disk, and refresh any file
 * whose mtime+size stamp no longer matches. A file whose refresh throws is
 * reported in `staleFiles` — never silently served stale (inv 22) — and its
 * stamp is left unchanged so the next sweep retries the refresh.
 */
export function sweepStaleness(state: WarmState): StalenessMeta {
  const meta: StalenessMeta = {
    refreshedFiles: [],
    addedFiles: [],
    removedFiles: [],
    staleFiles: [],
  };

  // Files created on disk since the last sweep enter here; already-present
  // files are returned as-is without a re-read. Dependency-resolved files
  // (outside the tsconfig include set) are already in the project and are
  // covered by the stat pass below.
  state.project.addSourceFilesFromTsConfig(state.tsConfigFilePath);

  // Copy: forget() mutates the project's file list mid-iteration.
  for (const sf of [...state.project.getSourceFiles()]) {
    const abs = sf.getFilePath();
    const rel = toRepoRelative(state.repoRoot, abs);
    let stat: FileStamp;
    try {
      const s = statSync(abs);
      stat = { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      sf.forget();
      state.known.delete(abs);
      meta.removedFiles.push(rel);
      continue;
    }
    const prev = state.known.get(abs);
    if (!prev) {
      state.known.set(abs, stat);
      meta.addedFiles.push(rel);
      continue;
    }
    if (prev.mtimeMs === stat.mtimeMs && prev.size === stat.size) continue;
    try {
      sf.refreshFromFileSystemSync();
      state.known.set(abs, stat);
      meta.refreshedFiles.push(rel);
    } catch {
      meta.staleFiles.push(rel);
    }
  }

  return meta;
}

export type WarmResponse<Q extends QueryName> = QueryResponseMap[Q] & {
  meta: StalenessMeta;
};

/**
 * The warm-process query path: sweep staleness, then dispatch against the
 * held Project. Every response carries the sweep's `meta` so callers see
 * exactly which files were refreshed/added/removed — and which are being
 * served stale (inv 22).
 */
export async function warmDispatch<Q extends QueryName>(
  state: WarmState,
  query: Q,
  args: QueryArgMap[Q],
): Promise<WarmResponse<Q>> {
  const meta = sweepStaleness(state);
  const response = await dispatch(query, args, state.project, state.repoRoot);
  return { ...response, meta };
}

export interface SerialQueue {
  enqueue<T>(task: () => Promise<T>): Promise<T>;
}

/**
 * Serialise tool calls through a promise chain (inv 21): ts-morph is
 * single-threaded, so overlapping dispatches must run strictly in submission
 * order. A rejected task rejects its own caller only — the chain itself
 * swallows the failure so subsequent calls still run.
 */
export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    enqueue<T>(task: () => Promise<T>): Promise<T> {
      const next = tail.then(() => task());
      tail = next.catch(() => undefined);
      return next;
    },
  };
}

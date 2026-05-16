import { readFileSync } from 'node:fs';
import {
  type Project,
  type SourceFile,
  type Node,
  type ReferenceFindableNode,
} from 'ts-morph';
import type {
  DeadExportsArgs,
  DeadExportResult,
  DeadExportKind,
  QueryResponse,
} from '../types';
import { buildErrorResponse, toRepoRelative, walkBarrelChain } from '../resolve';

const DEFAULT_LIMIT = 200;

// ---------------------------------------------------------------------------
// Test-file heuristic (inline per brief — deferred polish for R-WP2)
// ---------------------------------------------------------------------------

function isTestFile(relPath: string): boolean {
  return (
    relPath.startsWith('__tests__/') ||
    relPath.includes('/test/') ||
    relPath.endsWith('.test.ts') ||
    relPath.endsWith('.test.tsx') ||
    relPath.endsWith('.spec.ts') ||
    relPath.endsWith('.spec.tsx')
  );
}

// ---------------------------------------------------------------------------
// Symbol-level reference counting
//
// Uses ts-morph findReferences() to enumerate every reference to a specific
// exported declaration, then buckets by: same-file (excluded), production,
// test-only.
// ---------------------------------------------------------------------------

interface RefCounts {
  production: number;
  testOnly: number;
}

function countSymbolRefs(
  decl: Node,
  sourceAbsPath: string,
  repoRoot: string,
  excludeTests: boolean,
): RefCounts {
  let production = 0;
  let testOnly = 0;

  // Only nodes that implement ReferenceFindableNode support findReferences().
  if (!('findReferences' in decl)) return { production, testOnly };

  try {
    const refs = (decl as unknown as ReferenceFindableNode).findReferences();
    for (const refEntry of refs) {
      for (const ref of refEntry.getReferences()) {
        const refFile = ref.getSourceFile().getFilePath();
        // Exclude: the declaration itself (same file).
        if (refFile === sourceAbsPath) continue;

        const relPath = toRepoRelative(repoRoot, refFile);
        if (isTestFile(relPath)) {
          if (!excludeTests) testOnly++;
        } else {
          production++;
        }
      }
    }
  } catch {
    // findReferences may throw on some synthetic nodes; treat as zero refs.
  }

  return { production, testOnly };
}

// Barrel walker is now in resolve.ts as walkBarrelChain (extracted by R-WP2).

// ---------------------------------------------------------------------------
// Extract exports from a source file
// ---------------------------------------------------------------------------

interface ExportEntry {
  name: string;
  kind: DeadExportKind;
  line: number;
  column: number;
  /** The declaration node — used for symbol-level findReferences(). */
  decl: Node;
}

function extractExports(sf: SourceFile): ExportEntry[] {
  const entries: ExportEntry[] = [];

  // Named exports: `export function foo`, `export const bar`, `export class Baz`
  // Only include declarations whose source is THIS file (not re-export-from entries).
  // Re-exports-from are barrel hops and are handled by the barrel walker in the
  // context of the ORIGINAL source file, not the barrel file.
  for (const [name, decls] of sf.getExportedDeclarations().entries()) {
    if (name === 'default') continue; // handled separately below
    for (const decl of decls) {
      // Only count exports actually declared in this file — skip re-exports-from.
      if (decl.getSourceFile().getFilePath() !== sf.getFilePath()) continue;
      const pos = sf.getLineAndColumnAtPos(decl.getStart());
      entries.push({
        name,
        kind: 'named',
        line: pos.line,
        column: pos.column,
        decl,
      });
      break; // one entry per export name
    }
  }

  // Default export: `export default function foo` / `export default class Foo`
  const defaultDecls = sf.getExportedDeclarations().get('default');
  if (defaultDecls && defaultDecls.length > 0) {
    const decl = defaultDecls[0];
    if (decl.getSourceFile().getFilePath() === sf.getFilePath()) {
      const pos = sf.getLineAndColumnAtPos(decl.getStart());
      entries.push({
        name: 'default',
        kind: 'default',
        line: pos.line,
        column: pos.column,
        decl,
      });
    }
  }

  // NOTE: `export { X } from '...'` (re-export-from / barrel) entries are
  // intentionally NOT included here. The barrel walker in the main loop handles
  // them in the context of the ORIGINAL source file. Including them here would
  // produce false-positive dead-export rows for barrel-index.ts's re-exported
  // symbols, because the ExportSpecifier node in the barrel file has no external
  // importers of its own.

  // Deduplicate by name (shouldn't happen for well-formed files, but be safe).
  const seen = new Set<string>();
  return entries.filter((e) => {
    if (seen.has(e.name)) return false;
    seen.add(e.name);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Main query function
// ---------------------------------------------------------------------------

export async function deadExports(
  args: DeadExportsArgs,
  project: Project,
  repoRoot: string,
): Promise<QueryResponse<DeadExportResult>> {
  const started = Date.now();
  const limit = args.limit ?? DEFAULT_LIMIT;
  const excludeTests = args.excludeTests ?? false;

  // Batch mode: read symbol names from file, one per line.
  let symbolFilter: Set<string> | null = null;

  if (args.symbolsFile) {
    try {
      const lines = readFileSync(args.symbolsFile, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      symbolFilter = new Set(lines);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return buildErrorResponse<DeadExportResult>(
        'dead-exports',
        { ...args },
        'parse_error',
        `Cannot read symbolsFile "${args.symbolsFile}": ${message}`,
        'Provide a valid path to a file with one symbol name per line.',
        Date.now() - started,
      );
    }
  }

  // Single-symbol filter mode.
  if (args.symbol) {
    symbolFilter = symbolFilter ?? new Set();
    symbolFilter.add(args.symbol);
  }

  const rows: DeadExportResult[] = [];
  let totalEstimated = 0;

  try {
    for (const sf of project.getSourceFiles()) {
      const relPath = toRepoRelative(repoRoot, sf.getFilePath());

      // Skip test files as sources of exports-to-check.
      if (isTestFile(relPath)) continue;

      const exports = extractExports(sf);

      for (const exportEntry of exports) {
        // Apply symbol filter when set.
        if (symbolFilter && !symbolFilter.has(exportEntry.name)) continue;

        // Count symbol-level references (ts-morph findReferences) excluding
        // same-file and declaration self.
        const refs = countSymbolRefs(
          exportEntry.decl,
          sf.getFilePath(),
          repoRoot,
          excludeTests,
        );

        // Run the barrel walker for one-hop reachability (detects symbols that
        // escape via a barrel re-export, which findReferences may not count if
        // the barrel importer uses a namespace import or the re-export itself
        // is not referenced directly by name from the importer).
        const barrel = walkBarrelChain(
          exportEntry.name,
          sf,
          project,
          repoRoot,
          excludeTests,
        );

        const reachableImporters = refs.production + barrel.reachableImporters;
        const testOnlyImporters = refs.testOnly + barrel.testOnlyImporters;
        const testOnly = reachableImporters === 0 && testOnlyImporters > 0;

        // Only emit rows for dead exports (reachableImporters === 0).
        if (reachableImporters === 0) {
          totalEstimated++;
          if (rows.length < limit) {
            rows.push({
              file: relPath,
              line: exportEntry.line,
              column: exportEntry.column,
              confidence: 'exact',
              symbol: exportEntry.name,
              exportKind: exportEntry.kind,
              reachableImporters,
              testOnlyImporters,
              testOnly,
              barrelChain: barrel.chain,
            });
          }
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return buildErrorResponse<DeadExportResult>(
      'dead-exports',
      { ...args, limit },
      'parse_error',
      `Unexpected error during dead-exports traversal: ${message}`,
      'Check that the project compiles without errors.',
      Date.now() - started,
    );
  }

  return {
    query: 'dead-exports',
    args: { ...args, limit },
    results: rows,
    truncated: totalEstimated > rows.length,
    totalEstimated: totalEstimated > rows.length ? totalEstimated : undefined,
    durationMs: Date.now() - started,
  };
}

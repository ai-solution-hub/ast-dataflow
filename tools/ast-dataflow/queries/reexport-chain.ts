import { resolve } from 'node:path';
import { type Project, type SourceFile } from 'ts-morph';
import type {
  ReexportChainArgs,
  ReexportChainResult,
  QueryResponse,
} from '../types';
import { buildErrorResponse, toRepoRelative, isTestFilePath } from '../resolve';

const DEFAULT_LIMIT = 200;

// ---------------------------------------------------------------------------
// Find the declaration source file for a named symbol
// ---------------------------------------------------------------------------

/**
 * Find the source file that declares `symbolName`.
 *
 * When `fromPath` is supplied, only that file is checked.
 * When omitted, the project is scanned for the first file that exports
 * a declaration with the given name.
 *
 * Returns the SourceFile + position, or null if not found.
 */
function findDeclarationFile(
  symbolName: string,
  project: Project,
  repoRoot: string,
  fromPath?: string,
): { sf: SourceFile; line: number; column: number } | null {
  const candidates: SourceFile[] = fromPath
    ? (() => {
        const absPath = resolve(repoRoot, fromPath);
        const sf = project.getSourceFile(absPath);
        return sf ? [sf] : [];
      })()
    : project.getSourceFiles();

  for (const sf of candidates) {
    const exportedDecls = sf.getExportedDeclarations();
    const decls = exportedDecls.get(symbolName);
    if (!decls || decls.length === 0) continue;

    for (const decl of decls) {
      // Only count declarations actually in this file (not re-exports-from).
      if (decl.getSourceFile().getFilePath() !== sf.getFilePath()) continue;

      const pos = sf.getLineAndColumnAtPos(decl.getStart());
      return { sf, line: pos.line, column: pos.column };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Multi-hop barrel traversal
//
// Unlike walkBarrelChain (in resolve.ts, which is 1-hop only), this walker
// follows the chain recursively and assigns distance values to each hop.
//
// We use a BFS approach:
//   - Start at the declaration file (distance 0)
//   - At each level, find all ExportDeclarations in the project that
//     re-export from the current set of source files
//   - Record those barrel files as 'reexport' rows with the current distance
//   - Then find all importers of those barrels as 'importer' rows
//   - Continue BFS from each barrel (as a new re-export source) until no
//     new barrels are found
// ---------------------------------------------------------------------------

interface ChainRow {
  file: string;
  line: number;
  column: number;
  kind: ReexportChainResult['kind'];
  symbolName: string;
  throughBarrel: string | null;
  distance: number;
}

function buildReexportChain(
  symbolName: string,
  declarationSf: SourceFile,
  project: Project,
  repoRoot: string,
  excludeTests: boolean,
  limit: number,
): ChainRow[] {
  const rows: ChainRow[] = [];
  const visitedBarrels = new Set<string>(); // abs paths of barrels already processed
  const visitedImporters = new Set<string>(); // abs paths of importers already emitted

  // Declaration row (distance 0)
  const declarationRelPath = toRepoRelative(
    repoRoot,
    declarationSf.getFilePath(),
  );
  const declarationPos = (() => {
    const decls = declarationSf.getExportedDeclarations().get(symbolName);
    if (decls && decls.length > 0) {
      const decl = decls.find(
        (d) => d.getSourceFile().getFilePath() === declarationSf.getFilePath(),
      );
      if (decl) {
        return declarationSf.getLineAndColumnAtPos(decl.getStart());
      }
    }
    return { line: 1, column: 1 };
  })();

  rows.push({
    file: declarationRelPath,
    line: declarationPos.line,
    column: declarationPos.column,
    kind: 'declaration',
    symbolName,
    throughBarrel: null,
    distance: 0,
  });

  // BFS queue: { sourceAbsPath, distance }
  // We start from the declaration file and look for barrels that re-export
  // the symbol. Each barrel we find is then checked for further re-exports.
  const queue: Array<{ sourceAbsPath: string; distance: number }> = [
    { sourceAbsPath: declarationSf.getFilePath(), distance: 0 },
  ];

  while (queue.length > 0 && rows.length < limit) {
    const { sourceAbsPath, distance } = queue.shift()!;
    const nextDistance = distance + 1;

    // Find all files in the project that re-export from sourceAbsPath.
    for (const sf of project.getSourceFiles()) {
      if (sf.getFilePath() === sourceAbsPath) continue;

      const barrelAbsPath = sf.getFilePath();
      const barrelRelPath = toRepoRelative(repoRoot, barrelAbsPath);

      // Check every `export { X } from '...'` or `export * from '...'`.
      const exportDecls = sf.getExportDeclarations();
      let thisBarrelReexportsSymbol = false;

      for (const exportDecl of exportDecls) {
        const moduleSpecifier = exportDecl.getModuleSpecifierSourceFile();
        if (!moduleSpecifier) continue;
        if (moduleSpecifier.getFilePath() !== sourceAbsPath) continue;

        // Check whether our specific symbol is re-exported.
        let exportsOurSymbol = false;

        if (exportDecl.isNamespaceExport()) {
          // `export * from '...'` — all exports flow through.
          exportsOurSymbol = true;
        } else {
          const namedExports = exportDecl.getNamedExports();
          exportsOurSymbol = namedExports.some((ne) => {
            // getName() returns the original name in the source file.
            // For `export { foo as bar }`, getName() is 'foo' and
            // getAliasNode()?.getText() is 'bar'.
            return ne.getName() === symbolName;
          });
        }

        if (!exportsOurSymbol) continue;
        thisBarrelReexportsSymbol = true;

        // Emit a reexport row for this barrel (only once per barrel per symbol).
        if (!visitedBarrels.has(barrelAbsPath)) {
          visitedBarrels.add(barrelAbsPath);

          const exportDeclPos = sf.getLineAndColumnAtPos(exportDecl.getStart());
          rows.push({
            file: barrelRelPath,
            line: exportDeclPos.line,
            column: exportDeclPos.column,
            kind: 'reexport',
            symbolName,
            throughBarrel: barrelRelPath,
            distance: nextDistance,
          });

          // Queue this barrel for further re-export hops.
          queue.push({ sourceAbsPath: barrelAbsPath, distance: nextDistance });
        }
      }

      if (!thisBarrelReexportsSymbol) continue;

      // Find real importers of this barrel (files that import from it,
      // not via another barrel — they are the terminal consumers).
      for (const consumer of project.getSourceFiles()) {
        if (consumer.getFilePath() === barrelAbsPath) continue;
        if (consumer.getFilePath() === sourceAbsPath) continue;

        const consumerAbsPath = consumer.getFilePath();
        if (visitedImporters.has(consumerAbsPath)) continue;

        const consumerRelPath = toRepoRelative(repoRoot, consumerAbsPath);

        // Check if this consumer imports the barrel directly.
        const importsBarrel = consumer.getImportDeclarations().some((imp) => {
          const resolved = imp.getModuleSpecifierSourceFile();
          return resolved?.getFilePath() === barrelAbsPath;
        });

        if (!importsBarrel) continue;

        // Skip test files when excludeTests is set.
        if (excludeTests && isTestFilePath(consumerRelPath)) continue;

        // A barrel re-export of this barrel is not an "importer" — it's a
        // further hop. Only emit importer rows for files that are NOT
        // themselves re-exporting the symbol (i.e. they consume it).
        // We check: does this consumer itself re-export our symbol?
        const isAnotherBarrel = consumer.getExportDeclarations().some((ed) => {
          const modSpec = ed.getModuleSpecifierSourceFile();
          return modSpec?.getFilePath() === barrelAbsPath;
        });
        if (isAnotherBarrel) continue;

        visitedImporters.add(consumerAbsPath);

        // Position: use the import declaration's location.
        const importDecl = consumer.getImportDeclarations().find((imp) => {
          const resolved = imp.getModuleSpecifierSourceFile();
          return resolved?.getFilePath() === barrelAbsPath;
        });
        const importPos = importDecl
          ? consumer.getLineAndColumnAtPos(importDecl.getStart())
          : { line: 1, column: 1 };

        rows.push({
          file: consumerRelPath,
          line: importPos.line,
          column: importPos.column,
          kind: 'importer',
          symbolName,
          throughBarrel: null,
          distance: nextDistance,
        });
      }
    }
  }

  // Also find direct importers of the declaration file itself (no barrel hop).
  // These are files that import the symbol directly without going through a barrel.
  const declarationAbsPath = declarationSf.getFilePath();
  for (const sf of project.getSourceFiles()) {
    if (sf.getFilePath() === declarationAbsPath) continue;

    const consumerAbsPath = sf.getFilePath();
    if (visitedImporters.has(consumerAbsPath)) continue;
    if (visitedBarrels.has(consumerAbsPath)) continue;

    const consumerRelPath = toRepoRelative(repoRoot, consumerAbsPath);
    if (excludeTests && isTestFilePath(consumerRelPath)) continue;

    const importDecl = sf.getImportDeclarations().find((imp) => {
      const resolved = imp.getModuleSpecifierSourceFile();
      return resolved?.getFilePath() === declarationAbsPath;
    });

    if (!importDecl) continue;

    visitedImporters.add(consumerAbsPath);

    const importPos = sf.getLineAndColumnAtPos(importDecl.getStart());
    rows.push({
      file: consumerRelPath,
      line: importPos.line,
      column: importPos.column,
      kind: 'importer',
      symbolName,
      throughBarrel: null,
      distance: 0,
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Main query function
// ---------------------------------------------------------------------------

export async function reexportChain(
  args: ReexportChainArgs,
  project: Project,
  repoRoot: string,
): Promise<QueryResponse<ReexportChainResult>> {
  const started = Date.now();
  const limit = args.limit ?? DEFAULT_LIMIT;
  const excludeTests = args.excludeTests ?? false;

  // Validate: `from` file must be in the project if supplied.
  if (args.from) {
    const absPath = resolve(repoRoot, args.from);
    const sf = project.getSourceFile(absPath);
    if (!sf) {
      return buildErrorResponse<ReexportChainResult>(
        'reexport-chain',
        { ...args, limit },
        'unknown_file',
        `File not in project: ${args.from}`,
        'Verify the file path is correct and relative to the repo root.',
        Date.now() - started,
      );
    }
  }

  // Find the declaration file.
  const found = findDeclarationFile(args.symbol, project, repoRoot, args.from);
  if (!found) {
    return buildErrorResponse<ReexportChainResult>(
      'reexport-chain',
      { ...args, limit },
      'out_of_corpus',
      args.from
        ? `Symbol "${args.symbol}" not found as an export in ${args.from}.`
        : `Symbol "${args.symbol}" not found in any project source file.`,
      'Verify the symbol name is exported and spelled correctly.',
      Date.now() - started,
    );
  }

  const chainRows = buildReexportChain(
    args.symbol,
    found.sf,
    project,
    repoRoot,
    excludeTests,
    limit,
  );

  // Convert ChainRow to ReexportChainResult (satisfies BaseResult).
  const results: ReexportChainResult[] = chainRows
    .slice(0, limit)
    .map((row) => ({
      file: row.file,
      line: row.line,
      column: row.column,
      confidence: 'exact',
      kind: row.kind,
      symbolName: row.symbolName,
      throughBarrel: row.throughBarrel,
      distance: row.distance,
    }));

  return {
    query: 'reexport-chain',
    args: { ...args, limit },
    results,
    truncated: chainRows.length > limit,
    totalEstimated: chainRows.length > limit ? chainRows.length : undefined,
    durationMs: Date.now() - started,
  };
}

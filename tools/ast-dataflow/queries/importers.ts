import { relative, resolve, isAbsolute } from 'node:path';
import { type Project, SyntaxKind } from 'ts-morph';
import type {
  ImportersArgs,
  ImporterResult,
  ImportStyle,
  QueryResponse,
} from '../types';
import { buildErrorResponse } from '../resolve';

const DEFAULT_LIMIT = 200;

/**
 * Extract the set of alias prefixes declared in the project's tsconfig
 * `compilerOptions.paths`.
 *
 * Each paths entry has the form `"alias/*": ["./target/*"]`. We collect the
 * leading segment before the first `/` (e.g. `@`, `~`, `#`) so the suffix
 * matcher can strip any of them. Falls back to `['@']` (the KH convention)
 * when no paths are declared.
 *
 * We intentionally limit to single-character-prefix aliases (beginning with
 * a non-alphanumeric character) to avoid accidentally stripping genuine
 * directory names like `api/` or `src/`.
 */
function extractAliasPrefixes(project: Project): string[] {
  const opts = project.getCompilerOptions();
  const paths = opts.paths;
  if (!paths || Object.keys(paths).length === 0) {
    // No tsconfig paths declared — fall back to KH's @/ convention.
    return ['@/'];
  }

  const prefixes = new Set<string>();
  for (const pattern of Object.keys(paths)) {
    // pattern is e.g. "@/*", "~/*", "#app/*"
    // Extract the portion up to and including the first slash.
    const slashIndex = pattern.indexOf('/');
    if (slashIndex <= 0) continue;
    const prefix = pattern.slice(0, slashIndex + 1); // e.g. "@/", "~/", "#app/"
    // Only include prefixes that start with a non-alphanumeric character
    // (avoids treating "src/" or "lib/" as aliases).
    if (/^[^a-zA-Z0-9]/.test(prefix)) {
      prefixes.add(prefix);
    }
  }
  return prefixes.size > 0 ? Array.from(prefixes) : ['@/'];
}

/**
 * Strip any recognised path-alias prefix from a module specifier so that
 * suffix matching against the resolved absolute path works regardless of
 * which alias convention the project uses.
 *
 * Examples (with KH aliases `@/` and a Vite project alias `~/`):
 *   '@/lib/ai/change-reports'   → 'lib/ai/change-reports'
 *   '~/utils/format'    → 'utils/format'
 *   'src/utils/format'  → 'src/utils/format'  (no prefix to strip)
 */
function stripAliasPrefix(specifier: string, aliasPrefixes: string[]): string {
  for (const prefix of aliasPrefixes) {
    if (specifier.startsWith(prefix)) {
      return specifier.slice(prefix.length);
    }
  }
  return specifier;
}

/**
 * Resolve a module path string to an absolute file path using the project's
 * module resolver.
 *
 * Strategy: walk every source file's import declarations. The first one whose
 * getModuleSpecifierSourceFile() returns a SourceFile, and whose specifier
 * value matches the input (or whose resolved file path ends with a normalised
 * form of the input), is our target. This way both '@/lib/ai/change-reports' and
 * '../../lib/ai/change-reports' resolve to the same SourceFile without re-implementing
 * the compiler's module resolver.
 *
 * The alias strip uses the tsconfig `compilerOptions.paths` to discover which
 * alias prefixes are active (e.g. `@/` for KH, `~/` for Vite projects).
 * Falls back to stripping `@/` when no paths are declared.
 *
 * If no import in the corpus resolves to the input string, we fall back to
 * treating the modulePath as a repo-relative file path and looking it up
 * directly in the project.
 */
function resolveTargetFilePath(
  modulePath: string,
  project: Project,
  repoRoot: string,
): string | null {
  // Normalise the input: strip trailing '.ts' for comparison purposes.
  const normalised = modulePath.replace(/\.ts$/, '');

  const aliasPrefixes = extractAliasPrefixes(project);
  const strippedNormalised = stripAliasPrefix(normalised, aliasPrefixes);

  for (const sf of project.getSourceFiles()) {
    for (const importDecl of sf.getImportDeclarations()) {
      const specifier = importDecl.getModuleSpecifierValue();
      // Quick pre-filter: the specifier must contain the last segment of the
      // normalised module path to avoid unnecessary resolution calls.
      const lastSegment = normalised.split('/').at(-1) ?? normalised;
      if (!specifier.includes(lastSegment)) continue;

      const resolved = importDecl.getModuleSpecifierSourceFile();
      if (!resolved) continue;

      const resolvedPath = resolved.getFilePath();
      const resolvedNormalised = resolvedPath.replace(/\.tsx?$/, '');

      // Match on the raw specifier string.
      if (
        specifier === modulePath ||
        specifier === normalised ||
        specifier.replace(/\.ts$/, '') === normalised
      ) {
        return resolvedPath;
      }

      // Match on the tail of the resolved absolute path against the input,
      // stripping any declared alias prefix (supports @/, ~/, #app/, etc.).
      if (resolvedNormalised.endsWith('/' + strippedNormalised)) {
        return resolvedPath;
      }
    }
  }

  // Fallback: interpret modulePath as repo-relative path.
  const absPath = isAbsolute(modulePath)
    ? modulePath
    : resolve(repoRoot, modulePath);
  const direct = project.getSourceFile(absPath);
  if (direct) return direct.getFilePath();

  // Try without extension.
  const withTs = absPath.endsWith('.ts') ? absPath : absPath + '.ts';
  const withExtension = project.getSourceFile(withTs);
  if (withExtension) return withExtension.getFilePath();

  return null;
}

function toRepoRelative(repoRoot: string, absPath: string): string {
  const rel = relative(repoRoot, absPath);
  return rel.split('\\').join('/');
}

/**
 * Determine whether any named import (or its alias) is referenced in the
 * file body beyond the import declaration itself.
 *
 * Heuristic: for each named import, check if its local binding name appears
 * in the file's text outside the import statement. We use
 * `findReferencesAsNodes()` on the import specifier's local name, then filter
 * to nodes that are NOT the import clause itself.
 *
 * Returns true if ALL named imports are unreferenced (i.e. the whole import
 * is unused from a usage perspective).
 */
function isImportUnused(
  namedImports: import('ts-morph').ImportSpecifier[],
): boolean {
  if (namedImports.length === 0) return false;

  const sf = namedImports[0].getSourceFile();

  for (const ni of namedImports) {
    // The local binding in the file body is the alias (if present), else the
    // original name. E.g. `import { foo as bar }` → local name is `bar`.
    const aliasNode = ni.getAliasNode();
    const localName = aliasNode ?? ni.getNameNode();
    const refs = localName.findReferencesAsNodes();

    // Filter to refs that are:
    //   - in the same source file (cross-file declaration sites are excluded)
    //   - NOT inside an ImportDeclaration (i.e. not the import clause itself)
    const bodyRefs = refs.filter(
      (ref) =>
        ref.getSourceFile() === sf &&
        ref.getFirstAncestorByKind(SyntaxKind.ImportDeclaration) === undefined,
    );

    if (bodyRefs.length > 0) {
      // At least one named import is used in the file body.
      return false;
    }
  }
  return true;
}

export async function importers(
  args: ImportersArgs,
  project: Project,
  repoRoot: string,
): Promise<QueryResponse<ImporterResult>> {
  const started = Date.now();

  if (!args.modulePath) {
    return buildErrorResponse<ImporterResult>(
      'importers',
      { ...args },
      'parse_error',
      'modulePath must be a non-empty string.',
      "Example: '@/lib/ai/change-reports' or 'lib/ai/change-reports.ts'.",
      Date.now() - started,
    );
  }

  const limit = args.limit ?? DEFAULT_LIMIT;

  const targetFilePath = resolveTargetFilePath(
    args.modulePath,
    project,
    repoRoot,
  );

  const rows: ImporterResult[] = [];
  let totalEstimated = 0;

  for (const sf of project.getSourceFiles()) {
    const sfPath = sf.getFilePath();

    // Skip the target file itself.
    if (targetFilePath && sfPath === targetFilePath) continue;

    let matched = false;
    let row: ImporterResult | null = null;

    // ── ImportDeclarations ──────────────────────────────────────────────────
    for (const importDecl of sf.getImportDeclarations()) {
      const resolved = importDecl.getModuleSpecifierSourceFile();

      // Match by resolved file path (type-checker-backed, exact).
      const isTargetMatch =
        targetFilePath !== null
          ? resolved?.getFilePath() === targetFilePath
          : // Fallback when target resolution failed: match by specifier string.
            importDecl.getModuleSpecifierValue() === args.modulePath;

      if (!isTargetMatch) continue;

      matched = true;
      totalEstimated++;
      if (rows.length >= limit) continue;

      const lineCol = sf.getLineAndColumnAtPos(importDecl.getStart());

      // Named imports: record original names (not aliases).
      const namedImportSpecs = importDecl.getNamedImports();
      const namedImports = namedImportSpecs.map((ni) => ni.getName());

      // Import style.
      let importStyle: ImportStyle;
      if (importDecl.isTypeOnly()) {
        importStyle = 'typeOnly';
      } else if (importDecl.getDefaultImport() !== undefined) {
        importStyle = 'default';
      } else if (importDecl.getNamespaceImport() !== undefined) {
        importStyle = 'namespace';
      } else {
        importStyle = 'named';
      }

      // Unused check: only meaningful for named imports.
      const unused =
        importStyle === 'named' && namedImportSpecs.length > 0
          ? isImportUnused(namedImportSpecs)
          : false;

      row = {
        file: toRepoRelative(repoRoot, sfPath),
        line: lineCol.line,
        column: lineCol.column,
        confidence: 'exact',
        namedImports,
        importStyle,
        isReexportOnly: false,
        unused,
      };
      break; // One row per file; take the first matching import.
    }

    if (matched && row) {
      rows.push(row);
      continue;
    }

    // ── ExportDeclarations (re-exports: `export { foo } from '...'`) ────────
    for (const exportDecl of sf.getExportDeclarations()) {
      if (!exportDecl.hasModuleSpecifier()) continue;

      const resolved = exportDecl.getModuleSpecifierSourceFile();
      const isTargetMatch =
        targetFilePath !== null
          ? resolved?.getFilePath() === targetFilePath
          : exportDecl.getModuleSpecifierValue() === args.modulePath;

      if (!isTargetMatch) continue;

      totalEstimated++;
      if (rows.length >= limit) continue;

      const lineCol = sf.getLineAndColumnAtPos(exportDecl.getStart());

      const namedExports = exportDecl.getNamedExports();
      const namedImports = namedExports.map((ne) => ne.getName());

      rows.push({
        file: toRepoRelative(repoRoot, sfPath),
        line: lineCol.line,
        column: lineCol.column,
        confidence: 'exact',
        namedImports,
        importStyle: 'reexport',
        isReexportOnly: true,
        unused: false,
      });
      break;
    }
  }

  return {
    query: 'importers',
    args: { ...args, limit },
    results: rows,
    truncated: totalEstimated > rows.length,
    totalEstimated: totalEstimated > rows.length ? totalEstimated : undefined,
    durationMs: Date.now() - started,
  };
}

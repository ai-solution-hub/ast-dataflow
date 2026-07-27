import { relative, resolve, isAbsolute } from 'node:path';
import {
  Node,
  type ImportSpecifier,
  type Project,
  type SourceFile,
} from 'ts-morph';
import type {
  ImportersArgs,
  ImporterResult,
  ImportStyle,
  QueryResponse,
} from '../types';
import { buildErrorResponse } from '../resolve';
import { truncateSpatial } from '../truncate';

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
 * Resolve a module path string to an absolute file path.
 *
 * Direct-path resolution runs FIRST: interpret the modulePath as a
 * repo-relative file path (with any alias prefix stripped) and look it up in
 * the project, appending extensions and index files the way the module
 * resolver would. This is a handful of O(1) lookups and covers repo-relative
 * inputs plus KH-style aliases whose mapping is the repo root (`@/*` → `./*`).
 *
 * Only when that misses do we fall back to walking every source file's import
 * declarations: the first one whose getModuleSpecifierSourceFile() returns a
 * SourceFile, and whose specifier value matches the input (or whose resolved
 * file path ends with a normalised form of the input), is our target. This
 * covers alias forms whose mapping differs from the stripped path (e.g. a
 * Vite `~/*` → `./src/*`) and relative-specifier inputs, without
 * re-implementing the compiler's module resolver — but it costs a module
 * resolution per candidate import, so it must stay the fallback (P-19).
 *
 * The alias strip uses the tsconfig `compilerOptions.paths` to discover which
 * alias prefixes are active (e.g. `@/` for KH, `~/` for Vite projects).
 * Falls back to stripping `@/` when no paths are declared.
 */
function resolveTargetFilePath(
  modulePath: string,
  project: Project,
  repoRoot: string,
): string | null {
  const aliasPrefixes = extractAliasPrefixes(project);

  // Direct path: interpret modulePath as repo-relative (alias stripped).
  const strippedInput = stripAliasPrefix(modulePath, aliasPrefixes);
  const absPath = isAbsolute(strippedInput)
    ? strippedInput
    : resolve(repoRoot, strippedInput);
  const direct = project.getSourceFile(absPath);
  if (direct) return direct.getFilePath();

  for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
    const candidate = project.getSourceFile(absPath + suffix);
    if (candidate) return candidate.getFilePath();
  }

  // Fallback: find an import in the corpus that resolves to the input.
  // Normalise the input: strip trailing '.ts' for comparison purposes.
  const normalised = modulePath.replace(/\.ts$/, '');
  const strippedNormalised = stripAliasPrefix(normalised, aliasPrefixes);
  const lastSegment = normalised.split('/').at(-1) ?? normalised;

  for (const sf of project.getSourceFiles()) {
    for (const importDecl of sf.getImportDeclarations()) {
      const specifier = importDecl.getModuleSpecifierValue();
      // Quick pre-filter: the specifier must contain the last segment of the
      // normalised module path to avoid unnecessary resolution calls.
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

  return null;
}

function toRepoRelative(repoRoot: string, absPath: string): string {
  const rel = relative(repoRoot, absPath);
  return rel.split('\\').join('/');
}

/**
 * True when the identifier occupies a position that can reference an imported
 * binding. Filters out the identifier-shaped positions that are NAMES rather
 * than references — `obj.foo`, `{ foo: 1 }`, `const { foo: x } = y`, member
 * declarations, `export { x as foo }` aliases, JSX attribute names — so a
 * property called `foo` does not mark an unused import `foo` as used.
 */
function isBindingUsagePosition(id: Node): boolean {
  const parent = id.getParent();
  if (parent === undefined) return false;

  if (Node.isPropertyAccessExpression(parent)) {
    return parent.getNameNode() !== id;
  }
  if (Node.isQualifiedName(parent)) {
    return parent.getRight() !== id;
  }
  if (Node.isPropertyAssignment(parent) || Node.isJsxAttribute(parent)) {
    return parent.getNameNode() !== id;
  }
  if (Node.isBindingElement(parent)) {
    return parent.getPropertyNameNode() !== id;
  }
  if (Node.isExportSpecifier(parent)) {
    // `export { local as alias }` — the local name references the binding.
    return parent.getAliasNode() !== id;
  }
  if (
    Node.isPropertySignature(parent) ||
    Node.isPropertyDeclaration(parent) ||
    Node.isMethodSignature(parent) ||
    Node.isMethodDeclaration(parent) ||
    Node.isGetAccessorDeclaration(parent) ||
    Node.isSetAccessorDeclaration(parent) ||
    Node.isEnumMember(parent)
  ) {
    return parent.getNameNode() !== id;
  }
  return true;
}

/**
 * Collect the names of all identifiers in binding-usage positions outside
 * import declarations — the syntactic approximation of "names referenced in
 * the file body". JSX tag usages (`<Widget />`, `<Widget>…</Widget>`) need no
 * special casing: a JsxSelfClosingElement/JsxOpeningElement tag name is
 * itself an Identifier descendant, and `<Ns.Widget />` resolves through the
 * PropertyAccessExpression rule above.
 */
function collectBodyUsageNames(sf: SourceFile): Set<string> {
  const names = new Set<string>();
  sf.forEachDescendant((node, traversal) => {
    if (Node.isImportDeclaration(node)) {
      traversal.skip();
      return;
    }
    if (Node.isIdentifier(node) && isBindingUsagePosition(node)) {
      names.add(node.getText());
    }
  });
  return names;
}

/**
 * Determine whether any named import (or its alias) is referenced in the
 * file body beyond the import declaration itself.
 *
 * Syntactic same-file scan: one forEachDescendant pass over the file collects
 * the identifier names in usage positions; each named import's local binding
 * name is then a Set lookup. Replaces a per-name language-service
 * findReferencesAsNodes() pass that dominated query time (P-19). The scan is
 * scope-blind — a same-named local declared in an inner scope counts as a
 * usage — which is an acceptable over-approximation for unused detection.
 *
 * Returns true if ALL named imports are unreferenced (i.e. the whole import
 * is unused from a usage perspective).
 */
function isImportUnused(namedImports: ImportSpecifier[]): boolean {
  if (namedImports.length === 0) return false;

  const usedNames = collectBodyUsageNames(namedImports[0].getSourceFile());

  return namedImports.every((ni) => {
    // The local binding in the file body is the alias (if present), else the
    // original name. E.g. `import { foo as bar }` → local name is `bar`.
    const localName = ni.getAliasNode() ?? ni.getNameNode();

    // A string-literal import name with no alias has no usage binding to
    // search for, so treat it as having no body references.
    if (!Node.isIdentifier(localName)) return true;

    return !usedNames.has(localName.getText());
  });
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

  const t = truncateSpatial(rows, limit);
  return {
    query: 'importers',
    args: { ...args, limit },
    results: t.rows,
    truncated: t.truncated,
    totalEstimated: t.totalEstimated,
    durationMs: Date.now() - started,
  };
}

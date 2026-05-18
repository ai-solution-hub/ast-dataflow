import { relative, resolve, isAbsolute } from 'node:path';
import {
  Project,
  SyntaxKind,
  type ExportDeclaration,
  type FunctionDeclaration,
  type MethodDeclaration,
  type Node,
  type ReferenceFindableNode,
  type SourceFile,
} from 'ts-morph';
import type { ErrorKind, QueryResponse, BaseResult } from './types';

/**
 * Typed error thrown by resolveSymbol so callers can classify by `code`
 * (sentinel) rather than string-matching the error message. Each catch site
 * maps `code` directly to the QueryResponse error envelope kind.
 */
export class AstResolverError extends Error {
  readonly code: ErrorKind;
  readonly hint?: string;

  constructor(message: string, code: ErrorKind, hint?: string) {
    super(message);
    this.name = 'AstResolverError';
    this.code = code;
    this.hint = hint;
  }
}

/**
 * Build a QueryResponse that carries a structured error (PRODUCT.md P-29).
 *
 * The response shape is a valid QueryResponse: `results` is always empty,
 * `truncated` is false, and `durationMs` records how long was spent before
 * the error was detected. Callers that need to emit the response immediately
 * can pass `Date.now() - started` as `durationMs`.
 */
export function buildErrorResponse<R extends BaseResult>(
  query: string,
  args: Record<string, unknown>,
  kind: ErrorKind,
  message: string,
  hint: string | undefined,
  durationMs: number,
): QueryResponse<R> {
  return {
    query,
    args,
    results: [] as R[],
    truncated: false,
    durationMs,
    error: {
      kind,
      message,
      ...(hint !== undefined ? { hint } : {}),
    },
  };
}

export interface ResolvedSymbol {
  declaration: ReferenceFindableNode & Node;
  declarationFile: string;
  declarationName: string;
}

/**
 * Resolve a symbol identifier of the shape "<relative-file-path>:<name>".
 * Example: "lib/supabase/safe.ts:sb".
 * Throws if file is not in the project or no exported declaration matches.
 */
export function resolveSymbol(
  project: Project,
  symbol: string,
  repoRoot: string,
): ResolvedSymbol {
  const sep = symbol.lastIndexOf(':');
  if (sep === -1) {
    throw new AstResolverError(
      `Symbol must be "<file>:<name>"; got "${symbol}". Example: "lib/supabase/safe.ts:sb".`,
      'parse_error',
      'Use the format <relative-file-path>:<exported-name>.',
    );
  }
  const filePart = symbol.slice(0, sep);
  const namePart = symbol.slice(sep + 1);
  if (!filePart || !namePart) {
    throw new AstResolverError(
      `Empty file or name in symbol "${symbol}".`,
      'parse_error',
      'Both the file path and symbol name are required.',
    );
  }

  const absPath = isAbsolute(filePart) ? filePart : resolve(repoRoot, filePart);

  const sf = project.getSourceFile(absPath);
  if (!sf) {
    throw new AstResolverError(
      `File not in project: ${filePart}`,
      'unknown_file',
      'Verify the file path is correct and relative to the repo root.',
    );
  }

  // Look for function / method / variable / class with the requested name.
  // We prefer exported declarations but accept non-exported as a fallback.
  const candidates: (ReferenceFindableNode & Node)[] = [];

  for (const fn of sf.getFunctions()) {
    if (fn.getName() === namePart) candidates.push(fn);
  }
  for (const cls of sf.getClasses()) {
    if (cls.getName() === namePart) candidates.push(cls);
    for (const m of cls.getMethods()) {
      if (m.getName() === namePart) candidates.push(m);
    }
  }
  for (const vd of sf.getVariableDeclarations()) {
    if (vd.getName() === namePart) candidates.push(vd);
  }
  for (const ed of sf.getExportedDeclarations().get(namePart) ?? []) {
    if ('findReferences' in ed) {
      candidates.push(ed as ReferenceFindableNode & Node);
    }
  }

  if (candidates.length === 0) {
    throw new AstResolverError(
      `Symbol "${namePart}" not found in ${filePart}. Looked at functions, classes, methods, variables, and named exports.`,
      'out_of_corpus',
      'Verify the symbol name is exported or declared in the specified file.',
    );
  }

  // Dedupe by node position.
  const seen = new Set<string>();
  const unique = candidates.filter((c) => {
    const key = `${c.getSourceFile().getFilePath()}:${c.getStart()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Prefer FunctionDeclaration / MethodDeclaration when the same name appears
  // as both a function and a variable — the function is the truth and the
  // variable is often a re-export shim. If no function/method exists and more
  // than one non-function candidate survives de-duplication, the symbol is
  // genuinely ambiguous and the caller must supply a more specific name.
  const preferredFn = unique.find(
    (c) =>
      c.getKind() === SyntaxKind.FunctionDeclaration ||
      c.getKind() === SyntaxKind.MethodDeclaration,
  );

  if (!preferredFn && unique.length > 1) {
    throw new AstResolverError(
      `Ambiguous symbol: "${namePart}" in ${filePart} resolves to ${unique.length} non-function declarations.`,
      'ambiguous_symbol',
      'Rename one declaration or supply a more specific path.',
    );
  }

  return {
    declaration: preferredFn ?? unique[0],
    declarationFile: filePart,
    declarationName: namePart,
  };
}

/**
 * Walk up from an ObjectLiteralExpression to find the name of the variable
 * or parameter that the object is assigned to. Returns '<Object>' if no
 * named binding is found.
 */
export function resolveObjectLiteralContainerName(objLiteral: Node): string {
  const parent = objLiteral.getParent();
  if (parent?.isKind(SyntaxKind.VariableDeclaration)) {
    return (parent as { getName: () => string }).getName();
  }
  // Object is a call argument, return-value, or nested assignment — unnamed.
  return '<Object>';
}

/**
 * Walk up the AST from a node to find the nearest named enclosing
 * function/method/module scope.
 *
 * Returns one of:
 *   - "fn:<name>"           — named function declaration or arrow assigned to var
 *   - "method:<Class>.<m>"  — class method or object property method
 *   - "moduleTopLevel"      — at module scope (no enclosing function)
 */
export function findEnclosing(node: Node): string {
  let current: Node | undefined = node.getParent();
  while (current) {
    switch (current.getKind()) {
      case SyntaxKind.FunctionDeclaration: {
        const name = (current as FunctionDeclaration).getName();
        return name ? `fn:${name}` : 'fn:<anonymous>';
      }
      case SyntaxKind.MethodDeclaration: {
        const m = current as MethodDeclaration;
        const parent = m.getParent();
        // Class method: parent has getName() and is not an ObjectLiteralExpression.
        const isClassParent =
          parent &&
          'getName' in parent &&
          parent.getKind() !== SyntaxKind.ObjectLiteralExpression;
        const containerName = isClassParent
          ? ((parent as { getName: () => string | undefined }).getName() ??
            '<anonymous>')
          : parent
            ? resolveObjectLiteralContainerName(parent)
            : '<Object>';
        return `method:${containerName}.${m.getName()}`;
      }
      case SyntaxKind.PropertyAssignment: {
        // Arrow function or expression assigned as object property: { foo: () => ... }
        const propName = (current as { getName: () => string }).getName();
        const objLiteral = current.getParent();
        const containerName = objLiteral
          ? resolveObjectLiteralContainerName(objLiteral)
          : '<Object>';
        return `method:${containerName}.${propName}`;
      }
      case SyntaxKind.FunctionExpression:
      case SyntaxKind.ArrowFunction: {
        const parent = current.getParent();
        // Named variable assignment at any scope: const foo = () => {...}
        if (parent?.isKind(SyntaxKind.VariableDeclaration)) {
          return `fn:${(parent as { getName: () => string }).getName()}`;
        }
        // CallExpression argument (callback): xs.map(x => ...), useEffect(() => ...)
        // Walk past the enclosing CallExpression to find the outer named host.
        if (parent?.isKind(SyntaxKind.CallExpression)) {
          // Skip this anonymous arrow and continue walking up from the CallExpression.
          current = parent.getParent();
          continue;
        }
        // PropertyAssignment value: { foo: () => ... }
        // The PropertyAssignment case above will handle it — keep walking up.
        if (parent?.isKind(SyntaxKind.PropertyAssignment)) {
          current = parent;
          continue;
        }
        return 'fn:<anonymous>';
      }
      case SyntaxKind.SourceFile:
        return 'moduleTopLevel';
    }
    current = current.getParent();
  }
  return 'moduleTopLevel';
}

/**
 * Convert an absolute path to a POSIX repo-root-relative path.
 */
export function toRepoRelative(repoRoot: string, absPath: string): string {
  const rel = relative(repoRoot, absPath);
  return rel.split('\\').join('/');
}

// ---------------------------------------------------------------------------
// Barrel walker (shared between dead-exports and reexport-chain)
//
// Given a symbol declared in `sourceFile`, finds every ExportDeclaration in
// the project that re-exports that symbol (one hop). Returns the chain of
// barrel file paths and the count of real importers reachable through those
// barrels.
//
// Self-contained: takes (symbolName, sourceFile, project, repoRoot,
// excludeTests) and returns { chain, reachableImporters, testOnlyImporters }.
// ---------------------------------------------------------------------------

export interface BarrelWalkResult {
  /** Repo-relative paths of barrel files that re-export the symbol. */
  chain: string[];
  /**
   * Number of distinct non-test files that import from those barrels
   * (the "real" consumers found via the barrel hop).
   */
  reachableImporters: number;
  testOnlyImporters: number;
}

/**
 * Canonical test-file path detector.
 *
 * Covers the two most common test directory conventions:
 *   - __tests__/      KH convention (tests at repo root)
 *   - src/__tests__/  Vite / create-vite scaffold convention
 *
 * Also catches /test/ directory segments and the universal .test.ts /
 * .spec.ts suffix patterns that Vitest and Jest both use.
 *
 * Single source of truth — column-reads.ts and column-writes.ts import from
 * here rather than maintaining their own copies.
 */
const TEST_DIR_PREFIXES = ['__tests__/', 'src/__tests__/'];
const TEST_SUFFIX_PATTERNS = [
  '.test.ts',
  '.test.tsx',
  '.spec.ts',
  '.spec.tsx',
] as const;

export function isTestFilePath(relPath: string): boolean {
  return (
    TEST_DIR_PREFIXES.some((p) => relPath.startsWith(p)) ||
    relPath.includes('/test/') ||
    TEST_SUFFIX_PATTERNS.some((s) => relPath.endsWith(s))
  );
}

/**
 * Walk one hop of barrel re-exports from `sourceFile` for the named symbol.
 *
 * - Scans every ExportDeclaration in the project for ones that re-export
 *   from `sourceFile` (either `export { symbolName } from '...'` or
 *   `export * from '...'`).
 * - For each matching barrel, counts importers of that barrel file.
 * - Returns the chain of barrel file paths plus importer counts.
 */
export function walkBarrelChain(
  symbolName: string,
  sourceFile: SourceFile,
  project: Project,
  repoRoot: string,
  excludeTests: boolean,
): BarrelWalkResult {
  const sourceAbsPath = sourceFile.getFilePath();
  const chain: string[] = [];
  let reachableImporters = 0;
  let testOnlyImporters = 0;

  // Find all ExportDeclarations in the project that re-export from sourceFile.
  for (const sf of project.getSourceFiles()) {
    if (sf.getFilePath() === sourceAbsPath) continue;

    const barrelRelPath = toRepoRelative(repoRoot, sf.getFilePath());

    // Check every `export { X } from '...'` or `export * from '...'` in this file.
    const exportDecls: ExportDeclaration[] = sf.getExportDeclarations();
    for (const exportDecl of exportDecls) {
      const moduleSpecifier = exportDecl.getModuleSpecifierSourceFile();
      if (!moduleSpecifier) continue;
      if (moduleSpecifier.getFilePath() !== sourceAbsPath) continue;

      // This file re-exports from our source file.
      // Check whether the specific symbol is re-exported (not just any symbol).
      let exportsOurSymbol = false;

      if (exportDecl.isNamespaceExport()) {
        // `export * from '...'` — all exports are carried through.
        exportsOurSymbol = true;
      } else {
        // `export { X, Y } from '...'`
        const namedExports = exportDecl.getNamedExports();
        exportsOurSymbol = namedExports.some((ne) => {
          // The original name in the source file (before any rename).
          // For `export { foo as bar }`, getName() returns 'foo' (the alias
          // used in the barrel), but getAliasNode()?.getText() is 'bar'.
          // We match on the original source name, which is getName().
          const originalName = ne.getName();
          return originalName === symbolName;
        });
      }

      if (!exportsOurSymbol) continue;

      // This barrel re-exports our symbol. Record it.
      if (!chain.includes(barrelRelPath)) {
        chain.push(barrelRelPath);
      }

      // Now check who imports from this barrel file.
      const barrelAbsPath = sf.getFilePath();
      for (const consumer of project.getSourceFiles()) {
        if (consumer.getFilePath() === barrelAbsPath) continue;
        if (consumer.getFilePath() === sourceAbsPath) continue;

        const consumerRelPath = toRepoRelative(
          repoRoot,
          consumer.getFilePath(),
        );
        const importsBarrel = consumer.getImportDeclarations().some((imp) => {
          const resolved = imp.getModuleSpecifierSourceFile();
          return resolved?.getFilePath() === barrelAbsPath;
        });

        if (!importsBarrel) continue;

        if (isTestFilePath(consumerRelPath)) {
          if (!excludeTests) testOnlyImporters++;
        } else {
          reachableImporters++;
        }
      }
    }
  }

  return { chain, reachableImporters, testOnlyImporters };
}

import { Project, SyntaxKind, type Node } from 'ts-morph';
import type {
  ReferencesArgs,
  ReferenceResult,
  ReferenceKind,
  QueryResponse,
} from '../types';
import { resolveSymbol, findEnclosing, toRepoRelative } from '../resolve';

const DEFAULT_LIMIT = 200;

/**
 * Classify a reference node into one of the six ReferenceKind values.
 *
 * Classification rules (applied in priority order):
 *  1. Inside an `import type { X }` or a `type Y = X` type alias position
 *     where the import declaration is type-only → `typeOnly`
 *  2. TypeReference ancestor → `typeReference`
 *  3. JsxOpeningElement | JsxSelfClosingElement ancestor → `jsxComponent`
 *  4. ExportSpecifier inside a re-export declaration → `reexport`
 *  5. LHS of BinaryExpression (=, +=, …) → `write`
 *  6. Otherwise (RHS, argument, identifier read) → `read`
 */
function classifyKind(node: Node): ReferenceKind {
  // Rule 1: type-only import (`import type { X }`)
  const importDecl = node.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
  if (importDecl?.isTypeOnly()) {
    return 'typeOnly';
  }

  // Rule 2: inside a TypeReference node
  if (node.getFirstAncestorByKind(SyntaxKind.TypeReference)) {
    return 'typeReference';
  }

  // Also handle: the node IS a type-position reference (e.g. return type annotation,
  // parameter type annotation, type alias RHS). Check parent kind.
  const parent = node.getParent();
  if (parent) {
    const parentKind = parent.getKind();
    if (
      parentKind === SyntaxKind.TypeReference ||
      parentKind === SyntaxKind.TypeQuery
    ) {
      return 'typeReference';
    }
  }

  // Rule 3: JSX component reference (opening or self-closing element tag)
  if (
    node.getFirstAncestorByKind(SyntaxKind.JsxOpeningElement) ||
    node.getFirstAncestorByKind(SyntaxKind.JsxSelfClosingElement)
  ) {
    return 'jsxComponent';
  }

  // Rule 4: inside an ExportSpecifier of a re-export (export { X } from '...')
  const exportSpecifier = node.getFirstAncestorByKind(SyntaxKind.ExportSpecifier);
  if (exportSpecifier) {
    const exportDecl = exportSpecifier.getParent();
    // An ExportDeclaration with a module specifier is a re-export.
    if (
      exportDecl?.getKind() === SyntaxKind.ExportDeclaration &&
      (exportDecl as { hasModuleSpecifier?: () => boolean }).hasModuleSpecifier?.()
    ) {
      return 'reexport';
    }
    // Named re-export without `from` still counts as reexport.
    return 'reexport';
  }

  // Rule 5: LHS of a BinaryExpression (assignment)
  if (parent) {
    const parentKind = parent.getKind();
    if (parentKind === SyntaxKind.BinaryExpression) {
      const binExpr = parent as { getLeft: () => Node; getOperatorToken: () => Node };
      const left = binExpr.getLeft();
      if (left === node || left.getStart() === node.getStart()) {
        // Check it's an assignment operator
        const op = binExpr.getOperatorToken().getKind();
        const assignmentOps = new Set([
          SyntaxKind.EqualsToken,
          SyntaxKind.PlusEqualsToken,
          SyntaxKind.MinusEqualsToken,
          SyntaxKind.AsteriskEqualsToken,
          SyntaxKind.SlashEqualsToken,
          SyntaxKind.PercentEqualsToken,
          SyntaxKind.AmpersandEqualsToken,
          SyntaxKind.BarEqualsToken,
          SyntaxKind.CaretEqualsToken,
          SyntaxKind.LessThanLessThanEqualsToken,
          SyntaxKind.GreaterThanGreaterThanEqualsToken,
          SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
          SyntaxKind.AsteriskAsteriskEqualsToken,
          SyntaxKind.QuestionQuestionEqualsToken,
          SyntaxKind.AmpersandAmpersandEqualsToken,
          SyntaxKind.BarBarEqualsToken,
        ]);
        if (assignmentOps.has(op)) {
          return 'write';
        }
      }
    }
  }

  // Rule 6: default — treat as a read
  return 'read';
}

export async function references(
  args: ReferencesArgs,
  project: Project,
  repoRoot: string,
): Promise<QueryResponse<ReferenceResult>> {
  const started = Date.now();
  const limit = args.limit ?? DEFAULT_LIMIT;

  const resolved = resolveSymbol(project, args.symbol, repoRoot);

  const allRefs = resolved.declaration.findReferences();

  const rows: ReferenceResult[] = [];
  let totalEstimated = 0;

  for (const refSym of allRefs) {
    for (const ref of refSym.getReferences()) {
      const node = ref.getNode();
      const sf = node.getSourceFile();
      const isDefinition = ref.isDefinition();

      const kind = classifyKind(node);

      // Apply --kind filter if provided
      if (args.kind && kind !== args.kind) {
        continue;
      }

      totalEstimated++;
      if (rows.length >= limit) continue;

      const lineCol = sf.getLineAndColumnAtPos(node.getStart());

      rows.push({
        file: toRepoRelative(repoRoot, sf.getFilePath()),
        line: lineCol.line,
        column: lineCol.column,
        confidence: 'exact',
        kind,
        enclosing: findEnclosing(node),
        isDefinition,
      });
    }
  }

  return {
    query: 'references',
    args: { ...args, limit },
    results: rows,
    truncated: totalEstimated > rows.length,
    totalEstimated:
      totalEstimated > rows.length ? totalEstimated : undefined,
    durationMs: Date.now() - started,
  };
}

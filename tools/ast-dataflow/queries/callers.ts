import {
  Project,
  SyntaxKind,
  type CallExpression,
  type Node,
} from 'ts-morph';
import type {
  CallersArgs,
  CallSiteResult,
  CallResolution,
  QueryResponse,
} from '../types';
import {
  resolveSymbol,
  findEnclosing,
  toRepoRelative,
  buildErrorResponse,
  AstResolverError,
} from '../resolve';

const DEFAULT_LIMIT = 200;

function classifyResolution(
  identifierNode: Node,
  declarationName: string,
): { resolution: CallResolution; importAlias?: string } {
  // Walk to the import declaration (if any) and check for alias.
  const importer = identifierNode.getSourceFile().getImportDeclarations();
  for (const imp of importer) {
    for (const named of imp.getNamedImports()) {
      const localName = named.getName();
      const aliasNode = named.getAliasNode();
      const aliasName = aliasNode?.getText();
      const referencedName = aliasName ? aliasName : localName;
      const identText = identifierNode.getText();
      if (referencedName === identText) {
        if (aliasName && aliasName !== localName) {
          return { resolution: 'aliased', importAlias: aliasName };
        }
        return { resolution: 'direct' };
      }
    }
  }
  // No import match — could be same-file or namespace access; treat as direct.
  if (identifierNode.getText() !== declarationName) {
    return { resolution: 'indirect' };
  }
  return { resolution: 'direct' };
}

export async function callers(
  args: CallersArgs,
  project: Project,
  repoRoot: string,
): Promise<QueryResponse<CallSiteResult>> {
  const started = Date.now();
  const limit = args.limit ?? DEFAULT_LIMIT;

  // Validate and resolve the symbol — return structured error on failure (P-29).
  const sep = args.symbol.lastIndexOf(':');
  if (sep === -1 || !args.symbol.slice(0, sep) || !args.symbol.slice(sep + 1)) {
    return buildErrorResponse(
      'callers',
      { ...args, limit },
      'parse_error',
      `Symbol must be "<file>:<name>"; got "${args.symbol}". Example: "lib/supabase/safe.ts:sb".`,
      'Use the format <relative-file-path>:<exported-name>.',
      Date.now() - started,
    );
  }

  let resolved: ReturnType<typeof resolveSymbol>;
  try {
    resolved = resolveSymbol(project, args.symbol, repoRoot);
  } catch (err) {
    if (err instanceof AstResolverError) {
      return buildErrorResponse(
        'callers',
        { ...args, limit },
        err.code,
        err.message,
        err.hint,
        Date.now() - started,
      );
    }
    throw err;
  }

  const references = resolved.declaration.findReferences();

  const rows: CallSiteResult[] = [];
  let totalEstimated = 0;

  for (const refSym of references) {
    for (const ref of refSym.getReferences()) {
      if (ref.isDefinition()) continue;

      const node = ref.getNode();
      const callExpr = findCallExpression(node);
      if (!callExpr) continue;

      totalEstimated++;
      if (rows.length >= limit) continue;

      const sf = node.getSourceFile();
      const lineCol = sf.getLineAndColumnAtPos(node.getStart());
      const { resolution, importAlias } = classifyResolution(
        node,
        resolved.declarationName,
      );
      rows.push({
        file: toRepoRelative(repoRoot, sf.getFilePath()),
        line: lineCol.line,
        column: lineCol.column,
        confidence: 'exact',
        enclosing: findEnclosing(node),
        resolution,
        ...(importAlias ? { importAlias } : {}),
      });
    }
  }

  return {
    query: 'callers',
    args: { ...args, limit },
    results: rows,
    truncated: totalEstimated > rows.length,
    totalEstimated:
      totalEstimated > rows.length ? totalEstimated : undefined,
    durationMs: Date.now() - started,
  };
}

function findCallExpression(identifierNode: Node): CallExpression | null {
  // The identifier appears as the expression child of a CallExpression
  // when it is a callee, e.g. `sb(...)` — `sb` is the expression of the call.
  // Walk parents until we find a CallExpression whose expression is THIS node
  // (or a chain ending in this node).
  let current: Node | undefined = identifierNode.getParent();
  while (current) {
    if (current.getKind() === SyntaxKind.CallExpression) {
      const ce = current as CallExpression;
      // The identifier must be the callee, not an argument.
      if (
        ce
          .getExpression()
          .getDescendantsOfKind(SyntaxKind.Identifier)
          .some((id) => id === identifierNode) ||
        ce.getExpression() === identifierNode
      ) {
        return ce;
      }
      return null;
    }
    // PropertyAccessExpression is part of a chain like `obj.fn(…)` — keep walking up.
    if (current.getKind() !== SyntaxKind.PropertyAccessExpression) {
      return null;
    }
    current = current.getParent();
  }
  return null;
}

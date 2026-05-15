import { relative, resolve, isAbsolute } from 'node:path';
import {
  Project,
  SyntaxKind,
  type CallExpression,
  type FunctionDeclaration,
  type MethodDeclaration,
  type Node,
  type ReferenceFindableNode,
} from 'ts-morph';
import type {
  CallersArgs,
  CallSiteResult,
  CallResolution,
  QueryResponse,
} from './types';

const DEFAULT_LIMIT = 200;

interface ResolvedSymbol {
  declaration: ReferenceFindableNode & Node;
  declarationFile: string;
  declarationName: string;
}

/**
 * Resolve a symbol identifier of the shape "<relative-file-path>:<name>".
 * Example: "lib/supabase/safe.ts:sb".
 * Throws if file is not in the project or no exported declaration matches.
 */
function resolveSymbol(
  project: Project,
  symbol: string,
  repoRoot: string,
): ResolvedSymbol {
  const sep = symbol.lastIndexOf(':');
  if (sep === -1) {
    throw new Error(
      `Symbol must be "<file>:<name>"; got "${symbol}". Example: "lib/supabase/safe.ts:sb".`,
    );
  }
  const filePart = symbol.slice(0, sep);
  const namePart = symbol.slice(sep + 1);
  if (!filePart || !namePart) {
    throw new Error(`Empty file or name in symbol "${symbol}".`);
  }

  const absPath = isAbsolute(filePart) ? filePart : resolve(repoRoot, filePart);

  const sf = project.getSourceFile(absPath);
  if (!sf) {
    throw new Error(`File not in project: ${filePart}`);
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
    throw new Error(
      `Symbol "${namePart}" not found in ${filePart}. Looked at functions, classes, methods, variables, and named exports.`,
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

  // Prefer FunctionDeclaration / MethodDeclaration over VariableDeclaration
  // when the same name appears as both (the function is the truth; the
  // variable may be a re-export shim).
  const preferred =
    unique.find(
      (c) =>
        c.getKind() === SyntaxKind.FunctionDeclaration ||
        c.getKind() === SyntaxKind.MethodDeclaration,
    ) ?? unique[0];

  return {
    declaration: preferred,
    declarationFile: filePart,
    declarationName: namePart,
  };
}

/**
 * Walk up from an ObjectLiteralExpression to find the name of the variable
 * or parameter that the object is assigned to. Returns '<Object>' if no
 * named binding is found.
 */
function resolveObjectLiteralContainerName(objLiteral: Node): string {
  const parent = objLiteral.getParent();
  if (parent?.isKind(SyntaxKind.VariableDeclaration)) {
    return (parent as { getName: () => string }).getName();
  }
  // Object is a call argument, return-value, or nested assignment — unnamed.
  return '<Object>';
}

function findEnclosing(node: Node): string {
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
        const isClassParent = parent && 'getName' in parent &&
          parent.getKind() !== SyntaxKind.ObjectLiteralExpression;
        const containerName = isClassParent
          ? ((parent as { getName: () => string | undefined }).getName() ?? '<anonymous>')
          : (parent ? resolveObjectLiteralContainerName(parent) : '<Object>');
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

  const resolved = resolveSymbol(project, args.symbol, repoRoot);

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

function toRepoRelative(repoRoot: string, absPath: string): string {
  const rel = relative(repoRoot, absPath);
  return rel.split('\\').join('/');
}

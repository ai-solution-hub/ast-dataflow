import { isAbsolute, relative } from 'node:path';
import {
  Node,
  SyntaxKind,
  type CallExpression,
  type NewExpression,
  type Project,
  type SourceFile,
} from 'ts-morph';
import type {
  CalleeCallKind,
  CalleeResult,
  CalleesArgs,
  CalleesResponse,
  CallResolution,
  Confidence,
} from '../types';
import {
  AstResolverError,
  buildErrorResponse,
  findEnclosing,
  resolveSymbol,
  toRepoRelative,
} from '../resolve';
import { truncateSpatial } from '../truncate';

const DEFAULT_LIMIT = 200;

const NOT_CALLABLE_HINT =
  'callees requires a function, method, arrow-function variable, or class; use references for non-callable symbols';

const BODYLESS_HINT =
  'The declaration is an overload signature or ambient declaration with no body; point the symbol at the implementation instead.';

/**
 * Unwrap wrapper expressions that sit between a node and the expression that
 * matters for resolution: `x!`, `(x)`, `x as T`, `x satisfies T`.
 */
function unwrapExpression(node: Node | undefined): Node | undefined {
  let current = node;
  while (
    current &&
    (current.isKind(SyntaxKind.NonNullExpression) ||
      current.isKind(SyntaxKind.ParenthesizedExpression) ||
      current.isKind(SyntaxKind.AsExpression) ||
      current.isKind(SyntaxKind.SatisfiesExpression))
  ) {
    current = current.getExpression();
  }
  return current;
}

type BodyCollection =
  | { outcome: 'ok'; bodies: Node[] }
  | { outcome: 'not_callable' }
  | { outcome: 'bodyless' };

/**
 * Locate the body (or bodies, for a class) of the subject declaration.
 * Mirrors the shape table in fixQueries.md §A step 2.
 */
function collectBodies(decl: Node): BodyCollection {
  const kind = decl.getKind();

  if (
    kind === SyntaxKind.FunctionDeclaration ||
    kind === SyntaxKind.MethodDeclaration ||
    kind === SyntaxKind.FunctionExpression ||
    kind === SyntaxKind.ArrowFunction
  ) {
    const body =
      Node.isBodyable(decl) || Node.isBodied(decl) ? decl.getBody() : undefined;
    if (body) return { outcome: 'ok', bodies: [body] };
    // Overload signature or ambient declaration — fall through to the
    // implementation when one exists.
    const impl = Node.isOverloadable(decl) ? decl.getImplementation() : undefined;
    const implBody =
      impl && (Node.isBodyable(impl) || Node.isBodied(impl))
        ? impl.getBody()
        : undefined;
    return implBody
      ? { outcome: 'ok', bodies: [implBody] }
      : { outcome: 'bodyless' };
  }

  if (kind === SyntaxKind.VariableDeclaration) {
    const vd = decl.asKindOrThrow(SyntaxKind.VariableDeclaration);
    const init = unwrapExpression(vd.getInitializer());
    if (
      init &&
      (init.isKind(SyntaxKind.ArrowFunction) ||
        init.isKind(SyntaxKind.FunctionExpression))
    ) {
      return { outcome: 'ok', bodies: [init.getBody()] };
    }
    return { outcome: 'not_callable' };
  }

  if (kind === SyntaxKind.ClassDeclaration) {
    const cls = decl.asKindOrThrow(SyntaxKind.ClassDeclaration);
    const bodies: Node[] = [];
    for (const ctor of cls.getConstructors()) {
      const b = ctor.getBody();
      if (b) bodies.push(b);
    }
    for (const m of cls.getMethods()) {
      const b = m.getBody();
      if (b) bodies.push(b);
    }
    for (const sb of cls.getStaticBlocks()) {
      bodies.push(sb.getBody());
    }
    return { outcome: 'ok', bodies };
  }

  return { outcome: 'not_callable' };
}

/**
 * A declaration is external when its source file lives outside the tsconfig
 * corpus (node_modules or the TypeScript lib .d.ts files). External rows must
 * never carry their path (PRODUCT.md inv 16).
 */
function isExternalDeclaration(declSf: SourceFile, repoRoot: string): boolean {
  if (declSf.isInNodeModules() || declSf.isFromExternalLibrary()) return true;
  const rel = relative(repoRoot, declSf.getFilePath());
  return rel.startsWith('..') || isAbsolute(rel);
}

interface ResolvedCallee {
  calleeName: string;
  callKind: CalleeCallKind;
  resolution: CallResolution;
  importAlias?: string;
  confidence: Confidence;
  /** Undefined ⇒ unresolved (confidence 'indirect', null callee positions). */
  decl?: Node;
}

/**
 * Classify by the (post-alias) declaration kind — the "declaration kind
 * decides" table in fixQueries.md §A step 5.
 */
function classifyByDeclaration(decl: Node): CallResolution {
  switch (decl.getKind()) {
    case SyntaxKind.BindingElement:
      return 'destructured';
    case SyntaxKind.Parameter:
      return 'indirect';
    case SyntaxKind.VariableDeclaration: {
      const init = unwrapExpression(
        decl.asKindOrThrow(SyntaxKind.VariableDeclaration).getInitializer(),
      );
      // Inline `const f = () => {}` IS the function; a variable holding a
      // function reference is PRODUCT's 'indirect'.
      return init &&
        (init.isKind(SyntaxKind.ArrowFunction) ||
          init.isKind(SyntaxKind.FunctionExpression))
        ? 'direct'
        : 'indirect';
    }
    default:
      return 'direct';
  }
}

/** Resolve a name-bearing callee node symbol-first, aliases unwrapped. */
function resolveByName(
  nameNode: Node,
  fallbackTypeSource: Node,
): { decl?: Node; resolution: CallResolution; importAlias?: string } {
  const sym = nameNode.getSymbol();
  if (sym) {
    const aliased = sym.getAliasedSymbol();
    const bindingDecl = sym.getDeclarations()[0];
    const targetDecl = (aliased ?? sym).getDeclarations()[0];
    if (!targetDecl) return { resolution: 'indirect' };
    if (bindingDecl?.isKind(SyntaxKind.ImportSpecifier)) {
      const aliasNode = bindingDecl.getAliasNode();
      if (aliasNode) {
        return {
          decl: targetDecl,
          resolution: 'aliased',
          importAlias: aliasNode.getText(),
        };
      }
    }
    return { decl: targetDecl, resolution: classifyByDeclaration(targetDecl) };
  }
  // Type-first fallback (the flow-trace descendIntoCallee path) — catches
  // some inferred-callable cases the name-symbol path misses.
  const calleeType = fallbackTypeSource.getType();
  const typeSym = calleeType.getSymbol() ?? calleeType.getAliasSymbol();
  const decl = typeSym?.getDeclarations()[0];
  return decl ? { decl, resolution: 'indirect' } : { resolution: 'indirect' };
}

function resolveCallee(callExpr: CallExpression | NewExpression): ResolvedCallee {
  const isNew = callExpr.getKind() === SyntaxKind.NewExpression;
  const expr = unwrapExpression(callExpr.getExpression());
  const baseKind: CalleeCallKind = isNew ? 'new' : 'call';

  if (!expr) {
    return {
      calleeName: '<computed>',
      callKind: baseKind,
      resolution: 'indirect',
      confidence: 'indirect',
    };
  }

  // IIFE: the callee is the inline function itself.
  if (
    expr.isKind(SyntaxKind.ArrowFunction) ||
    expr.isKind(SyntaxKind.FunctionExpression)
  ) {
    return {
      calleeName: '<anonymous>',
      callKind: baseKind,
      resolution: 'direct',
      confidence: 'exact',
      decl: expr,
    };
  }

  if (expr.isKind(SyntaxKind.Identifier)) {
    const resolved = resolveByName(expr, expr);
    return {
      calleeName: expr.getText(),
      callKind: baseKind,
      resolution: resolved.resolution,
      ...(resolved.importAlias ? { importAlias: resolved.importAlias } : {}),
      confidence: resolved.decl ? 'exact' : 'indirect',
      ...(resolved.decl ? { decl: resolved.decl } : {}),
    };
  }

  if (expr.isKind(SyntaxKind.PropertyAccessExpression)) {
    const receiverKind = expr.getExpression().getKind();
    const callKind: CalleeCallKind = isNew
      ? 'new'
      : receiverKind === SyntaxKind.SuperKeyword
        ? 'super'
        : receiverKind === SyntaxKind.ThisKeyword
          ? 'thisMethod'
          : 'call';
    const nameNode = expr.getNameNode();
    const resolved = resolveByName(nameNode, expr);
    return {
      calleeName: nameNode.getText(),
      callKind,
      resolution: resolved.resolution,
      ...(resolved.importAlias ? { importAlias: resolved.importAlias } : {}),
      confidence: resolved.decl ? 'exact' : 'indirect',
      ...(resolved.decl ? { decl: resolved.decl } : {}),
    };
  }

  if (expr.isKind(SyntaxKind.ElementAccessExpression)) {
    // `obj[key]()` — only a string/enum-literal key can still resolve a
    // symbol; a dynamic key is reported (never dropped) as unresolved.
    const arg = expr.getArgumentExpression();
    const isLiteralKey =
      arg !== undefined &&
      (arg.isKind(SyntaxKind.StringLiteral) ||
        arg.isKind(SyntaxKind.NoSubstitutionTemplateLiteral) ||
        arg.isKind(SyntaxKind.PropertyAccessExpression));
    const sym = isLiteralKey ? expr.getSymbol() : undefined;
    const decl = sym
      ? (sym.getAliasedSymbol() ?? sym).getDeclarations()[0]
      : undefined;
    return {
      calleeName: decl && sym ? sym.getName() : '<computed>',
      callKind: baseKind,
      resolution: 'computed-property',
      confidence: decl ? 'exact' : 'indirect',
      ...(decl ? { decl } : {}),
    };
  }

  // Anything else (`f()()`, bare `super(...)`, conditional callee, …):
  // try the type-first path; report rather than drop.
  const calleeType = expr.getType();
  const typeSym = calleeType.getSymbol() ?? calleeType.getAliasSymbol();
  const decl = typeSym?.getDeclarations()[0];
  return {
    calleeName: '<computed>',
    callKind: expr.isKind(SyntaxKind.SuperKeyword) ? 'super' : baseKind,
    resolution: 'indirect',
    confidence: decl ? 'exact' : 'indirect',
    ...(decl ? { decl } : {}),
  };
}

export async function callees(
  args: CalleesArgs,
  project: Project,
  repoRoot: string,
): Promise<CalleesResponse> {
  const started = Date.now();
  const limit = args.limit ?? DEFAULT_LIMIT;
  const includeExternal = args.includeExternal ?? false;

  let resolved: ReturnType<typeof resolveSymbol>;
  try {
    resolved = resolveSymbol(project, args.symbol, repoRoot);
  } catch (err) {
    if (err instanceof AstResolverError) {
      return {
        ...buildErrorResponse<CalleeResult>(
          'callees',
          { ...args, limit },
          err.code,
          err.message,
          err.hint,
          Date.now() - started,
        ),
        externalCount: 0,
      };
    }
    throw err;
  }

  const collected = collectBodies(resolved.declaration);
  if (collected.outcome !== 'ok') {
    const message =
      collected.outcome === 'bodyless'
        ? `Symbol "${resolved.declarationName}" in ${resolved.declarationFile} has no body (${resolved.declaration.getKindName()}).`
        : `Symbol "${resolved.declarationName}" in ${resolved.declarationFile} is not callable (${resolved.declaration.getKindName()}).`;
    return {
      ...buildErrorResponse<CalleeResult>(
        'callees',
        { ...args, limit },
        'not_callable',
        message,
        collected.outcome === 'bodyless' ? BODYLESS_HINT : NOT_CALLABLE_HINT,
        Date.now() - started,
      ),
      externalCount: 0,
    };
  }

  // Descendant enumeration inherently includes calls inside nested closures.
  const callSites: (CallExpression | NewExpression)[] = [];
  for (const body of collected.bodies) {
    // An arrow's expression body can itself BE the call (`() => g()`), and
    // getDescendantsOfKind excludes the node itself.
    if (
      body.isKind(SyntaxKind.CallExpression) ||
      body.isKind(SyntaxKind.NewExpression)
    ) {
      callSites.push(body);
    }
    callSites.push(
      ...body.getDescendantsOfKind(SyntaxKind.CallExpression),
      ...body.getDescendantsOfKind(SyntaxKind.NewExpression),
    );
  }
  callSites.sort((a, b) => a.getStart() - b.getStart());

  const rows: CalleeResult[] = [];
  let externalCount = 0;

  for (const callExpr of callSites) {
    const c = resolveCallee(callExpr);

    let decl = c.decl;
    let calleeFile: string | null = null;
    let calleeLine: number | null = null;
    let external = false;

    if (decl) {
      // `new Widget()` runs the constructor — prefer it when present.
      if (c.callKind === 'new' && decl.isKind(SyntaxKind.ClassDeclaration)) {
        decl = decl.getConstructors()[0] ?? decl;
      }
      const declSf = decl.getSourceFile();
      if (isExternalDeclaration(declSf, repoRoot)) {
        external = true;
      } else {
        calleeFile = toRepoRelative(repoRoot, declSf.getFilePath());
        calleeLine = declSf.getLineAndColumnAtPos(decl.getStart()).line;
      }
    }

    if (external) {
      externalCount++;
      if (!includeExternal) continue;
    }

    const sf = callExpr.getSourceFile();
    const lineCol = sf.getLineAndColumnAtPos(callExpr.getStart());
    rows.push({
      file: toRepoRelative(repoRoot, sf.getFilePath()),
      line: lineCol.line,
      column: lineCol.column,
      confidence: c.confidence,
      enclosing: findEnclosing(callExpr),
      calleeName: c.calleeName,
      callKind: c.callKind,
      resolution: c.resolution,
      ...(c.importAlias ? { importAlias: c.importAlias } : {}),
      callee: { file: calleeFile, line: calleeLine },
      ...(external ? { external: true as const } : {}),
    });
  }

  const t = truncateSpatial(rows, limit);
  return {
    query: 'callees',
    args: { ...args, limit },
    results: t.rows,
    truncated: t.truncated,
    totalEstimated: t.totalEstimated,
    externalCount,
    durationMs: Date.now() - started,
  };
}

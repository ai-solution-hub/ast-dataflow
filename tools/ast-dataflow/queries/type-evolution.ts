import { type Project, SyntaxKind, type Node } from 'ts-morph';
import type {
  TypeEvolutionArgs,
  TypeEvolutionResult,
  TypeEvolutionKind,
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

/**
 * Return true if `possibleAncestor` contains `node` by position range.
 * Used instead of isAncestorOf() since Node typings vary across ts-morph versions.
 */
function containsNode(possibleAncestor: Node, node: Node): boolean {
  return (
    possibleAncestor.getStart() <= node.getStart() &&
    possibleAncestor.getEnd() >= node.getEnd()
  );
}

/**
 * Classify a reference node's TypeEvolutionKind from the AST context it
 * appears in. Returns null if the reference does not match a known kind
 * (e.g. the declaration site itself — callers should check isDefinition).
 *
 * Priority order (first match wins):
 *  1. Inside a SatisfiesExpression's type position → 'satisfies'
 *  2. Inside TypeArguments → 'generic'
 *  3. Inside a function return-type annotation → 'returnType'
 *  4. Inside a Parameter type annotation → 'annotation'
 *  5. Any other TypeReference ancestor → 'annotation'
 */
function classifyTypeRefKind(node: Node): TypeEvolutionKind | null {
  // Walk up ancestry once to find the nearest meaningful kind.
  // We collect the ancestry chain and scan it.
  const ancestors: Node[] = [];
  let cur: Node | undefined = node.getParent();
  while (cur) {
    ancestors.push(cur);
    cur = cur.getParent();
  }

  // Rule 1: satisfies clause
  // In the AST: SatisfiesExpression { expression, type }
  // The type node is at position AFTER the `satisfies` keyword.
  for (const ancestor of ancestors) {
    if (ancestor.getKind() === SyntaxKind.SatisfiesExpression) {
      // The node is inside the satisfies expression.
      // Check if it's in the type position (right side), not the expression (left side).
      // The children are: [expression, SatisfiesKeyword, typeNode]
      const children = ancestor.getChildren();
      // typeNode is the last child
      const typeChild = children[children.length - 1];
      if (typeChild && containsNode(typeChild, node)) {
        return 'satisfies';
      }
      // If the node is a TypeReference directly under SatisfiesExpression it's the type
      const parent = node.getParent();
      if (parent?.getKind() === SyntaxKind.SatisfiesExpression) {
        return 'satisfies';
      }
      break;
    }
  }

  // Rule 2: generic — inside TypeArguments OR inside a nested TypeReference
  // that is itself a child of another TypeReference (e.g. Array<TargetType>).
  // In ts-morph, Array<TargetType> has the structure:
  //   TypeReference(Array<TargetType>)
  //     └─ TypeReference(TargetType)   ← our node's parent
  // There is no explicit TypeArguments wrapper node in this representation.
  for (const ancestor of ancestors) {
    if (ancestor.getKind() === SyntaxKind.TypeArguments) {
      return 'generic';
    }
    // Detect nested TypeReference inside another TypeReference
    if (ancestor.getKind() === SyntaxKind.TypeReference) {
      const typeRefParent = ancestor.getParent();
      if (typeRefParent?.getKind() === SyntaxKind.TypeReference) {
        return 'generic';
      }
    }
  }

  // Rule 3: return type — check if our node is inside the return type annotation
  // of the nearest enclosing function-like node.
  for (const ancestor of ancestors) {
    const kind = ancestor.getKind();
    const isFunctionLike =
      kind === SyntaxKind.FunctionDeclaration ||
      kind === SyntaxKind.FunctionExpression ||
      kind === SyntaxKind.ArrowFunction ||
      kind === SyntaxKind.MethodDeclaration;

    if (isFunctionLike) {
      // Get the return type node from the function-like node.
      const fn = ancestor as { getReturnTypeNode?: () => Node | undefined };
      const returnTypeNode = fn.getReturnTypeNode?.();

      if (returnTypeNode && containsNode(returnTypeNode, node)) {
        return 'returnType';
      }

      // If we're inside this function-like but NOT in the return type,
      // check if we're in a parameter.
      break;
    }
  }

  // Rule 4: parameter type annotation
  for (const ancestor of ancestors) {
    if (ancestor.getKind() === SyntaxKind.Parameter) {
      return 'annotation';
    }
  }

  // Rule 5: any other TypeReference (variable annotation, type alias, etc.)
  for (const ancestor of ancestors) {
    if (ancestor.getKind() === SyntaxKind.TypeReference) {
      return 'annotation';
    }
  }

  return null;
}

/**
 * Determine whether a node is in a type-only position (no runtime existence).
 *
 * Type-only positions:
 *  - Inside a TypeReference (the type annotation itself — not a runtime value)
 *  - A `satisfies` clause type position (the type after `satisfies` is erased at runtime)
 *  - Inside an `import type` declaration
 *
 * Runtime positions (isTypeOnly = false):
 *  - PropertyAccessExpression (x.prop — value at runtime)
 *  - BindingElement in ObjectBindingPattern (const { prop } = x — runtime destructure)
 */
function isTypeOnlyPosition(node: Node): boolean {
  // import type { X }
  const importDecl = node.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
  if (importDecl?.isTypeOnly()) return true;

  // Inside a type annotation (TypeReference, TypeArguments, etc.)
  if (node.getFirstAncestorByKind(SyntaxKind.TypeReference)) return true;
  if (node.getFirstAncestorByKind(SyntaxKind.TypeArguments)) return true;

  // SatisfiesExpression — only the type part is type-only
  const satisfies = node.getFirstAncestorByKind(SyntaxKind.SatisfiesExpression);
  if (satisfies) {
    // The children are: [expression, SatisfiesKeyword, typeNode]
    const children = satisfies.getChildren();
    const typeChild = children[children.length - 1];
    if (typeChild && containsNode(typeChild, node)) {
      return true;
    }
    // Direct parent is SatisfiesExpression (node IS the type reference)
    if (node.getParent()?.getKind() === SyntaxKind.SatisfiesExpression) {
      return true;
    }
  }

  return false;
}

/**
 * Find all property accesses (obj.property) where:
 * 1. The object expression's type is (or resolves to) typeName.
 * 2. The property name matches the given propertyName.
 *
 * Also finds destructuring of the form: const { property } = obj (where obj: T).
 */
function findPropertySites(
  project: Project,
  typeName: string,
  propertyName: string,
  limit: number,
): Array<{ node: Node; kind: 'propertyAccess' | 'destructuring' }> {
  const results: Array<{
    node: Node;
    kind: 'propertyAccess' | 'destructuring';
  }> = [];
  const checker = project.getTypeChecker();

  for (const sf of project.getSourceFiles()) {
    if (results.length >= limit) break;

    // Scan PropertyAccessExpression nodes: obj.prop
    for (const pa of sf.getDescendantsOfKind(
      SyntaxKind.PropertyAccessExpression,
    )) {
      if (results.length >= limit) break;
      const propName = pa.getName();
      if (propName !== propertyName) continue;

      const objExpr = pa.getExpression();
      const objType = checker.getTypeAtLocation(objExpr);
      const typeText = objType.getText();

      if (matchesTypeName(typeText, typeName)) {
        results.push({ node: pa, kind: 'propertyAccess' });
      }
    }

    // Scan ObjectBindingPatterns: const { prop } = x
    for (const obp of sf.getDescendantsOfKind(
      SyntaxKind.ObjectBindingPattern,
    )) {
      if (results.length >= limit) break;

      const elements = obp.getElements();
      const matchingEl = elements.find((el) => el.getName() === propertyName);
      if (!matchingEl) continue;

      // Get the type of the binding pattern source
      const parent = obp.getParent();
      let typeText = '';

      if (parent?.getKind() === SyntaxKind.VariableDeclaration) {
        const vd = parent as import('ts-morph').VariableDeclaration;
        // Check the declared type annotation first
        const typeAnnotation = vd.getTypeNode();
        if (typeAnnotation) {
          typeText = typeAnnotation.getText();
        }
        // Also check the initialiser's inferred type
        if (!matchesTypeName(typeText, typeName)) {
          const initializer = vd.getInitializer();
          if (initializer) {
            typeText = checker.getTypeAtLocation(initializer).getText();
          }
        }
      } else if (parent?.getKind() === SyntaxKind.Parameter) {
        // function f({ prop }: TargetType)
        const param = parent as import('ts-morph').ParameterDeclaration;
        const paramTypeNode = param.getTypeNode();
        if (paramTypeNode) {
          typeText = paramTypeNode.getText();
        }
        if (!matchesTypeName(typeText, typeName)) {
          typeText = checker.getTypeAtLocation(parent).getText();
        }
      }

      if (typeText && matchesTypeName(typeText, typeName)) {
        results.push({ node: matchingEl, kind: 'destructuring' });
      }
    }
  }

  return results;
}

/**
 * Check whether a type text string references the given type name.
 * Uses a word-boundary regex so "TargetType" matches "TargetType",
 * "Array<TargetType>", "Promise<TargetType>", but NOT "OtherTargetType".
 */
function matchesTypeName(typeText: string, typeName: string): boolean {
  const regex = new RegExp(`\\b${escapeRegex(typeName)}\\b`);
  return regex.test(typeText);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function typeEvolution(
  args: TypeEvolutionArgs,
  project: Project,
  repoRoot: string,
): Promise<QueryResponse<TypeEvolutionResult>> {
  const started = Date.now();
  const limit = args.limit ?? DEFAULT_LIMIT;

  let resolved: ReturnType<typeof resolveSymbol>;

  if (args.file) {
    // File explicitly provided: use resolveSymbol directly.
    try {
      resolved = resolveSymbol(project, `${args.file}:${args.type}`, repoRoot);
    } catch (err) {
      if (err instanceof AstResolverError) {
        return buildErrorResponse<TypeEvolutionResult>(
          'type-evolution',
          { ...args, limit },
          err.code,
          err.message,
          err.hint,
          Date.now() - started,
        );
      }
      throw err;
    }
  } else {
    // No file provided: search all source files for the type declaration.
    let found: ReturnType<typeof resolveSymbol> | null = null;
    for (const sf of project.getSourceFiles()) {
      const exported = sf.getExportedDeclarations().get(args.type);
      if (exported && exported.length > 0) {
        const decl = exported[0];
        if ('findReferences' in decl) {
          found = {
            declaration:
              decl as import('../resolve').ResolvedSymbol['declaration'],
            declarationFile: toRepoRelative(repoRoot, sf.getFilePath()),
            declarationName: args.type,
          };
          break;
        }
      }
    }

    if (!found) {
      return buildErrorResponse<TypeEvolutionResult>(
        'type-evolution',
        { ...args, limit },
        'out_of_corpus',
        `Type "${args.type}" not found as an exported declaration in any source file.`,
        'Provide a --file flag to narrow the search, or verify the type is exported.',
        Date.now() - started,
      );
    }
    resolved = found;
  }

  const rows: TypeEvolutionResult[] = [];
  let totalEstimated = 0;

  // Phase 1: Walk all references to the type symbol.
  // These give us annotation, returnType, generic, satisfies kind references.
  const allRefs = resolved.declaration.findReferences();

  for (const refSym of allRefs) {
    for (const ref of refSym.getReferences()) {
      const node = ref.getNode();
      const sf = node.getSourceFile();
      const isDefinition = ref.isDefinition();

      if (isDefinition) continue; // skip declaration site

      const kind = classifyTypeRefKind(node);
      if (kind === null) continue; // unclassifiable

      totalEstimated++;
      if (rows.length >= limit) continue;

      const lineCol = sf.getLineAndColumnAtPos(node.getStart());
      rows.push({
        file: toRepoRelative(repoRoot, sf.getFilePath()),
        line: lineCol.line,
        column: lineCol.column,
        confidence: 'exact',
        kind,
        isTypeOnly: isTypeOnlyPosition(node),
        enclosing: findEnclosing(node),
      });
    }
  }

  // Phase 2: Find property access and destructuring sites for the named property.
  // These are the runtime sites where obj.property or const { property } = obj
  // appears with the obj typed as our target type.
  const propertySites = findPropertySites(
    project,
    args.type,
    args.property,
    limit,
  );

  for (const { node, kind } of propertySites) {
    totalEstimated++;
    if (rows.length >= limit) continue;

    const sf = node.getSourceFile();
    const lineCol = sf.getLineAndColumnAtPos(node.getStart());
    rows.push({
      file: toRepoRelative(repoRoot, sf.getFilePath()),
      line: lineCol.line,
      column: lineCol.column,
      confidence: 'exact',
      kind,
      isTypeOnly: false, // runtime access — never type-only
      enclosing: findEnclosing(node),
    });
  }

  return {
    query: 'type-evolution',
    args: { ...args, limit },
    results: rows,
    truncated: totalEstimated > rows.length,
    totalEstimated: totalEstimated > rows.length ? totalEstimated : undefined,
    durationMs: Date.now() - started,
  };
}

import { Project, SyntaxKind, type Node, type SourceFile } from 'ts-morph';
import type {
  EnumUsesArgs,
  EnumUseKind,
  EnumUseResult,
  QueryResponse,
} from '../types';
import { findEnclosing, toRepoRelative, buildErrorResponse } from '../resolve';

const DEFAULT_LIMIT = 200;

/**
 * Determine whether a node is in a type-position context.
 *
 * Returns true for:
 *  - TypeReference ancestor
 *  - TypeAnnotation (parameter type, variable type, property type)
 *  - TypeAliasDeclaration RHS
 *  - Generic type argument
 */
function isTypePosition(node: Node): boolean {
  // Inside a TypeReference node
  if (node.getFirstAncestorByKind(SyntaxKind.TypeReference)) {
    return true;
  }
  // Direct parent is a type-reference-like node
  const parent = node.getParent();
  if (parent) {
    const parentKind = parent.getKind();
    if (
      parentKind === SyntaxKind.TypeReference ||
      parentKind === SyntaxKind.TypeQuery ||
      parentKind === SyntaxKind.TypeAliasDeclaration
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Find all EnumDeclarations in the project with the given name.
 */
function findEnumDeclarations(project: Project, enumName: string) {
  const results: {
    sf: SourceFile;
    node: Node;
  }[] = [];

  for (const sf of project.getSourceFiles()) {
    for (const enumDecl of sf.getEnums()) {
      if (enumDecl.getName() === enumName) {
        results.push({ sf, node: enumDecl });
      }
    }
  }
  return results;
}

/**
 * Find every site that references a TypeScript enum or one of its members.
 *
 * Emits three kinds of row:
 *  - declaration  — the enum declaration and each member declaration.
 *  - memberAccess — PropertyAccessExpression sites (E.MEMBER).
 *  - typePosition — type-annotation sites (x: E, fn(): E, Array<E>).
 *
 * When `args.member` is supplied, memberAccess rows are filtered to that
 * member only, and type-position rows are dropped (they reference the whole
 * enum, not a specific member). The enum-level declaration row is always emitted.
 */
export async function enumUses(
  args: EnumUsesArgs,
  project: Project,
  repoRoot: string,
): Promise<QueryResponse<EnumUseResult>> {
  const started = Date.now();
  const limit = args.limit ?? DEFAULT_LIMIT;
  const enumName = args.enum;
  const memberFilter = args.member;

  // Validate: enum name must be non-empty
  if (!enumName || !enumName.trim()) {
    return buildErrorResponse<EnumUseResult>(
      'enum-uses',
      { ...args, limit },
      'parse_error',
      'The `enum` argument must not be empty.',
      'Provide the TypeScript enum name to probe, e.g. --enum OrderStatus.',
      Date.now() - started,
    );
  }

  // Find the enum declaration(s) across the project
  const enumDecls = findEnumDeclarations(project, enumName);

  if (enumDecls.length === 0) {
    return buildErrorResponse<EnumUseResult>(
      'enum-uses',
      { ...args, limit },
      'out_of_corpus',
      `Enum "${enumName}" not found in any file in the project corpus.`,
      'Verify the enum name is correct and declared in a file included by tsconfig.json.',
      Date.now() - started,
    );
  }

  const rows: EnumUseResult[] = [];
  let totalEstimated = 0;

  // Process each enum declaration (handles the case of multiple same-name enums)
  for (const { sf: declarationSf, node: enumDeclNode } of enumDecls) {
    const enumDeclTyped = enumDeclNode.asKindOrThrow(
      SyntaxKind.EnumDeclaration,
    );

    // --- Emit declaration row for the enum itself ---
    {
      const lineCol = declarationSf.getLineAndColumnAtPos(
        enumDeclNode.getStart(),
      );
      totalEstimated++;
      if (rows.length < limit) {
        rows.push({
          file: toRepoRelative(repoRoot, declarationSf.getFilePath()),
          line: lineCol.line,
          column: lineCol.column,
          kind: 'declaration',
          memberName: null,
          enclosing: 'moduleTopLevel',
          confidence: 'exact',
        });
      }
    }

    // --- Emit declaration rows for each enum member ---
    for (const member of enumDeclTyped.getMembers()) {
      const memberName = member.getName();

      // Apply member filter: skip members that don't match when filter is set
      if (memberFilter && memberName !== memberFilter) {
        continue;
      }

      const lineCol = declarationSf.getLineAndColumnAtPos(member.getStart());
      totalEstimated++;
      if (rows.length < limit) {
        rows.push({
          file: toRepoRelative(repoRoot, declarationSf.getFilePath()),
          line: lineCol.line,
          column: lineCol.column,
          kind: 'declaration',
          memberName,
          enclosing: 'moduleTopLevel',
          confidence: 'exact',
        });
      }
    }

    // --- Walk all references to the enum symbol ---
    // ts-morph findReferences() on the EnumDeclaration gives all references
    // to the enum identifier across the project.
    const allRefs = enumDeclTyped.findReferences();

    for (const refSym of allRefs) {
      for (const ref of refSym.getReferences()) {
        const node = ref.getNode();
        const sf = node.getSourceFile();
        const parent = node.getParent();

        // Skip the declaration site itself (already handled above)
        if (ref.isDefinition()) {
          continue;
        }

        // Skip import declarations (they are module plumbing, not use sites)
        if (node.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)) {
          continue;
        }

        // Determine the kind of this reference
        let kind: EnumUseKind;
        let memberName: string | null = null;

        const propAccess = parent?.asKind(SyntaxKind.PropertyAccessExpression);
        if (propAccess) {
          // Member access: E.MEMBER — node is the left-side (enum identifier)
          if (propAccess.getExpression() === node) {
            kind = 'memberAccess';
            memberName = propAccess.getName();

            // Apply member filter: skip if this member doesn't match
            if (memberFilter && memberName !== memberFilter) {
              continue;
            }
          } else {
            // Node is the right-side name of some other prop access — skip
            continue;
          }
        } else if (isTypePosition(node)) {
          // Type-position: x: E, fn(): E, Array<E>, type Alias = E
          // When a member filter is active, drop whole-enum type-position rows
          // (they reference the enum as a type, not a specific member).
          if (memberFilter) {
            continue;
          }
          kind = 'typePosition';
          memberName = null;
        } else {
          // Unclassifiable reference — skip
          continue;
        }

        totalEstimated++;
        if (rows.length >= limit) continue;

        const lineCol = sf.getLineAndColumnAtPos(node.getStart());
        rows.push({
          file: toRepoRelative(repoRoot, sf.getFilePath()),
          line: lineCol.line,
          column: lineCol.column,
          kind,
          memberName,
          enclosing: findEnclosing(node),
          confidence: 'exact',
        });
      }
    }
  }

  return {
    query: 'enum-uses',
    args: { ...args, limit },
    results: rows,
    truncated: totalEstimated > rows.length,
    totalEstimated: totalEstimated > rows.length ? totalEstimated : undefined,
    durationMs: Date.now() - started,
  };
}

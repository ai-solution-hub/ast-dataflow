import { Project, SyntaxKind, type Node } from 'ts-morph';
import type {
  StringLiteralUsesArgs,
  StringLiteralUseKind,
  StringLiteralUseResult,
  QueryResponse,
} from '../types';
import {
  findEnclosing,
  toRepoRelative,
  buildErrorResponse,
} from '../resolve';

const DEFAULT_LIMIT = 200;

/**
 * Classify the call-site context of a string literal node.
 *
 * Classification rules (applied in priority order):
 *  1. Argument to `vi.mock(...)` → 'viMock'
 *  2. Value of a JSX attribute (`<a href="..." />`) → 'jsxProp'
 *  3. Content of a tagged template with tag name 'sql' → 'sqlTag'
 *  4. Index key in `process.env['KEY']` ElementAccessExpression → 'envKey'
 *  5. Any other argument position in a CallExpression → 'argument'
 *
 * Returns null when the literal is in a position that does not match any
 * of the five recognised kinds (e.g. plain variable initialisers, object
 * property values outside a call, type-position literals).
 */
function classifyLiteralKind(node: Node): StringLiteralUseKind | null {
  const parent = node.getParent();
  if (!parent) return null;

  const parentKind = parent.getKind();

  // Rule 2: JSX attribute value — `<Comp prop="value" />`
  // The string literal is the child of a JsxExpression inside a JsxAttribute,
  // or directly the initialiser of a JsxAttribute (JsxAttribute → StringLiteral).
  if (parentKind === SyntaxKind.JsxAttribute) {
    return 'jsxProp';
  }

  // Check grandparent for the JsxAttribute case where there is no JsxExpression wrapper.
  // In ts-morph/TSC: JsxAttribute.initializer can be a StringLiteral directly.
  // (The ts-morph JsxAttribute getInitializer() returns the node as-is for string literals.)
  const grandParent = parent.getParent();

  if (grandParent) {
    const gpKind = grandParent.getKind();
    if (gpKind === SyntaxKind.JsxAttribute) {
      return 'jsxProp';
    }
  }

  // Rule 3: Tagged template — sql`...`
  // A NoSubstitutionTemplateLiteral or TemplateHead whose parent is a
  // TaggedTemplateExpression. We check whether the tag identifier is 'sql'.
  if (
    parentKind === SyntaxKind.TaggedTemplateExpression
  ) {
    // This node IS the template (the literal part); parent is the tagged expr.
    const tag = (parent as { getTag?: () => Node }).getTag?.();
    if (tag) {
      const tagText = tag.getText();
      if (tagText === 'sql') {
        return 'sqlTag';
      }
    }
    return null;
  }

  // Rule 4: ElementAccessExpression key — process.env['KEY']
  // The string literal is the argument expression of an ElementAccessExpression.
  if (parentKind === SyntaxKind.ElementAccessExpression) {
    // Check that the expression (the object) is `process.env`.
    const elemAccess = parent as { getExpression?: () => Node; getArgumentExpression?: () => Node };
    const argExpr = elemAccess.getArgumentExpression?.();
    if (argExpr && argExpr.getStart() === node.getStart()) {
      // This literal IS the bracket key. Check object is `process.env`.
      const obj = elemAccess.getExpression?.();
      if (obj) {
        const objText = obj.getText().replace(/\s/g, '');
        if (objText === 'process.env') {
          return 'envKey';
        }
      }
    }
    return null;
  }

  // Rules 1 + 5: CallExpression argument
  if (parentKind === SyntaxKind.CallExpression) {
    // Rule 1: vi.mock(...)
    const callExpr = parent as { getExpression?: () => Node };
    const expr = callExpr.getExpression?.();
    if (expr) {
      const exprText = expr.getText().replace(/\s/g, '');
      if (exprText === 'vi.mock') {
        return 'viMock';
      }
    }
    // Rule 5: generic argument
    return 'argument';
  }

  return null;
}

/**
 * Find every call site where a string literal with `args.value` appears
 * as a StringLiteral node in the project.
 *
 * Classification of the call-site context (PRODUCT.md invariant 10):
 *   - 'viMock'   — argument to vi.mock(...)
 *   - 'jsxProp'  — JSX attribute value
 *   - 'sqlTag'   — content inside a sql`` tagged template
 *   - 'envKey'   — bracket-access key on process.env
 *   - 'argument' — generic call-expression argument
 *
 * Sites that do not match any of the five kinds (e.g. plain initialisers,
 * object-property values, type literals) are intentionally excluded — the
 * query is a *call-site context* search, not a raw text search.
 */
export async function stringLiteralUses(
  args: StringLiteralUsesArgs,
  project: Project,
  repoRoot: string,
): Promise<QueryResponse<StringLiteralUseResult>> {
  const started = Date.now();
  const limit = args.limit ?? DEFAULT_LIMIT;

  // Validate: value is required and non-empty.
  if (!args.value) {
    return buildErrorResponse<StringLiteralUseResult>(
      'string-literal-uses',
      { ...args, limit },
      'parse_error',
      'The "value" argument is required and must be a non-empty string.',
      'Provide the exact string literal to search for, e.g. --value \'@/lib/foo\'.',
      Date.now() - started,
    );
  }

  const rows: StringLiteralUseResult[] = [];
  let totalEstimated = 0;

  for (const sf of project.getSourceFiles()) {
    const relPath = toRepoRelative(repoRoot, sf.getFilePath());

    // Walk all StringLiteral nodes in this file.
    const stringLiterals = sf.getDescendantsOfKind(SyntaxKind.StringLiteral);

    for (const literal of stringLiterals) {
      // Exact-match the literal value (not the raw text with quotes).
      if (literal.getLiteralValue() !== args.value) continue;

      const kind = classifyLiteralKind(literal);
      if (kind === null) continue; // Not a recognised call-site context.

      totalEstimated++;
      if (rows.length >= limit) continue;

      const lineCol = sf.getLineAndColumnAtPos(literal.getStart());

      rows.push({
        file: relPath,
        line: lineCol.line,
        column: lineCol.column,
        confidence: 'exact',
        kind,
        enclosing: findEnclosing(literal),
      });
    }

    // Also check NoSubstitutionTemplateLiteral nodes for sql`` tagged templates.
    // These are distinct from StringLiteral in the ts-morph AST.
    const noSubstitutionTemplates = sf.getDescendantsOfKind(
      SyntaxKind.NoSubstitutionTemplateLiteral,
    );

    for (const tmpl of noSubstitutionTemplates) {
      if (tmpl.getLiteralValue() !== args.value) continue;

      const parent = tmpl.getParent();
      if (!parent) continue;

      // Only classify if parent is a TaggedTemplateExpression with tag 'sql'.
      if (parent.getKind() !== SyntaxKind.TaggedTemplateExpression) continue;

      const tag = (parent as { getTag?: () => Node }).getTag?.();
      if (!tag || tag.getText() !== 'sql') continue;

      totalEstimated++;
      if (rows.length >= limit) continue;

      const lineCol = sf.getLineAndColumnAtPos(tmpl.getStart());

      rows.push({
        file: relPath,
        line: lineCol.line,
        column: lineCol.column,
        confidence: 'exact',
        kind: 'sqlTag',
        enclosing: findEnclosing(tmpl),
      });
    }
  }

  return {
    query: 'string-literal-uses',
    args: { ...args, limit },
    results: rows,
    truncated: totalEstimated > rows.length,
    totalEstimated: totalEstimated > rows.length ? totalEstimated : undefined,
    durationMs: Date.now() - started,
  };
}

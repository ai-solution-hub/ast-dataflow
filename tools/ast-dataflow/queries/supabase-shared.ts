import {
  SyntaxKind,
  type CallExpression,
  type Node,
  type SourceFile,
} from 'ts-morph';

/**
 * Shared Supabase call-chain helpers for column-reads and column-writes.
 * Single source of truth — the two queries previously kept diverging copies
 * (the reads copy lacked computed-key support; the writes copy carried a
 * dead chain-root walk).
 */

/**
 * Determine whether the Supabase client used in a `.from('table')` call chain
 * is type-instantiated (carries a `Database` generic parameter).
 *
 * Strategy 1: check the return type of `.from('table')` — typed clients embed
 * the table name in the generic parameter. Strategy 2: inspect the variable
 * declaration of the client binding for a type argument on
 * `createClient<...>(...)`.
 *
 * The heuristic may produce false-negatives when the client is passed through
 * several function boundaries (type erasure at callsite). In that case
 * `isTyped: false` with `confidence: 'indirect'` is the safe default.
 */
export function detectIsTyped(
  fromCallExpr: CallExpression,
  table: string,
): boolean {
  try {
    const returnTypeText = fromCallExpr.getReturnType().getText();
    if (returnTypeText.includes(table)) {
      return true;
    }
    if (
      !returnTypeText.includes('Record<string, unknown>') &&
      !returnTypeText.includes('unknown') &&
      returnTypeText.includes('{')
    ) {
      return true;
    }
  } catch {
    // Type resolution may fail on fixture projects with stub types; fall through.
  }

  try {
    const propAccess = fromCallExpr.getExpression();
    if (propAccess.getKind() === SyntaxKind.PropertyAccessExpression) {
      const clientExpr = (
        propAccess as import('ts-morph').PropertyAccessExpression
      ).getExpression();
      const symbol = clientExpr.getType().getSymbol();
      if (!symbol) return false;
      const decls = symbol.getDeclarations();
      for (const decl of decls) {
        if (decl.getKind() === SyntaxKind.VariableDeclaration) {
          const initialiser = (
            decl as import('ts-morph').VariableDeclaration
          ).getInitializer();
          if (initialiser?.getKind() === SyntaxKind.CallExpression) {
            const initCall = initialiser as CallExpression;
            const typeArgs = initCall.getTypeArguments();
            if (typeArgs.length > 0) {
              return true;
            }
          }
        }
      }
    }
  } catch {
    // Symbol resolution may fail; fall through.
  }

  return false;
}

/**
 * Return true if an object literal has a property whose key matches `name`.
 *
 * Handles:
 * - Longhand: `{ project_id: value }` — PropertyAssignment.
 * - Shorthand: `{ project_id }` — ShorthandPropertyAssignment.
 * - Computed string literal: `{ ['project_id']: value }` — ComputedPropertyName
 *   whose expression is a StringLiteral matching the target.
 */
export function objectLiteralHasKey(
  objLiteral: import('ts-morph').ObjectLiteralExpression,
  name: string,
): boolean {
  return objLiteral.getProperties().some((prop) => {
    const kind = prop.getKind();
    if (kind === SyntaxKind.PropertyAssignment) {
      const pa = prop as import('ts-morph').PropertyAssignment;
      if (pa.getName() === name) return true;
      const nameNode = pa.getNameNode();
      if (nameNode.getKind() === SyntaxKind.ComputedPropertyName) {
        const inner = (
          nameNode as import('ts-morph').ComputedPropertyName
        ).getExpression();
        if (
          inner.getKind() === SyntaxKind.StringLiteral &&
          (inner as import('ts-morph').StringLiteral).getLiteralValue() === name
        ) {
          return true;
        }
      }
      return false;
    }
    if (kind === SyntaxKind.ShorthandPropertyAssignment) {
      return (
        (prop as import('ts-morph').ShorthandPropertyAssignment).getName() ===
        name
      );
    }
    return false;
  });
}

/**
 * Return true if an object literal contains a SpreadAssignment (`{ ...x }`).
 * A spread can carry the target column even when no explicit key names it,
 * so callers that could not confirm the key statically must not rule the
 * column out when a spread is present.
 */
export function objectLiteralHasSpread(
  objLiteral: import('ts-morph').ObjectLiteralExpression,
): boolean {
  return objLiteral
    .getProperties()
    .some((prop) => prop.getKind() === SyntaxKind.SpreadAssignment);
}

/**
 * Walk a source file and collect all `.from('<table>')` call expressions that
 * match the target table name. Accepts plain string literals and
 * no-substitution template literals as the table argument.
 */
export function findFromCalls(sf: SourceFile, table: string): CallExpression[] {
  const results: CallExpression[] = [];

  const callExprs = sf.getDescendantsOfKind(SyntaxKind.CallExpression);
  for (const callExpr of callExprs) {
    const expr = callExpr.getExpression();
    if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) continue;

    const propAccess = expr as import('ts-morph').PropertyAccessExpression;
    if (propAccess.getName() !== 'from') continue;

    const args = callExpr.getArguments();
    if (args.length === 0) continue;
    const firstArg = args[0];
    let tableValue: string | null = null;
    if (firstArg.getKind() === SyntaxKind.StringLiteral) {
      tableValue = (
        firstArg as import('ts-morph').StringLiteral
      ).getLiteralValue();
    } else if (
      firstArg.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral
    ) {
      tableValue = (
        firstArg as import('ts-morph').NoSubstitutionTemplateLiteral
      ).getLiteralValue();
    }
    if (tableValue !== table) continue;

    results.push(callExpr);
  }

  return results;
}

/**
 * Given a `.from('table')` CallExpression, walk the parent chain upward
 * collecting all chained method calls that form the query/mutation chain.
 *
 * Returns an array of { method, callExpr } items for each step in the
 * fluent chain above `.from()`.
 */
export function collectChain(
  fromCallExpr: CallExpression,
): Array<{ method: string; callExpr: CallExpression }> {
  const chain: Array<{ method: string; callExpr: CallExpression }> = [];

  let parent: Node | undefined = fromCallExpr.getParent();
  while (parent) {
    if (parent.getKind() === SyntaxKind.PropertyAccessExpression) {
      const propAccess = parent as import('ts-morph').PropertyAccessExpression;
      const methodName = propAccess.getName();
      const grandParent = propAccess.getParent();
      if (grandParent?.getKind() === SyntaxKind.CallExpression) {
        chain.push({
          method: methodName,
          callExpr: grandParent as CallExpression,
        });
        parent = grandParent.getParent();
      } else {
        break;
      }
    } else {
      break;
    }
  }

  return chain;
}

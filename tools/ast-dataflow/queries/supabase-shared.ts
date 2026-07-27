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
 * Return true when the client binding behind `clientExpr` was declared with
 * an explicit type argument, e.g. `const sb = createClient<Database>(...)`.
 *
 * Resolution MUST go through the identifier's own symbol
 * (`clientExpr.getSymbol()`) — the type's symbol
 * (`clientExpr.getType().getSymbol()`) resolves to the SupabaseClient
 * interface declaration, never a VariableDeclaration, so the type-args check
 * would never run.
 */
export function clientBindingHasExplicitTypeArgs(clientExpr: Node): boolean {
  try {
    for (const decl of clientExpr.getSymbol()?.getDeclarations() ?? []) {
      if (decl.getKind() !== SyntaxKind.VariableDeclaration) continue;
      const initialiser = (
        decl as import('ts-morph').VariableDeclaration
      ).getInitializer();
      if (
        initialiser?.getKind() === SyntaxKind.CallExpression &&
        (initialiser as CallExpression).getTypeArguments().length > 0
      ) {
        return true;
      }
    }
  } catch {
    // Symbol resolution may fail; treat as untyped.
  }
  return false;
}

/**
 * Determine whether the Supabase client used in a `.from('table')` call chain
 * is type-instantiated (carries a `Database` generic parameter).
 *
 * Strategy 1: inspect the `.from()` return type's type arguments for a
 * non-any Relation carrying a concrete `Row` shape. Typed clients instantiate
 * `PostgrestQueryBuilder<ClientOptions, Schema, Relation, TableName, ...>`
 * with `Relation = { Row; Insert; Update; Relationships }`. Strategy 1 works
 * across function boundaries (`function f(client: SupabaseClient<Database>)`).
 *
 * Strategy 2: the client binding's declaration carries an explicit type
 * argument (`const sb = createClient<Database>(...)`).
 *
 * The heuristic may produce false-negatives when the client's type is erased
 * across a boundary (e.g. a bare `SupabaseClient` parameter). In that case
 * `isTyped: false` with `confidence: 'indirect'` is the safe default.
 */
export function detectIsTyped(fromCallExpr: CallExpression): boolean {
  // Strategy 1: the .from() return type's type arguments must include a
  // non-any Relation carrying a concrete `Row` shape. Untyped clients
  // (Database = any) instantiate these arguments as `any` even though the
  // table-name literal is still echoed into the generic — so never match on
  // return-type text.
  try {
    const returnType = fromCallExpr.getReturnType();
    for (const typeArg of returnType.getTypeArguments()) {
      if (typeArg.isAny() || typeArg.isUnknown()) continue;
      const rowProp = typeArg.getProperty('Row');
      if (!rowProp) continue;
      const rowType = rowProp.getTypeAtLocation(fromCallExpr);
      if (rowType.isAny() || rowType.isUnknown()) continue;
      if (rowType.getProperties().length > 0) return true;
    }
  } catch {
    // Type resolution may fail on fixture projects with stub types; fall through.
  }

  // Strategy 2: explicit type argument at the client binding.
  try {
    const propAccess = fromCallExpr.getExpression();
    if (propAccess.getKind() === SyntaxKind.PropertyAccessExpression) {
      const clientExpr = (
        propAccess as import('ts-morph').PropertyAccessExpression
      ).getExpression();
      if (clientBindingHasExplicitTypeArgs(clientExpr)) return true;
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
 * Resolve a non-literal `.from()` table argument — an Identifier
 * (`SIGNUP_POLICY_TABLE`) or a PropertyAccessExpression
 * (`TABLES.signup_policy`) — one hop through the type checker: the argument's
 * type must be a single string-literal type (a literal-typed `const`, or a
 * property of an `as const` map). Widened `string` types are unattributable
 * and union-of-literals types ambiguous — both return null so the call stays
 * excluded (the schema-coverage stage surfaces unattributable counts).
 */
function resolveConstTableArg(argNode: Node): string | null {
  const kind = argNode.getKind();
  if (
    kind !== SyntaxKind.Identifier &&
    kind !== SyntaxKind.PropertyAccessExpression
  ) {
    return null;
  }

  try {
    const argType = argNode.getType();
    if (!argType.isStringLiteral()) return null;
    const literal = argType.getLiteralValue();
    if (typeof literal === 'string') return literal;
  } catch {
    // Type resolution may fail; treat as unattributable.
  }
  return null;
}

/**
 * One `.from(<arg>)` call site. `table` is the resolved table name, or null
 * when the argument is dynamic and does not resolve to a single
 * string-literal type (schema-coverage classifies those as unattributable
 * smoke via the argument's type).
 */
export interface FromCallSite {
  callExpr: CallExpression;
  table: string | null;
  /** The table argument node — always present (zero-arg calls are skipped). */
  arg: Node;
}

/**
 * Walk a source file and collect EVERY `.from(<arg>)` call expression with its
 * resolved table name. Accepts plain string literals and no-substitution
 * template literals as the table argument, plus identifier / property-access
 * arguments whose type resolves to a single string-literal type (see
 * resolveConstTableArg). Unresolvable dynamic arguments are returned with
 * `table: null` so schema-coverage can count them rather than drop them.
 */
export function findAllFromCalls(sf: SourceFile): FromCallSite[] {
  const results: FromCallSite[] = [];

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
    } else {
      tableValue = resolveConstTableArg(firstArg);
    }

    results.push({ callExpr, table: tableValue, arg: firstArg });
  }

  return results;
}

/**
 * Walk a source file and collect all `.from('<table>')` call expressions that
 * match the target table name (thin filter over findAllFromCalls — single
 * source of truth for the table-argument resolution rules).
 */
export function findFromCalls(sf: SourceFile, table: string): CallExpression[] {
  return findAllFromCalls(sf)
    .filter((site) => site.table === table)
    .map((site) => site.callExpr);
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

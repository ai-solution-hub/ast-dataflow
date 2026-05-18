import {
  type Project,
  SyntaxKind,
  type CallExpression,
  type Node,
  type SourceFile,
} from 'ts-morph';
import type {
  ColumnWritesArgs,
  ColumnWriteResult,
  ColumnWriteMethod,
  QueryResponse,
} from '../types';
import { buildErrorResponse, isTestFilePath, toRepoRelative } from '../resolve';

const DEFAULT_LIMIT = 200;

/**
 * The set of Supabase-js mutation method names that column-writes inspects.
 * `.match()` is included because it names a column to filter on and is
 * treated as a column reference site (consistent with column-reads).
 *
 * `rpc-payload` is declared in the `ColumnWriteMethod` union but is not
 * detected here — the inspection path is deferred to S5+. Wildcard confidence
 * (`'wildcard'` from the shared Confidence union) is N/A for writes: Supabase
 * has no `.insert('*')` equivalent, so a mutation payload either names columns
 * explicitly (exact / indirect via spread) or is opaque (indirect).
 */
const WRITE_METHODS: ReadonlySet<string> = new Set([
  'insert',
  'update',
  'upsert',
  'match',
]);

/**
 * Determine whether the Supabase client used in a `.from('table')` call chain
 * is type-instantiated (carries a `Database` generic parameter).
 *
 * Mirrors the heuristic in `column-reads.ts` — check the return type of the
 * `.from(...)` call for the table name, and fall back to inspecting the
 * variable declaration of the client binding for a type argument on
 * `createClient<...>(...)`.
 */
function detectIsTyped(fromCallExpr: CallExpression, table: string): boolean {
  // Strategy 1: check the return type of .from('table') — typed clients embed
  // the table name in the generic parameter.
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

  // Strategy 2: inspect the variable declaration of the client binding for a
  // type argument on createClient<...>(...).
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
 * - Longhand: `{ project_id: value }` — PropertyAssignment whose name is
 *   the target column.
 * - Shorthand: `{ project_id }` — ShorthandPropertyAssignment.
 * - Computed string literal: `{ ['project_id']: value }` — ComputedPropertyName
 *   whose expression is a StringLiteral matching the target.
 */
function objectLiteralHasKey(
  objLiteral: import('ts-morph').ObjectLiteralExpression,
  name: string,
): boolean {
  return objLiteral.getProperties().some((prop) => {
    const kind = prop.getKind();
    if (kind === SyntaxKind.PropertyAssignment) {
      const pa = prop as import('ts-morph').PropertyAssignment;
      // Longhand: `{ project_id: value }`
      if (pa.getName() === name) return true;
      // Computed string literal: `{ ['project_id']: value }`
      const nameNode = pa.getNameNode();
      if (nameNode.getKind() === SyntaxKind.ComputedPropertyName) {
        const inner = (
          nameNode as import('ts-morph').ComputedPropertyName
        ).getExpression();
        if (
          inner.getKind() === SyntaxKind.StringLiteral &&
          inner.getText().slice(1, -1) === name
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
 * Find the nearest enclosing function-like body for a given node.
 *
 * Returns the FunctionDeclaration, ArrowFunction, FunctionExpression, or
 * MethodDeclaration ancestor, or the SourceFile if the node is at module
 * top-level.
 */
function findEnclosingFunctionBody(node: Node): Node {
  let current: Node | undefined = node.getParent();
  while (current) {
    const kind = current.getKind();
    if (
      kind === SyntaxKind.FunctionDeclaration ||
      kind === SyntaxKind.ArrowFunction ||
      kind === SyntaxKind.FunctionExpression ||
      kind === SyntaxKind.MethodDeclaration
    ) {
      return current;
    }
    if (kind === SyntaxKind.SourceFile) {
      return current;
    }
    current = current.getParent();
  }
  return node.getSourceFile();
}

/**
 * Try to resolve an Identifier argument (e.g. `payload` in `.update(payload)`)
 * to an object literal in the same scope — the "one-hop spread chase".
 *
 * Returns the object literal node if found (and it contains the target key),
 * or null if the reference cannot be traced within one hop.
 *
 * One hop means: the identifier references a variable declared in the same
 * enclosing function scope with a VariableDeclaration whose initialiser is an
 * ObjectLiteralExpression. Function parameters, imported bindings, and
 * bindings from outer or inner scopes are NOT followed — report `indirect`.
 */
function resolveOneHopObjectLiteral(
  identifierNode: Node,
  targetKey: string,
): import('ts-morph').ObjectLiteralExpression | null {
  // The identifier must be a plain name reference (not a member access).
  if (identifierNode.getKind() !== SyntaxKind.Identifier) return null;

  const identText = identifierNode.getText();

  // Find the enclosing function body to scope the search.
  const enclosingScope = findEnclosingFunctionBody(identifierNode);

  // Walk VariableDeclarations within the enclosing function scope only.
  for (const varDecl of enclosingScope.getDescendantsOfKind(
    SyntaxKind.VariableDeclaration,
  )) {
    if (varDecl.getName() !== identText) continue;
    const init = varDecl.getInitializer();
    if (!init) continue;
    if (init.getKind() !== SyntaxKind.ObjectLiteralExpression) continue;
    const objLit = init as import('ts-morph').ObjectLiteralExpression;
    if (objectLiteralHasKey(objLit, targetKey)) {
      return objLit;
    }
  }

  return null;
}

/**
 * Walk a source file and collect all `.from('<table>')` call expressions
 * that match the target table name.
 */
function findFromCalls(sf: SourceFile, table: string): CallExpression[] {
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
    if (firstArg.getKind() !== SyntaxKind.StringLiteral) continue;
    const tableValue = firstArg.getText().slice(1, -1);
    if (tableValue !== table) continue;

    results.push(callExpr);
  }

  return results;
}

/**
 * Given a `.from('table')` CallExpression, walk the parent chain upward
 * collecting all chained method calls that form the mutation chain.
 *
 * Returns an array of { method, callExpr } items for each step in the
 * fluent chain above `.from()`.
 */
function collectChain(
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

/**
 * Inspect an object-literal or identifier argument to a write method and
 * determine whether it contains the target column.
 *
 * Returns `{ found: false }` when the argument is an object literal that
 * clearly does NOT contain the target key (skip this call site).
 *
 * Returns `{ found: true, confidence }` when the column is present or cannot
 * be ruled out:
 * - `'exact'`    — typed client + literal key confirmed.
 * - `'indirect'` — untyped client, or argument cannot be traced statically.
 *
 * Array-form arguments (`.insert([{ ... }])`) are supported by inspecting
 * every ObjectLiteralExpression element.
 */
type WriteArgResult =
  | { found: false }
  | { found: true; confidence: 'exact' | 'indirect' };

function inspectWriteArg(
  argNode: Node,
  targetKey: string,
  isTyped: boolean,
): WriteArgResult {
  const kind = argNode.getKind();

  // Direct object literal: .insert({ project_id: value })
  if (kind === SyntaxKind.ObjectLiteralExpression) {
    const objLit = argNode as import('ts-morph').ObjectLiteralExpression;
    if (objectLiteralHasKey(objLit, targetKey)) {
      return { found: true, confidence: isTyped ? 'exact' : 'indirect' };
    }
    return { found: false };
  }

  // Array literal: .insert([{ project_id: value }, ...])
  // Inspect every element that is an object literal.
  if (kind === SyntaxKind.ArrayLiteralExpression) {
    const arrLit = argNode as import('ts-morph').ArrayLiteralExpression;
    for (const elem of arrLit.getElements()) {
      if (elem.getKind() === SyntaxKind.ObjectLiteralExpression) {
        const objLit = elem as import('ts-morph').ObjectLiteralExpression;
        if (objectLiteralHasKey(objLit, targetKey)) {
          return { found: true, confidence: isTyped ? 'exact' : 'indirect' };
        }
      }
    }
    return { found: false };
  }

  // Identifier: one-hop spread chase.
  if (kind === SyntaxKind.Identifier) {
    const resolved = resolveOneHopObjectLiteral(argNode, targetKey);
    if (resolved !== null) {
      // Traced one hop to a local const with the target key.
      return { found: true, confidence: isTyped ? 'exact' : 'indirect' };
    }
    // Cannot trace — the identifier is a parameter, import, or complex
    // expression. Emit an indirect row (cannot confirm absence of the column).
    return { found: true, confidence: 'indirect' };
  }

  // Other argument shapes (spread, ternary, function call, etc.) — cannot
  // inspect statically. Emit indirect (cannot confirm absence).
  return { found: true, confidence: 'indirect' };
}

export async function columnWrites(
  args: ColumnWritesArgs,
  project: Project,
  repoRoot: string,
): Promise<QueryResponse<ColumnWriteResult>> {
  const started = Date.now();

  if (!args.table) {
    return buildErrorResponse<ColumnWriteResult>(
      'column-writes',
      { ...args },
      'parse_error',
      'table must be a non-empty string.',
      "Example: { table: 'bid_questions', column: 'project_id' }",
      Date.now() - started,
    );
  }

  if (!args.column) {
    return buildErrorResponse<ColumnWriteResult>(
      'column-writes',
      { ...args },
      'parse_error',
      'column must be a non-empty string.',
      "Example: { table: 'bid_questions', column: 'project_id' }",
      Date.now() - started,
    );
  }

  const limit = args.limit ?? DEFAULT_LIMIT;
  const excludeTests = args.excludeTests ?? false;

  const rows: ColumnWriteResult[] = [];
  let totalEstimated = 0;

  try {
    for (const sf of project.getSourceFiles()) {
      const relPath = toRepoRelative(repoRoot, sf.getFilePath());

      if (excludeTests && isTestFilePath(relPath)) continue;

      const fromCalls = findFromCalls(sf, args.table);

      for (const fromCallExpr of fromCalls) {
        const isTyped = detectIsTyped(fromCallExpr, args.table);
        const chain = collectChain(fromCallExpr);

        for (const { method, callExpr } of chain) {
          if (!WRITE_METHODS.has(method)) continue;

          const chainArgs = callExpr.getArguments();
          if (chainArgs.length === 0) continue;

          // The first argument is the object payload (second arg for upsert
          // is the options object like { onConflict: 'id' } — we only inspect
          // the first arg which is the row data).
          const payloadArg = chainArgs[0];

          const inspection = inspectWriteArg(payloadArg, args.column, isTyped);

          if (!inspection.found) continue;

          totalEstimated++;
          if (rows.length < limit) {
            const lineCol = sf.getLineAndColumnAtPos(callExpr.getStart());
            rows.push({
              file: relPath,
              line: lineCol.line,
              column: lineCol.column,
              confidence: inspection.confidence,
              method: method as ColumnWriteMethod,
              columnPath: args.column,
              table: args.table,
              isTyped,
            });
          }
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return buildErrorResponse<ColumnWriteResult>(
      'column-writes',
      { ...args, limit },
      'parse_error',
      `Unexpected error during column-writes traversal: ${message}`,
      'Check that the project compiles without errors.',
      Date.now() - started,
    );
  }

  return {
    query: 'column-writes',
    args: { ...args, limit },
    results: rows,
    truncated: totalEstimated > rows.length,
    totalEstimated: totalEstimated > rows.length ? totalEstimated : undefined,
    durationMs: Date.now() - started,
  };
}

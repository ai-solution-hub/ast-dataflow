import {
  type Project,
  SyntaxKind,
  type CallExpression,
  type Node,
  type SourceFile,
} from 'ts-morph';
import type {
  ColumnReadsArgs,
  ColumnReadResult,
  ColumnReadMethod,
  QueryResponse,
} from '../types';
import { buildErrorResponse, toRepoRelative } from '../resolve';

const DEFAULT_LIMIT = 200;

/**
 * Determine whether the Supabase client used in a `.from('table')` call chain
 * is type-instantiated (i.e. carries a `Database` generic parameter).
 *
 * Strategy:
 * 1. Walk up from the `.from(...)` CallExpression to find the base expression
 *    (the client variable reference, e.g. `supabase`, `sb`).
 * 2. Get the type text of that base expression. For a typed client
 *    (`createClient<Database>(...)`) the type text includes the table name in
 *    the resolved return of `.from()`. For an untyped client it resolves to
 *    `Record<string, unknown>` or `unknown`.
 * 3. Additionally check whether the `.from()` call's return type text contains
 *    the table name string — typed clients embed the table name in their type
 *    parameters.
 *
 * The heuristic may produce false-negatives when the client is passed through
 * several function boundaries (type erasure at callsite). In that case
 * `isTyped: false` with `confidence: 'indirect'` is the safe default.
 */
function detectIsTyped(fromCallExpr: CallExpression, table: string): boolean {
  // Walk to the root of the chain (the leftmost expression in the chain).
  let base: Node = fromCallExpr;
  while (true) {
    const expr = (base as CallExpression).getExpression?.();
    if (!expr) break;
    if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
      const inner = (expr as import('ts-morph').PropertyAccessExpression).getExpression();
      if (inner.getKind() === SyntaxKind.CallExpression) {
        base = inner as CallExpression;
      } else {
        break;
      }
    } else {
      break;
    }
  }

  // Strategy 1: check the return type of .from('table') — typed clients embed
  // the table name in the generic parameter.
  try {
    const returnTypeText = fromCallExpr.getReturnType().getText();
    if (returnTypeText.includes(table)) {
      return true;
    }
    // If the return type resolves to a strongly-typed Row shape (not Record<string, unknown>
    // or unknown), treat as typed.
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

  // Strategy 2: check the variable declaration of the client binding for a
  // type argument on createClient<...>(...).
  // Walk from the PropertyAccessExpression expression (the LHS of `.from(...)`)
  // up to its variable declaration, then look at the initialiser for type args.
  try {
    const propAccess = fromCallExpr.getExpression();
    if (propAccess.getKind() === SyntaxKind.PropertyAccessExpression) {
      const clientExpr = (propAccess as import('ts-morph').PropertyAccessExpression).getExpression();
      // Resolve to the variable's type via its declaration.
      const symbol = clientExpr.getType().getSymbol();
      if (!symbol) return false;
      const decls = symbol.getDeclarations();
      for (const decl of decls) {
        if (decl.getKind() === SyntaxKind.VariableDeclaration) {
          const initialiser = (decl as import('ts-morph').VariableDeclaration).getInitializer();
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
 * Parse a `.select('col1, col2, ...')` string argument and check if
 * `targetColumn` appears in the list.
 *
 * Handles:
 * - Simple: `'project_id, question_text'`
 * - Supabase colon-alias: `'pid:project_id'` (the actual column is on the
 *   right of `:`; the left side is the alias used in the result object). The
 *   target column matches when it appears as the column portion.
 * - SQL-style whitespace alias: `'project_id as pid'` (matches on the column
 *   name before 'as'). Supabase-js itself does not use `as`, but the
 *   tokeniser tolerates whitespace tails defensively.
 * - Nested relation syntax: `'id, bid_responses ( id, text )'` — only
 *   top-level tokens are matched (tokens before the first `(`).
 */
function selectContainsColumn(selectStr: string, targetColumn: string): boolean {
  // Strip nested relation blocks (anything in parentheses including the content).
  const withoutRelations = selectStr.replace(/\(.*?\)/gs, '');
  const tokens = withoutRelations
    .split(',')
    .map((t) => {
      const trimmed = t.trim();
      // Supabase colon-alias: `<alias>:<column>` — the actual column is on
      // the right of the first `:`. Without a `:`, the whole token is the
      // column name.
      const colonIdx = trimmed.indexOf(':');
      const columnPart = colonIdx >= 0 ? trimmed.slice(colonIdx + 1).trim() : trimmed;
      // Strip any trailing whitespace-separated alias (defensive against
      // SQL-style `'project_id as pid'`).
      return columnPart.split(/\s+/)[0].trim();
    })
    .filter(Boolean);
  return tokens.includes(targetColumn);
}

/**
 * Return true if an object literal has a property whose key matches `name`,
 * handling both shorthand (`{ project_id }`) and longhand (`{ project_id:
 * value }`) property assignments.
 */
function objectLiteralHasKey(
  objLiteral: import('ts-morph').ObjectLiteralExpression,
  name: string,
): boolean {
  return objLiteral.getProperties().some((prop) => {
    const kind = prop.getKind();
    if (kind === SyntaxKind.PropertyAssignment) {
      return (prop as import('ts-morph').PropertyAssignment).getName() === name;
    }
    if (kind === SyntaxKind.ShorthandPropertyAssignment) {
      return (
        prop as import('ts-morph').ShorthandPropertyAssignment
      ).getName() === name;
    }
    return false;
  });
}

/**
 * Given a `.from('table')` CallExpression, walk the parent chain upward
 * collecting all chained method calls that form the query chain.
 *
 * Returns an array of { method: string; callExpr: CallExpression } items
 * representing each step in the fluent chain above the `.from()` call.
 */
function collectChain(fromCallExpr: CallExpression): Array<{ method: string; callExpr: CallExpression }> {
  const chain: Array<{ method: string; callExpr: CallExpression }> = [];

  let parent: Node | undefined = fromCallExpr.getParent();
  while (parent) {
    if (parent.getKind() === SyntaxKind.PropertyAccessExpression) {
      const propAccess = parent as import('ts-morph').PropertyAccessExpression;
      const methodName = propAccess.getName();
      const grandParent = propAccess.getParent();
      if (grandParent?.getKind() === SyntaxKind.CallExpression) {
        chain.push({ method: methodName, callExpr: grandParent as CallExpression });
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
 * Walk a source file and collect all `.from('<table>')` call expressions.
 */
function findFromCalls(sf: SourceFile, table: string): CallExpression[] {
  const results: CallExpression[] = [];

  const callExprs = sf.getDescendantsOfKind(SyntaxKind.CallExpression);
  for (const callExpr of callExprs) {
    const expr = callExpr.getExpression();
    if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) continue;

    const propAccess = expr as import('ts-morph').PropertyAccessExpression;
    if (propAccess.getName() !== 'from') continue;

    // Check first argument is the target table string literal.
    const args = callExpr.getArguments();
    if (args.length === 0) continue;
    const firstArg = args[0];
    if (firstArg.getKind() !== SyntaxKind.StringLiteral) continue;
    const tableValue = firstArg.getText().slice(1, -1); // strip quotes
    if (tableValue !== table) continue;

    results.push(callExpr);
  }

  return results;
}

/**
 * Walk a source file and collect `.rpc('fnName', { column: value })` calls
 * where the payload object literal has a key matching `targetColumn`.
 *
 * These are direct calls on the client object (not chained from `.from()`),
 * so they are handled separately.
 */
function findRpcCalls(sf: SourceFile, column: string): CallExpression[] {
  const results: CallExpression[] = [];

  const callExprs = sf.getDescendantsOfKind(SyntaxKind.CallExpression);
  for (const callExpr of callExprs) {
    const expr = callExpr.getExpression();
    if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) continue;

    const propAccess = expr as import('ts-morph').PropertyAccessExpression;
    if (propAccess.getName() !== 'rpc') continue;

    const args = callExpr.getArguments();
    if (args.length < 2) continue;
    const payloadArg = args[1];
    if (payloadArg.getKind() !== SyntaxKind.ObjectLiteralExpression) continue;

    const objLiteral = payloadArg as import('ts-morph').ObjectLiteralExpression;
    if (objectLiteralHasKey(objLiteral, column)) {
      results.push(callExpr);
    }
  }

  return results;
}

function isTestFile(filePath: string): boolean {
  return (
    filePath.startsWith('__tests__/') ||
    filePath.includes('/test/') ||
    filePath.endsWith('.test.ts') ||
    filePath.endsWith('.test.tsx') ||
    filePath.endsWith('.spec.ts') ||
    filePath.endsWith('.spec.tsx')
  );
}

export async function columnReads(
  args: ColumnReadsArgs,
  project: Project,
  repoRoot: string,
): Promise<QueryResponse<ColumnReadResult>> {
  const started = Date.now();

  if (!args.table) {
    return buildErrorResponse<ColumnReadResult>(
      'column-reads',
      { ...args },
      'parse_error',
      'table must be a non-empty string.',
      "Example: { table: 'bid_questions', column: 'project_id' }",
      Date.now() - started,
    );
  }

  if (!args.column) {
    return buildErrorResponse<ColumnReadResult>(
      'column-reads',
      { ...args },
      'parse_error',
      'column must be a non-empty string.',
      "Example: { table: 'bid_questions', column: 'project_id' }",
      Date.now() - started,
    );
  }

  const limit = args.limit ?? DEFAULT_LIMIT;
  const excludeTests = args.excludeTests ?? false;

  const rows: ColumnReadResult[] = [];
  let totalEstimated = 0;

  try {
    for (const sf of project.getSourceFiles()) {
      const relPath = toRepoRelative(repoRoot, sf.getFilePath());

      if (excludeTests && isTestFile(relPath)) continue;

      // ── .from('table').<chain> hits ──────────────────────────────────────
      const fromCalls = findFromCalls(sf, args.table);

      for (const fromCallExpr of fromCalls) {
        const isTyped = detectIsTyped(fromCallExpr, args.table);
        const confidence = isTyped ? ('exact' as const) : ('indirect' as const);
        const chain = collectChain(fromCallExpr);

        for (const { method, callExpr } of chain) {
          const chainArgs = callExpr.getArguments();
          let hit: { method: ColumnReadMethod; columnPath: string } | null = null;

          if (method === 'select' && chainArgs.length >= 1) {
            const arg = chainArgs[0];
            if (arg.getKind() === SyntaxKind.StringLiteral) {
              const selectStr = arg.getText().slice(1, -1);
              if (selectContainsColumn(selectStr, args.column)) {
                hit = { method: 'select', columnPath: args.column };
              }
            }
          } else if (method === 'eq' && chainArgs.length >= 1) {
            const arg = chainArgs[0];
            if (
              arg.getKind() === SyntaxKind.StringLiteral &&
              arg.getText().slice(1, -1) === args.column
            ) {
              hit = { method: 'eq', columnPath: args.column };
            }
          } else if (method === 'match' && chainArgs.length >= 1) {
            const arg = chainArgs[0];
            if (arg.getKind() === SyntaxKind.ObjectLiteralExpression) {
              const objLiteral = arg as import('ts-morph').ObjectLiteralExpression;
              if (objectLiteralHasKey(objLiteral, args.column)) {
                hit = { method: 'match', columnPath: args.column };
              }
            }
          }

          if (hit) {
            totalEstimated++;
            if (rows.length < limit) {
              const lineCol = sf.getLineAndColumnAtPos(callExpr.getStart());
              rows.push({
                file: relPath,
                line: lineCol.line,
                column: lineCol.column,
                confidence,
                method: hit.method,
                columnPath: hit.columnPath,
                table: args.table,
                isTyped,
              });
            }
          }
        }
      }

      // ── .rpc('fn', { column: value }) hits ───────────────────────────────
      const rpcCalls = findRpcCalls(sf, args.column);
      for (const rpcCallExpr of rpcCalls) {
        // Typed heuristic for rpc: check if the client has a type arg.
        // We look at the expression of the rpc call (the client variable).
        let rpcIsTyped = false;
        try {
          const rpcExpr = rpcCallExpr.getExpression();
          if (rpcExpr.getKind() === SyntaxKind.PropertyAccessExpression) {
            const clientExpr = (rpcExpr as import('ts-morph').PropertyAccessExpression).getExpression();
            const symbol = clientExpr.getType().getSymbol();
            if (symbol) {
              for (const decl of symbol.getDeclarations()) {
                if (decl.getKind() === SyntaxKind.VariableDeclaration) {
                  const init = (decl as import('ts-morph').VariableDeclaration).getInitializer();
                  if (init?.getKind() === SyntaxKind.CallExpression) {
                    if ((init as CallExpression).getTypeArguments().length > 0) {
                      rpcIsTyped = true;
                    }
                  }
                }
              }
            }
          }
        } catch {
          // Fall through — rpcIsTyped stays false.
        }

        totalEstimated++;
        if (rows.length < limit) {
          const lineCol = sf.getLineAndColumnAtPos(rpcCallExpr.getStart());
          rows.push({
            file: relPath,
            line: lineCol.line,
            column: lineCol.column,
            confidence: rpcIsTyped ? 'exact' : 'indirect',
            method: 'rpc-payload',
            columnPath: args.column,
            table: args.table,
            isTyped: rpcIsTyped,
          });
        }
      }
    }
  } catch (err) {
    // Unexpected errors — rethrow as structured response to avoid CLI crashes.
    const message = err instanceof Error ? err.message : String(err);
    return buildErrorResponse<ColumnReadResult>(
      'column-reads',
      { ...args, limit },
      'parse_error',
      `Unexpected error during column-reads traversal: ${message}`,
      'Check that the project compiles without errors.',
      Date.now() - started,
    );
  }

  return {
    query: 'column-reads',
    args: { ...args, limit },
    results: rows,
    truncated: totalEstimated > rows.length,
    totalEstimated: totalEstimated > rows.length ? totalEstimated : undefined,
    durationMs: Date.now() - started,
  };
}

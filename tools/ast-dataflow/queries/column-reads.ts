import { type Project, SyntaxKind, type CallExpression } from 'ts-morph';
import type {
  ColumnReadsArgs,
  ColumnReadResult,
  ColumnReadMethod,
  QueryResponse,
} from '../types';
import { buildErrorResponse, isTestFilePath, toRepoRelative } from '../resolve';
import {
  collectChain,
  detectIsTyped,
  findFromCalls,
  objectLiteralHasKey,
} from './supabase-shared';

const DEFAULT_LIMIT = 200;

/**
 * Chain methods that name a column as their first string argument and are
 * read/filter sites (not payload writes). `.eq()` keeps its dedicated method
 * value for backwards compatibility; the rest report as `method: 'filter'`
 * with the actual chain method recorded in `columnPath`'s row context via
 * `chainMethod` (see ColumnReadResult).
 */
const FILTER_METHODS: ReadonlySet<string> = new Set([
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'like',
  'ilike',
  'is',
  'in',
  'contains',
  'containedBy',
  'overlaps',
  'textSearch',
]);

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
 *   top-level tokens are matched. Nested blocks are stripped iteratively so
 *   relations-within-relations do not leave stray tokens.
 */
function selectContainsColumn(
  selectStr: string,
  targetColumn: string,
): boolean {
  // Strip nested relation blocks innermost-first so nested parentheses are
  // fully removed (a single non-greedy pass leaves `rel)` fragments behind).
  let withoutRelations = selectStr;
  let prev = '';
  while (prev !== withoutRelations) {
    prev = withoutRelations;
    withoutRelations = withoutRelations.replace(/\([^()]*\)/gs, '');
  }
  const tokens = withoutRelations
    .split(',')
    .map((t) => {
      const trimmed = t.trim();
      // Supabase colon-alias: `<alias>:<column>` — the actual column is on
      // the right of the first `:`. Without a `:`, the whole token is the
      // column name.
      const colonIdx = trimmed.indexOf(':');
      const columnPart =
        colonIdx >= 0 ? trimmed.slice(colonIdx + 1).trim() : trimmed;
      // Strip any trailing whitespace-separated alias (defensive against
      // SQL-style `'project_id as pid'`).
      return columnPart.split(/\s+/)[0].trim();
    })
    .filter(Boolean);
  return tokens.includes(targetColumn);
}

/**
 * Walk a source file and collect `.rpc('fnName', { column: value })` calls
 * where the payload object literal has a key matching `targetColumn`.
 *
 * These are direct calls on the client object (not chained from `.from()`),
 * so they are handled separately.
 */
function findRpcCalls(
  sf: import('ts-morph').SourceFile,
  column: string,
): CallExpression[] {
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

/** Extract the literal string value of a chain argument, or null. */
function literalArgValue(arg: import('ts-morph').Node): string | null {
  if (arg.getKind() === SyntaxKind.StringLiteral) {
    return (arg as import('ts-morph').StringLiteral).getLiteralValue();
  }
  if (arg.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral) {
    return (
      arg as import('ts-morph').NoSubstitutionTemplateLiteral
    ).getLiteralValue();
  }
  return null;
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

      if (excludeTests && isTestFilePath(relPath)) continue;

      // ── .from('table').<chain> hits ──────────────────────────────────────
      const fromCalls = findFromCalls(sf, args.table);

      for (const fromCallExpr of fromCalls) {
        const isTyped = detectIsTyped(fromCallExpr, args.table);
        const confidence = isTyped ? ('exact' as const) : ('indirect' as const);
        const chain = collectChain(fromCallExpr);

        for (const { method, callExpr } of chain) {
          const chainArgs = callExpr.getArguments();
          let hit: {
            method: ColumnReadMethod;
            columnPath: string;
            chainMethod?: string;
          } | null = null;

          if (method === 'select' && chainArgs.length >= 1) {
            const selectStr = literalArgValue(chainArgs[0]);
            if (selectStr !== null) {
              if (selectStr === '*') {
                // Wildcard select — may read the target column but we cannot
                // confirm without runtime data. Emit a wildcard-confidence row.
                hit = { method: 'select', columnPath: '*' };
              } else if (selectContainsColumn(selectStr, args.column)) {
                hit = { method: 'select', columnPath: args.column };
              }
            }
          } else if (method === 'eq' && chainArgs.length >= 1) {
            if (literalArgValue(chainArgs[0]) === args.column) {
              hit = { method: 'eq', columnPath: args.column };
            }
          } else if (FILTER_METHODS.has(method) && chainArgs.length >= 1) {
            if (literalArgValue(chainArgs[0]) === args.column) {
              hit = {
                method: 'filter',
                columnPath: args.column,
                chainMethod: method,
              };
            }
          } else if (method === 'order' && chainArgs.length >= 1) {
            if (literalArgValue(chainArgs[0]) === args.column) {
              hit = { method: 'order', columnPath: args.column };
            }
          } else if (method === 'match' && chainArgs.length >= 1) {
            const arg = chainArgs[0];
            if (arg.getKind() === SyntaxKind.ObjectLiteralExpression) {
              const objLiteral =
                arg as import('ts-morph').ObjectLiteralExpression;
              if (objectLiteralHasKey(objLiteral, args.column)) {
                hit = { method: 'match', columnPath: args.column };
              }
            }
          }

          if (hit) {
            totalEstimated++;
            if (rows.length < limit) {
              const lineCol = sf.getLineAndColumnAtPos(callExpr.getStart());
              // Wildcard selects always use 'wildcard' confidence regardless of
              // client typing — we cannot confirm the specific column is read.
              const rowConfidence =
                hit.columnPath === '*' ? ('wildcard' as const) : confidence;
              rows.push({
                file: relPath,
                line: lineCol.line,
                column: lineCol.column,
                confidence: rowConfidence,
                method: hit.method,
                columnPath: hit.columnPath,
                table: args.table,
                isTyped,
                ...(hit.chainMethod ? { chainMethod: hit.chainMethod } : {}),
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
            const clientExpr = (
              rpcExpr as import('ts-morph').PropertyAccessExpression
            ).getExpression();
            const symbol = clientExpr.getType().getSymbol();
            if (symbol) {
              for (const decl of symbol.getDeclarations()) {
                if (decl.getKind() === SyntaxKind.VariableDeclaration) {
                  const init = (
                    decl as import('ts-morph').VariableDeclaration
                  ).getInitializer();
                  if (init?.getKind() === SyntaxKind.CallExpression) {
                    if (
                      (init as CallExpression).getTypeArguments().length > 0
                    ) {
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

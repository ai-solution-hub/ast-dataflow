import { type Project, SyntaxKind, type Node } from 'ts-morph';
import type {
  ColumnWritesArgs,
  ColumnWriteResult,
  ColumnWriteMethod,
  QueryResponse,
} from '../types';
import { buildErrorResponse, isTestFilePath, toRepoRelative } from '../resolve';
import {
  collectChain,
  detectIsTyped,
  findFromCalls,
  objectLiteralHasKey,
  objectLiteralHasSpread,
} from './supabase-shared';

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
 * Try to resolve an Identifier argument (e.g. `payload` in `.update(payload)`)
 * to an object literal — the "one-hop spread chase".
 *
 * Resolution is symbol-based (type-checker): the identifier's declaration must
 * be a VariableDeclaration whose initialiser is an ObjectLiteralExpression
 * (optionally wrapped in `as` / `satisfies` / parentheses). Function
 * parameters, imported bindings, and computed values are NOT followed —
 * callers report those as `indirect`.
 *
 * Returns the object literal if resolved, or null.
 */
function resolveOneHopObjectLiteral(
  identifierNode: Node,
): import('ts-morph').ObjectLiteralExpression | null {
  if (identifierNode.getKind() !== SyntaxKind.Identifier) return null;

  try {
    const decls = identifierNode.getSymbol()?.getDeclarations() ?? [];
    for (const decl of decls) {
      if (decl.getKind() !== SyntaxKind.VariableDeclaration) continue;
      let init: Node | undefined = (
        decl as import('ts-morph').VariableDeclaration
      ).getInitializer();
      // Unwrap `{...} as const`, `{...} satisfies T`, `({...})`.
      while (
        init &&
        (init.getKind() === SyntaxKind.AsExpression ||
          init.getKind() === SyntaxKind.SatisfiesExpression ||
          init.getKind() === SyntaxKind.ParenthesizedExpression)
      ) {
        init = (
          init as unknown as { getExpression: () => Node }
        ).getExpression();
      }
      if (init?.getKind() === SyntaxKind.ObjectLiteralExpression) {
        return init as import('ts-morph').ObjectLiteralExpression;
      }
    }
  } catch {
    // Symbol resolution failed — treat as untraceable.
  }

  return null;
}

/**
 * Inspect an object-literal or identifier argument to a write method and
 * determine whether it contains the target column.
 *
 * Returns `{ found: false }` when the argument is an object literal that
 * clearly does NOT contain the target key — which requires both no matching
 * key AND no spread property (a spread can carry the column invisibly).
 *
 * Returns `{ found: true, confidence }` when the column is present or cannot
 * be ruled out:
 * - `'exact'`    — typed client + literal key confirmed.
 * - `'indirect'` — untyped client, spread-carried, or argument cannot be
 *                  traced statically.
 *
 * Array-form arguments (`.insert([{ ... }])`) are supported by inspecting
 * every element; non-object-literal elements (identifiers, spreads, calls)
 * prevent ruling the column out and downgrade to `indirect`.
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
    if (objectLiteralHasSpread(objLit)) {
      // `{ ...payload }` — the spread source may carry the target column;
      // cannot confirm absence.
      return { found: true, confidence: 'indirect' };
    }
    return { found: false };
  }

  // Array literal: .insert([{ project_id: value }, ...])
  if (kind === SyntaxKind.ArrayLiteralExpression) {
    const arrLit = argNode as import('ts-morph').ArrayLiteralExpression;
    let allElementsRuledOut = true;
    for (const elem of arrLit.getElements()) {
      if (elem.getKind() === SyntaxKind.ObjectLiteralExpression) {
        const objLit = elem as import('ts-morph').ObjectLiteralExpression;
        if (objectLiteralHasKey(objLit, targetKey)) {
          return { found: true, confidence: isTyped ? 'exact' : 'indirect' };
        }
        if (objectLiteralHasSpread(objLit)) {
          allElementsRuledOut = false;
        }
      } else {
        // Identifier / spread / call element — cannot inspect statically.
        allElementsRuledOut = false;
      }
    }
    if (allElementsRuledOut) {
      return { found: false };
    }
    return { found: true, confidence: 'indirect' };
  }

  // Identifier: one-hop spread chase.
  if (kind === SyntaxKind.Identifier) {
    const resolved = resolveOneHopObjectLiteral(argNode);
    if (resolved !== null) {
      if (objectLiteralHasKey(resolved, targetKey)) {
        // Traced one hop to a local const with the target key.
        return { found: true, confidence: isTyped ? 'exact' : 'indirect' };
      }
      if (!objectLiteralHasSpread(resolved)) {
        // Fully-literal object without the key — the column is provably absent.
        return { found: false };
      }
      return { found: true, confidence: 'indirect' };
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

import { resolve } from 'node:path';
import {
  Project,
  SyntaxKind,
  type Node,
  type SourceFile,
} from 'ts-morph';
import type { Confidence, QueryResponse, BaseResult } from '../types';
import {
  buildErrorResponse,
  findEnclosing,
  toRepoRelative,
} from '../resolve';

// ---------------------------------------------------------------------------
// Types (inline — WP3 will promote these to types.ts)
// ---------------------------------------------------------------------------

export type FlowTraceHopKind =
  | 'assignment'
  | 'destructure'
  | 'argument'
  | 'return'
  | 'spread'
  | 'mutation'
  | 'apiCall'
  | 'write';

export interface FlowTraceRow extends BaseResult {
  /** 1-indexed hop number within the full trace (depth-first pre-order). */
  hop: number;
  /** Hop index of the upstream hop that produced this one. Absent for hop 1 (origin row). */
  parentHop?: number;
  /** Hop classification. */
  kind: FlowTraceHopKind;
  /** Repo-root-relative path to the file where this hop occurs. */
  file: string;
  /** 1-based line of the hop node. */
  line: number;
  /** 1-based column of the hop node. */
  column: number;
  /** Confidence of this hop's resolution. */
  confidence: Confidence;
  /** Name of the enclosing function / method / 'module top-level'. */
  enclosing: string;
  /** The origin declaration (same for every row in the trace). */
  origin: {
    file: string;
    line: number;
    column: number;
    /** Identifier name at the origin site. */
    symbol: string;
  };
}

export interface FlowTraceArgs {
  /** Repo-root-relative path to the file containing the origin node. */
  originFile: string;
  /** 1-based line number of the origin declaration. */
  originLine: number;
  /** 1-based column number of the origin declaration. */
  originColumn: number;
  /**
   * Maximum number of hops per branch. Default: 8. Minimum: 1. Maximum: 20.
   */
  maxDepth?: number;
  /**
   * When true, on an `argument` hop the walk descends into the resolved
   * callee's parameter and continues. Default: false.
   */
  interFunction?: boolean;
  /** Maximum result rows (cap). Default: 200. */
  limit?: number;
  /** Exclude test files from the walk. Default: false. */
  excludeTests?: boolean;
}

// ---------------------------------------------------------------------------
// Error codes (string literals; WP3 adds them to ErrorKind union in types.ts)
// ---------------------------------------------------------------------------
const ORIGIN_NOT_RESOLVABLE = 'ORIGIN_NOT_RESOLVABLE' as const;
const ORIGIN_NOT_VALUE_PRODUCING = 'ORIGIN_NOT_VALUE_PRODUCING' as const;

const DEFAULT_LIMIT = 200;
const DEFAULT_MAX_DEPTH = 8;

// ---------------------------------------------------------------------------
// Origin resolution
// ---------------------------------------------------------------------------

type OriginResult =
  | { ok: true; node: Node; sf: SourceFile; symbol: string }
  | {
      ok: false;
      code:
        | typeof ORIGIN_NOT_RESOLVABLE
        | typeof ORIGIN_NOT_VALUE_PRODUCING;
      message: string;
      hint: string;
    };

/**
 * Resolve the origin node at (file, line, column).
 * Returns a VariableDeclaration, ParameterDeclaration, or BindingElement
 * at the given 1-based position, or a structured error.
 */
function resolveOrigin(
  project: Project,
  repoRoot: string,
  originFile: string,
  originLine: number,
  originColumn: number,
): OriginResult {
  const absPath = resolve(repoRoot, originFile);
  const sf = project.getSourceFile(absPath);
  if (!sf) {
    return {
      ok: false,
      code: ORIGIN_NOT_RESOLVABLE,
      message: `File not in project: ${originFile}`,
      hint: 'Check file path is repo-root-relative.',
    };
  }

  // Convert 1-based line/column to a character position (both 0-based).
  let pos: number;
  try {
    pos = sf.compilerNode.getPositionOfLineAndCharacter(
      originLine - 1,
      originColumn - 1,
    );
  } catch {
    return {
      ok: false,
      code: ORIGIN_NOT_RESOLVABLE,
      message: `No node at ${originFile}:${originLine}:${originColumn}`,
      hint: 'Check file path is repo-root-relative and line/column are 1-based.',
    };
  }

  // Find the innermost node at that position.
  const node = sf.getDescendantAtPos(pos);
  if (!node) {
    return {
      ok: false,
      code: ORIGIN_NOT_RESOLVABLE,
      message: `No AST node at ${originFile}:${originLine}:${originColumn}`,
      hint: 'Check file path is repo-root-relative and line/column are 1-based.',
    };
  }

  // Walk up to find the nearest relevant declaration node.
  let current: Node | undefined = node;
  while (current) {
    const kind = current.getKind();
    if (
      kind === SyntaxKind.VariableDeclaration ||
      kind === SyntaxKind.Parameter ||
      kind === SyntaxKind.BindingElement
    ) {
      break;
    }
    // Type alias — not value-producing.
    if (kind === SyntaxKind.TypeAliasDeclaration) {
      return {
        ok: false,
        code: ORIGIN_NOT_VALUE_PRODUCING,
        message: `Node at ${originFile}:${originLine}:${originColumn} is a type alias, not a value-producing declaration.`,
        hint: "Only value-producing declarations can be traced; trace the callee's parameter directly.",
      };
    }
    current = current.getParent();
  }

  if (!current) {
    return {
      ok: false,
      code: ORIGIN_NOT_RESOLVABLE,
      message: `Node at ${originFile}:${originLine}:${originColumn} is not a VariableDeclaration, ParameterDeclaration, or BindingElement.`,
      hint: 'Check file path is repo-root-relative and line/column are 1-based.',
    };
  }

  // Extract the symbol name.
  let symbol = '<unknown>';
  try {
    symbol = (current as { getName: () => string }).getName();
  } catch {
    // getName() not available — leave as '<unknown>'
  }

  return { ok: true, node: current, sf, symbol };
}

// ---------------------------------------------------------------------------
// Walker state
// ---------------------------------------------------------------------------

interface WalkerState {
  rows: FlowTraceRow[];
  hopCounter: number;
  visited: Set<string>;
  limit: number;
  totalEstimated: number;
  maxDepth: number;
  interFunction: boolean;
  repoRoot: string;
  origin: FlowTraceRow['origin'];
}

function visitedKey(file: string, line: number, column: number): string {
  return `${file}:${line}:${column}`;
}

/**
 * Find the nearest enclosing function-like body for a given node.
 * Returns the SourceFile if the node is at module top-level.
 */
function findEnclosingScope(node: Node): Node {
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
 * Return true if the VariableDeclaration's name node is an object or array
 * binding pattern (i.e. this is a destructuring declaration, not a plain
 * identifier assignment).
 */
function isDestructuringDeclaration(varDecl: Node): boolean {
  const nameNode = (varDecl as import('ts-morph').VariableDeclaration).getNameNode();
  const nameKind = nameNode.getKind();
  return (
    nameKind === SyntaxKind.ObjectBindingPattern ||
    nameKind === SyntaxKind.ArrayBindingPattern
  );
}

// ---------------------------------------------------------------------------
// Sink classification helpers (WP2)
// ---------------------------------------------------------------------------

/**
 * Mutation method names that classify a call-on-receiver as a `mutation` sink.
 *
 * Decision (WP2): only Array/Map/Set mutating methods whose primary purpose is
 * to modify the receiver in-place. We include the most common Array mutators
 * plus Map/Set equivalents. `.sort()` and `.reverse()` are included because
 * they mutate in-place even though they also return the array.
 * Spec test 7 requires `.push` coverage as minimum; the rest are reasonable
 * extensions that match the spec's example ("list.push(value)").
 */
const MUTATION_METHODS: ReadonlySet<string> = new Set([
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'sort',
  'reverse',
  'fill',
  'copyWithin',
  // Map / Set
  'set',
  'delete',
  'add',
  'clear',
]);

/**
 * Supabase chain terminal mutating method names for `apiCall` sink detection.
 *
 * OQ-FT2 LOCK: the hop is emitted at the TERMINAL mutating call (e.g.
 * `.insert()`), not at the chain root (`.from()`). This is consistent with
 * `column-writes.ts` which records the mutation method, not `.from()`.
 *
 * `.select()` is excluded: it is a read terminal, not a mutation, and is
 * typically non-terminal (e.g. `.insert({...}).select()` — here .select is
 * a modifier, not the canonical sink).
 *
 * `fetch` and `axios` calls are detected separately (see FETCH_METHODS).
 */
const SUPABASE_SINK_METHODS: ReadonlySet<string> = new Set([
  'insert',
  'update',
  'upsert',
  'delete',
  'rpc',
]);

/**
 * File-system write function names for `write` sink detection.
 * Scoped to the callee name (last segment of the member expression or
 * bare identifier).
 *
 * We match only the function name, not the full chain, to avoid false-positive
 * failures when the receiver is `fs`, `promises`, or a custom wrapper.
 * Spec test 9 requires `writeFile` coverage as minimum.
 */
const FS_WRITE_METHODS: ReadonlySet<string> = new Set([
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
]);

/**
 * Return the callee name (rightmost identifier) from a CallExpression.
 * E.g. `fs.writeFile(...)` → 'writeFile'.
 * Returns null if the expression is not a simple member or identifier access.
 */
function calleeMethodName(callExpr: import('ts-morph').CallExpression): string | null {
  const expr = callExpr.getExpression();
  if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
    return (expr as import('ts-morph').PropertyAccessExpression).getName();
  }
  if (expr.getKind() === SyntaxKind.Identifier) {
    return expr.getText();
  }
  return null;
}

/**
 * Return true if `useNode` (an Identifier for the tracked name) is the
 * receiver of a PropertyAccessExpression whose parent is a CallExpression
 * with a known mutation method.
 *
 * Pattern: `list.push(4)` — useNode is `list`, parent is PropAccess `list.push`,
 * grandparent is CallExpr `list.push(4)`, method is `push` ∈ MUTATION_METHODS.
 */
function isMutationReceiver(useNode: Node): import('ts-morph').CallExpression | null {
  const parent = useNode.getParent();
  if (!parent) return null;
  if (parent.getKind() !== SyntaxKind.PropertyAccessExpression) return null;
  const propAccess = parent as import('ts-morph').PropertyAccessExpression;
  // useNode must be the object (expression) of the property access, not the name.
  if (propAccess.getExpression().getStart() !== useNode.getStart()) return null;
  const methodName = propAccess.getName();
  if (!MUTATION_METHODS.has(methodName)) return null;
  const grandParent = propAccess.getParent();
  if (!grandParent || grandParent.getKind() !== SyntaxKind.CallExpression) return null;
  // Confirm the property access is the callee of the call, not an argument.
  const callExpr = grandParent as import('ts-morph').CallExpression;
  if (callExpr.getExpression().getStart() !== propAccess.getStart()) return null;
  return callExpr;
}

/**
 * Return true if `callExpr` is a Supabase chain terminal mutating call
 * (`.insert()`, `.update()`, `.upsert()`, `.delete()`, `.rpc()`).
 *
 * OQ-FT2: we check only the immediate method name; the value flowing into
 * it is confirmed by the caller checking that `useNode` is an argument.
 */
function isSupabaseSinkCall(callExpr: import('ts-morph').CallExpression): boolean {
  const name = calleeMethodName(callExpr);
  return name !== null && SUPABASE_SINK_METHODS.has(name);
}

/**
 * Return true if `callExpr` is a known file-system write call.
 */
function isFsWriteCall(callExpr: import('ts-morph').CallExpression): boolean {
  const name = calleeMethodName(callExpr);
  return name !== null && FS_WRITE_METHODS.has(name);
}

// ---------------------------------------------------------------------------
// Core walk — forward-only, intra-function scope (WP1 + WP2 sinks)
// ---------------------------------------------------------------------------

/**
 * Walk forward from a binding `name` declared at `declNode`.
 * Handles: assignment, argument, return hops (WP1).
 * Also handles: spread, mutation, apiCall, write sinks; indirect tier (WP2).
 * Destructuring is handled by walkDestructuring (separate pass).
 */
function walkForward(
  declNode: Node,
  name: string,
  sf: SourceFile,
  depth: number,
  parentHopNumber: number,
  state: WalkerState,
): void {
  // Depth guard: WP3 will emit depthCutoff; for now just stop.
  if (depth > state.maxDepth) return;

  const scope = findEnclosingScope(declNode);
  const declPos = declNode.getStart();
  const relFile = toRepoRelative(state.repoRoot, sf.getFilePath());

  // Scan for all identifier uses of `name` within the enclosing scope,
  // occurring after the declaration.
  for (const useNode of scope.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (useNode.getText() !== name) continue;
    if (useNode.getStart() <= declPos) continue;

    const parent = useNode.getParent();
    if (!parent) continue;
    const parentKind = parent.getKind();

    // -------------------------------------------------------------------
    // Spread hop (WP2): value spread into an object or array literal.
    // SpreadAssignment: `{ ...payload, extra }` (object literal)
    // SpreadElement: `[ ...payload ]` (array literal)
    // Both emit confidence 'wildcard' and are terminal (no further descent).
    // -------------------------------------------------------------------
    if (
      parentKind === SyntaxKind.SpreadAssignment ||
      parentKind === SyntaxKind.SpreadElement
    ) {
      const spreadNode = parent;
      const spreadLineCol = sf.getLineAndColumnAtPos(spreadNode.getStart());
      const key = visitedKey(relFile, spreadLineCol.line, spreadLineCol.column);
      if (state.visited.has(key)) continue;

      state.totalEstimated++;
      const hopNum = ++state.hopCounter;
      state.visited.add(key);

      if (state.rows.length < state.limit) {
        state.rows.push({
          hop: hopNum,
          parentHop: parentHopNumber,
          kind: 'spread',
          file: relFile,
          line: spreadLineCol.line,
          column: spreadLineCol.column,
          confidence: 'wildcard',
          enclosing: findEnclosing(spreadNode),
          origin: state.origin,
        });
      }
      // spread is terminal — no further descent.
      continue;
    }

    // -------------------------------------------------------------------
    // Mutation hop (WP2): identifier is receiver of a mutating method call.
    // e.g. `list.push(4)` — `list` is the receiver of `.push()`.
    // Terminal — no further descent.
    // -------------------------------------------------------------------
    if (parentKind === SyntaxKind.PropertyAccessExpression) {
      const mutationCall = isMutationReceiver(useNode);
      if (mutationCall) {
        const callLineCol = sf.getLineAndColumnAtPos(mutationCall.getStart());
        const key = visitedKey(relFile, callLineCol.line, callLineCol.column);
        if (state.visited.has(key)) continue;

        state.totalEstimated++;
        const hopNum = ++state.hopCounter;
        state.visited.add(key);

        if (state.rows.length < state.limit) {
          state.rows.push({
            hop: hopNum,
            parentHop: parentHopNumber,
            kind: 'mutation',
            file: relFile,
            line: callLineCol.line,
            column: callLineCol.column,
            confidence: 'exact',
            enclosing: findEnclosing(mutationCall),
            origin: state.origin,
          });
        }
        // mutation is terminal.
        continue;
      }
      // Non-mutation property access: skip (e.g. `obj.id` — not a tracked hop).
      continue;
    }

    // -------------------------------------------------------------------
    // Assignment hop: const b = a; (plain identifier assignment)
    // Skip if the parent VarDecl is a destructuring pattern.
    // Also handles indirect tier: const val = obj[key] where key is dynamic.
    // -------------------------------------------------------------------
    if (parentKind === SyntaxKind.VariableDeclaration) {
      const varDecl = parent as import('ts-morph').VariableDeclaration;
      const init = varDecl.getInitializer();

      // Only interested when this identifier IS the initialiser (RHS).
      if (!init || init.getStart() !== useNode.getStart()) continue;

      // Skip destructuring declarations — handled by walkDestructuring.
      if (isDestructuringDeclaration(varDecl)) continue;

      const newName = varDecl.getName();
      const declLineCol = sf.getLineAndColumnAtPos(varDecl.getStart());
      const key = visitedKey(relFile, declLineCol.line, declLineCol.column);
      if (state.visited.has(key)) continue;

      state.totalEstimated++;
      const hopNum = ++state.hopCounter;
      state.visited.add(key);

      if (state.rows.length < state.limit) {
        state.rows.push({
          hop: hopNum,
          parentHop: parentHopNumber,
          kind: 'assignment',
          file: relFile,
          line: declLineCol.line,
          column: declLineCol.column,
          confidence: 'exact',
          enclosing: findEnclosing(varDecl),
          origin: state.origin,
        });
      }

      // Recurse on the new binding (depth + 1).
      walkForward(varDecl, newName, sf, depth + 1, hopNum, state);
      walkDestructuring(varDecl, newName, sf, depth + 1, hopNum, state);
      continue;
    }

    // -------------------------------------------------------------------
    // Indirect tier (WP2): identifier is the receiver of a dynamic
    // element access: `obj[key]` where key is not a string literal.
    // The identifier appears as the expression of an ElementAccessExpression.
    // Emit with confidence 'indirect'; do not descend further.
    // -------------------------------------------------------------------
    if (parentKind === SyntaxKind.ElementAccessExpression) {
      const elemAccess = parent as import('ts-morph').ElementAccessExpression;
      // useNode must be the receiver (expression), not the argument (key).
      if (elemAccess.getExpression().getStart() !== useNode.getStart()) continue;
      // Check whether the argument is a string literal (exact) or dynamic (indirect).
      const argExpr = elemAccess.getArgumentExpression();
      const isStaticKey = argExpr && argExpr.getKind() === SyntaxKind.StringLiteral;
      if (isStaticKey) {
        // Static key — this is a plain property read, not indirect.
        // Treat as an assignment if the parent context is a VarDecl; skip otherwise.
        continue;
      }

      // Dynamic key — emit indirect hop.
      const accessLineCol = sf.getLineAndColumnAtPos(elemAccess.getStart());
      const key = visitedKey(relFile, accessLineCol.line, accessLineCol.column);
      if (state.visited.has(key)) continue;

      state.totalEstimated++;
      const hopNum = ++state.hopCounter;
      state.visited.add(key);

      if (state.rows.length < state.limit) {
        state.rows.push({
          hop: hopNum,
          parentHop: parentHopNumber,
          kind: 'assignment',
          file: relFile,
          line: accessLineCol.line,
          column: accessLineCol.column,
          confidence: 'indirect',
          enclosing: findEnclosing(elemAccess),
          origin: state.origin,
        });
      }
      // indirect is terminal — no further descent.
      continue;
    }

    // -------------------------------------------------------------------
    // Argument hop: doSomething(value)
    // The identifier is a direct call argument.
    // WP2 checks for apiCall / write sinks BEFORE emitting a generic argument hop.
    // -------------------------------------------------------------------
    if (parentKind === SyntaxKind.CallExpression) {
      const callExpr = parent as import('ts-morph').CallExpression;
      const callArgs = callExpr.getArguments();
      if (!callArgs.some((a) => a.getStart() === useNode.getStart())) continue;

      const callLineCol = sf.getLineAndColumnAtPos(callExpr.getStart());
      const key = visitedKey(relFile, callLineCol.line, callLineCol.column);
      if (state.visited.has(key)) continue;

      // --- apiCall sink (WP2) ---
      // OQ-FT2: hop emitted at the terminal mutating call (e.g. .insert()),
      // which is the CallExpression that directly receives the identifier as argument.
      if (isSupabaseSinkCall(callExpr)) {
        state.totalEstimated++;
        const hopNum = ++state.hopCounter;
        state.visited.add(key);

        if (state.rows.length < state.limit) {
          state.rows.push({
            hop: hopNum,
            parentHop: parentHopNumber,
            kind: 'apiCall',
            file: relFile,
            line: callLineCol.line,
            column: callLineCol.column,
            confidence: 'exact',
            enclosing: findEnclosing(callExpr),
            origin: state.origin,
          });
        }
        // apiCall is terminal.
        continue;
      }

      // --- write sink (WP2) ---
      if (isFsWriteCall(callExpr)) {
        state.totalEstimated++;
        const hopNum = ++state.hopCounter;
        state.visited.add(key);

        if (state.rows.length < state.limit) {
          state.rows.push({
            hop: hopNum,
            parentHop: parentHopNumber,
            kind: 'write',
            file: relFile,
            line: callLineCol.line,
            column: callLineCol.column,
            confidence: 'exact',
            enclosing: findEnclosing(callExpr),
            origin: state.origin,
          });
        }
        // write is terminal.
        continue;
      }

      // --- generic argument hop ---
      state.totalEstimated++;
      const hopNum = ++state.hopCounter;
      state.visited.add(key);

      if (state.rows.length < state.limit) {
        state.rows.push({
          hop: hopNum,
          parentHop: parentHopNumber,
          kind: 'argument',
          file: relFile,
          line: callLineCol.line,
          column: callLineCol.column,
          confidence: 'exact',
          enclosing: findEnclosing(callExpr),
          origin: state.origin,
        });
      }

      // interFunction: false (WP1) → argument hop is terminal.
      // WP3 adds descent when interFunction: true.
      continue;
    }

    // -------------------------------------------------------------------
    // Return hop: return data;
    // The identifier is the return expression of a ReturnStatement.
    // -------------------------------------------------------------------
    if (parentKind === SyntaxKind.ReturnStatement) {
      const retStmt = parent as import('ts-morph').ReturnStatement;
      const retExpr = retStmt.getExpression();
      if (!retExpr || retExpr.getStart() !== useNode.getStart()) continue;

      const retLineCol = sf.getLineAndColumnAtPos(retStmt.getStart());
      const key = visitedKey(relFile, retLineCol.line, retLineCol.column);
      if (state.visited.has(key)) continue;

      state.totalEstimated++;
      const hopNum = ++state.hopCounter;
      state.visited.add(key);

      if (state.rows.length < state.limit) {
        state.rows.push({
          hop: hopNum,
          parentHop: parentHopNumber,
          kind: 'return',
          file: relFile,
          line: retLineCol.line,
          column: retLineCol.column,
          confidence: 'exact',
          enclosing: findEnclosing(retStmt),
          origin: state.origin,
        });
      }

      // Return hop is terminal for intra-function walk (WP1).
      continue;
    }
  }
}

/**
 * Walk destructuring patterns where `name` is the initialiser.
 * Emits one `destructure` hop per BindingElement for each
 * `const { a, b } = name` or `const [x] = name` in scope.
 */
function walkDestructuring(
  declNode: Node,
  name: string,
  sf: SourceFile,
  depth: number,
  parentHopNumber: number,
  state: WalkerState,
): void {
  if (depth > state.maxDepth) return;

  const scope = findEnclosingScope(declNode);
  const declPos = declNode.getStart();
  const relFile = toRepoRelative(state.repoRoot, sf.getFilePath());

  for (const useNode of scope.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (useNode.getText() !== name) continue;
    if (useNode.getStart() <= declPos) continue;

    const parent = useNode.getParent();
    if (!parent || parent.getKind() !== SyntaxKind.VariableDeclaration) continue;

    const varDecl = parent as import('ts-morph').VariableDeclaration;
    const init = varDecl.getInitializer();
    // Only when this identifier IS the initialiser (RHS).
    if (!init || init.getStart() !== useNode.getStart()) continue;
    // Only for destructuring name patterns.
    if (!isDestructuringDeclaration(varDecl)) continue;

    // Emit one destructure hop per BindingElement.
    const nameNode = varDecl.getNameNode();
    const bindingElements = nameNode.getDescendantsOfKind(
      SyntaxKind.BindingElement,
    );

    for (const bindingElem of bindingElements) {
      const elemLineCol = sf.getLineAndColumnAtPos(bindingElem.getStart());
      const key = visitedKey(relFile, elemLineCol.line, elemLineCol.column);
      if (state.visited.has(key)) continue;

      state.totalEstimated++;
      const hopNum = ++state.hopCounter;
      state.visited.add(key);

      if (state.rows.length < state.limit) {
        state.rows.push({
          hop: hopNum,
          parentHop: parentHopNumber,
          kind: 'destructure',
          file: relFile,
          line: elemLineCol.line,
          column: elemLineCol.column,
          confidence: 'exact',
          enclosing: findEnclosing(bindingElem),
          origin: state.origin,
        });
      }

      // Recurse on the destructured binding.
      const elemName = bindingElem.getName();
      if (elemName) {
        walkForward(bindingElem, elemName, sf, depth + 1, hopNum, state);
        walkDestructuring(bindingElem, elemName, sf, depth + 1, hopNum, state);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function flowTrace(
  args: FlowTraceArgs,
  project: Project,
  repoRoot: string,
): Promise<QueryResponse<FlowTraceRow>> {
  const started = Date.now();
  const limit = args.limit ?? DEFAULT_LIMIT;
  const maxDepth = Math.min(
    Math.max(args.maxDepth ?? DEFAULT_MAX_DEPTH, 1),
    20,
  );
  const interFunction = args.interFunction ?? false;

  // --- Resolve origin ---
  const originResult = resolveOrigin(
    project,
    repoRoot,
    args.originFile,
    args.originLine,
    args.originColumn,
  );

  if (!originResult.ok) {
    return buildErrorResponse<FlowTraceRow>(
      'flow-trace',
      { ...args, limit, maxDepth },
      // Cast: WP3 will extend ErrorKind with these two codes.
      originResult.code as string as import('../types').ErrorKind,
      originResult.message,
      originResult.hint,
      Date.now() - started,
    );
  }

  const { node: originNode, sf, symbol } = originResult;

  const relFile = toRepoRelative(repoRoot, sf.getFilePath());
  const originLineCol = sf.getLineAndColumnAtPos(originNode.getStart());

  const originMeta: FlowTraceRow['origin'] = {
    file: relFile,
    line: originLineCol.line,
    column: originLineCol.column,
    symbol,
  };

  const state: WalkerState = {
    rows: [],
    hopCounter: 0,
    visited: new Set(),
    limit,
    totalEstimated: 0,
    maxDepth,
    interFunction,
    repoRoot,
    origin: originMeta,
  };

  // --- Emit origin row (hop 1 — always 'assignment' kind per spec §Output shape) ---
  const originKey = visitedKey(relFile, originLineCol.line, originLineCol.column);
  state.visited.add(originKey);
  state.totalEstimated++;
  const originHopNum = ++state.hopCounter;

  if (state.rows.length < state.limit) {
    state.rows.push({
      hop: originHopNum,
      // parentHop is absent on origin row (spec §Output shape §Origin row)
      kind: 'assignment',
      file: relFile,
      line: originLineCol.line,
      column: originLineCol.column,
      confidence: 'exact',
      enclosing: findEnclosing(originNode),
      origin: originMeta,
    });
  }

  // --- Walk forward from origin ---
  walkForward(originNode, symbol, sf, 1, originHopNum, state);
  walkDestructuring(originNode, symbol, sf, 1, originHopNum, state);

  return {
    query: 'flow-trace',
    args: { ...args, limit, maxDepth },
    results: state.rows,
    truncated: state.totalEstimated > state.rows.length,
    totalEstimated:
      state.totalEstimated > state.rows.length
        ? state.totalEstimated
        : undefined,
    durationMs: Date.now() - started,
  };
}

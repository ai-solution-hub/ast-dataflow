import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProject } from '@/lib/ast-dataflow';
import { flowTrace } from '@/lib/ast-dataflow/queries/flow-trace';

const FIXTURE_DIR = resolve(__dirname, 'fixtures', '14-flow-trace');
const NESTED_ARG_FIXTURE_DIR = resolve(__dirname, 'fixtures', '17b-nested-arg');

function makeProject() {
  return createProject({
    tsConfigFilePath: resolve(FIXTURE_DIR, 'tsconfig.json'),
    repoRoot: FIXTURE_DIR,
  });
}

// ---------------------------------------------------------------------------
// Test 1: Assignment chain happy path
// Fixture: 01-assignment-chain.ts — linear A→B→C chain
// Expected: 3 hops (origin a, assignment b=a, assignment c=b), parentHop linkage
// ---------------------------------------------------------------------------
describe('flow-trace — assignment chain', () => {
  it('emits origin row + two assignment hops with correct parentHop linkage', async () => {
    const { project, repoRoot } = makeProject();

    const response = await flowTrace(
      {
        originFile: '01-assignment-chain.ts',
        originLine: 8,
        originColumn: 9,
      },
      project,
      repoRoot,
    );

    expect(response.query).toBe('flow-trace');
    expect(response.error).toBeUndefined();
    // hop 1 = origin (a), hop 2 = b = a, hop 3 = c = b
    expect(response.results).toHaveLength(3);

    // hop 1: the origin itself
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hop: 1,
          kind: 'assignment',
          file: '01-assignment-chain.ts',
          line: 8,
          confidence: 'exact',
          enclosing: 'fn:processChain',
          origin: expect.objectContaining({
            symbol: 'a',
            file: '01-assignment-chain.ts',
            line: 8,
          }),
        }),
      ]),
    );

    // hop 2: b = a — parentHop must be 1
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hop: 2,
          kind: 'assignment',
          file: '01-assignment-chain.ts',
          line: 9,
          confidence: 'exact',
          parentHop: 1,
        }),
      ]),
    );

    // hop 3: c = b — parentHop must be 2
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hop: 3,
          kind: 'assignment',
          file: '01-assignment-chain.ts',
          line: 10,
          confidence: 'exact',
          parentHop: 2,
        }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Test 2: Object destructure (literal key)
// Fixture: 02-destructure-object.ts — const { id } = user
// Expected: 2 hops (origin user, destructure id), confidence exact
// ---------------------------------------------------------------------------
describe('flow-trace — object destructuring', () => {
  it('emits origin row + one destructure hop for { id } = user', async () => {
    const { project, repoRoot } = makeProject();

    const response = await flowTrace(
      {
        originFile: '02-destructure-object.ts',
        originLine: 6,
        originColumn: 9,
      },
      project,
      repoRoot,
    );

    expect(response.query).toBe('flow-trace');
    expect(response.error).toBeUndefined();
    expect(response.results).toHaveLength(2);

    // hop 1: origin (user)
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hop: 1,
          kind: 'assignment',
          file: '02-destructure-object.ts',
          line: 6,
          confidence: 'exact',
          origin: expect.objectContaining({ symbol: 'user' }),
        }),
      ]),
    );

    // hop 2: const { id } = user — destructure
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hop: 2,
          kind: 'destructure',
          file: '02-destructure-object.ts',
          line: 7,
          confidence: 'exact',
          parentHop: 1,
        }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Test 3: Array destructure
// Fixture: 02-destructure-array.ts — const [first] = list
// Expected: 2 hops (origin list, destructure first), confidence exact
// ---------------------------------------------------------------------------
describe('flow-trace — array destructuring', () => {
  it('emits origin row + one destructure hop for [first] = list', async () => {
    const { project, repoRoot } = makeProject();

    const response = await flowTrace(
      {
        originFile: '02-destructure-array.ts',
        originLine: 6,
        originColumn: 9,
      },
      project,
      repoRoot,
    );

    expect(response.query).toBe('flow-trace');
    expect(response.error).toBeUndefined();
    expect(response.results).toHaveLength(2);

    // hop 1: origin (list)
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hop: 1,
          kind: 'assignment',
          file: '02-destructure-array.ts',
          line: 6,
          confidence: 'exact',
          origin: expect.objectContaining({ symbol: 'list' }),
        }),
      ]),
    );

    // hop 2: const [first] = list — destructure
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hop: 2,
          kind: 'destructure',
          file: '02-destructure-array.ts',
          line: 7,
          confidence: 'exact',
          parentHop: 1,
        }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Test 5: Argument passthrough (intra-function)
// Fixture: 04-argument-intra.ts — doSomething(value)
// Expected: 2 hops (origin value, argument at call site). No descent into callee.
// ---------------------------------------------------------------------------
describe('flow-trace — argument passthrough (intra-function)', () => {
  it('emits origin row + one argument hop; does not descend into callee', async () => {
    const { project, repoRoot } = makeProject();

    const response = await flowTrace(
      {
        originFile: '04-argument-intra.ts',
        originLine: 10,
        originColumn: 9,
        interFunction: false,
      },
      project,
      repoRoot,
    );

    expect(response.query).toBe('flow-trace');
    expect(response.error).toBeUndefined();
    // Only 2 rows: origin + the argument hop at the call site
    expect(response.results).toHaveLength(2);

    // hop 1: origin (value)
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hop: 1,
          kind: 'assignment',
          file: '04-argument-intra.ts',
          line: 10,
          confidence: 'exact',
          origin: expect.objectContaining({ symbol: 'value' }),
        }),
      ]),
    );

    // hop 2: doSomething(value) call site — argument hop
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hop: 2,
          kind: 'argument',
          file: '04-argument-intra.ts',
          confidence: 'exact',
          parentHop: 1,
        }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Test 6: Return propagation
// Fixture: 04-return.ts — return data
// Expected: 2 hops (origin data, return). Walk ends after return (intra-function).
// ---------------------------------------------------------------------------
describe('flow-trace — return propagation', () => {
  it('emits origin row + one return hop; walk ends at return statement', async () => {
    const { project, repoRoot } = makeProject();

    const response = await flowTrace(
      {
        originFile: '04-return.ts',
        originLine: 6,
        originColumn: 9,
      },
      project,
      repoRoot,
    );

    expect(response.query).toBe('flow-trace');
    expect(response.error).toBeUndefined();
    expect(response.results).toHaveLength(2);

    // hop 1: origin (data)
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hop: 1,
          kind: 'assignment',
          file: '04-return.ts',
          line: 6,
          confidence: 'exact',
          origin: expect.objectContaining({ symbol: 'data' }),
        }),
      ]),
    );

    // hop 2: return data — return hop
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hop: 2,
          kind: 'return',
          file: '04-return.ts',
          confidence: 'exact',
          parentHop: 1,
        }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Test 14: Origin not resolvable
// No fixture needed — pass invalid coordinates to trigger ORIGIN_NOT_RESOLVABLE
// ---------------------------------------------------------------------------
describe('flow-trace — ORIGIN_NOT_RESOLVABLE', () => {
  it('returns error response when no node exists at the given coordinates', async () => {
    const { project, repoRoot } = makeProject();

    const response = await flowTrace(
      {
        originFile: '01-assignment-chain.ts',
        originLine: 999,
        originColumn: 1,
      },
      project,
      repoRoot,
    );

    expect(response.results).toHaveLength(0);
    expect(response.error!.kind).toBe('ORIGIN_NOT_RESOLVABLE');
    expect(response.truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 15: Origin not value-producing
// Fixture: 12-type-only.ts — a type alias; no runtime value
// ---------------------------------------------------------------------------
describe('flow-trace — ORIGIN_NOT_VALUE_PRODUCING', () => {
  it('returns error response when origin is a type alias with no value', async () => {
    const { project, repoRoot } = makeProject();

    const response = await flowTrace(
      {
        originFile: '12-type-only.ts',
        originLine: 5,
        originColumn: 13,
      },
      project,
      repoRoot,
    );

    expect(response.results).toHaveLength(0);
    expect(response.error!.kind).toBe('ORIGIN_NOT_VALUE_PRODUCING');
    expect(response.truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 16: Truncation at row cap
// Fixture: 01-assignment-chain.ts with limit: 1
// Expected: 1 row returned, truncated: true, totalEstimated >= 2
// ---------------------------------------------------------------------------
describe('flow-trace — truncation at row cap', () => {
  it('respects limit:1 and sets truncated:true with totalEstimated', async () => {
    const { project, repoRoot } = makeProject();

    const response = await flowTrace(
      {
        originFile: '01-assignment-chain.ts',
        originLine: 8,
        originColumn: 9,
        limit: 1,
      },
      project,
      repoRoot,
    );

    expect(response.query).toBe('flow-trace');
    expect(response.error).toBeUndefined();
    expect(response.results).toHaveLength(1);
    expect(response.truncated).toBe(true);
    expect(response.totalEstimated).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// WP2 Tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Test 4: Spread (wildcard hop)
// Fixture: 03-spread.ts — { ...payload } in an object literal
// Expected: 2 hops (origin payload, spread), confidence wildcard on hop 2,
// no further descent from spread (unresolvable target identity).
// ---------------------------------------------------------------------------
describe('flow-trace — spread hop (wildcard confidence)', () => {
  it('emits origin row + one spread hop with wildcard confidence; no further descent', async () => {
    const { project, repoRoot } = makeProject();

    const response = await flowTrace(
      {
        originFile: '03-spread.ts',
        originLine: 6,
        originColumn: 9,
      },
      project,
      repoRoot,
    );

    expect(response.query).toBe('flow-trace');
    expect(response.error).toBeUndefined();
    // hop 1 = origin (payload), hop 2 = spread into merged — no further descent
    expect(response.results).toHaveLength(2);

    // hop 1: origin (payload)
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hop: 1,
          kind: 'assignment',
          file: '03-spread.ts',
          line: 6,
          confidence: 'exact',
          origin: expect.objectContaining({ symbol: 'payload' }),
        }),
      ]),
    );

    // hop 2: { ...payload } — spread hop with wildcard confidence
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hop: 2,
          kind: 'spread',
          file: '03-spread.ts',
          confidence: 'wildcard',
          parentHop: 1,
        }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Test 7: Mutation sink (.push)
// Fixture: 05-mutation.ts — list.push(4)
// Expected: 2 hops (origin list, mutation), mutation hop is terminal.
// ---------------------------------------------------------------------------
describe('flow-trace — mutation sink (.push)', () => {
  it('emits origin row + one mutation hop; walk terminates at mutation', async () => {
    const { project, repoRoot } = makeProject();

    const response = await flowTrace(
      {
        originFile: '05-mutation.ts',
        originLine: 6,
        originColumn: 9,
      },
      project,
      repoRoot,
    );

    expect(response.query).toBe('flow-trace');
    expect(response.error).toBeUndefined();
    // hop 1 = origin (list), hop 2 = list.push(4) — terminal
    expect(response.results).toHaveLength(2);

    // hop 1: origin (list)
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hop: 1,
          kind: 'assignment',
          file: '05-mutation.ts',
          line: 6,
          confidence: 'exact',
          origin: expect.objectContaining({ symbol: 'list' }),
        }),
      ]),
    );

    // hop 2: list.push(4) — mutation hop (terminal)
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hop: 2,
          kind: 'mutation',
          file: '05-mutation.ts',
          confidence: 'exact',
          parentHop: 1,
        }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Test 8: apiCall sink (Supabase chain terminal method)
// Fixture: 06-api-call.ts — supabase.from('items').insert(payload)
// Expected: 2 hops (origin payload, apiCall at .insert()). OQ-FT2 LOCK:
// apiCall hop emitted at terminal mutating call (.insert), NOT at .from().
// ---------------------------------------------------------------------------
describe('flow-trace — apiCall sink (Supabase .insert)', () => {
  it('emits origin row + one apiCall hop at the terminal mutating method (.insert)', async () => {
    const { project, repoRoot } = makeProject();

    const response = await flowTrace(
      {
        originFile: '06-api-call.ts',
        originLine: 13,
        originColumn: 9,
      },
      project,
      repoRoot,
    );

    expect(response.query).toBe('flow-trace');
    expect(response.error).toBeUndefined();
    // hop 1 = origin (payload), hop 2 = .insert(payload) apiCall — terminal
    expect(response.results).toHaveLength(2);

    // hop 1: origin (payload)
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hop: 1,
          kind: 'assignment',
          file: '06-api-call.ts',
          line: 13,
          confidence: 'exact',
          origin: expect.objectContaining({ symbol: 'payload' }),
        }),
      ]),
    );

    // hop 2: .insert(payload) — apiCall hop at terminal call (OQ-FT2 lock)
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hop: 2,
          kind: 'apiCall',
          file: '06-api-call.ts',
          confidence: 'exact',
          parentHop: 1,
        }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Test 9: Write sink (fs.writeFile)
// Fixture: 07-write.ts — fs.writeFile(path, content)
// Expected: 2 hops (origin content, write), write hop is terminal.
// ---------------------------------------------------------------------------
describe('flow-trace — write sink (fs.writeFile)', () => {
  it('emits origin row + one write hop at fs.writeFile call; walk terminates', async () => {
    const { project, repoRoot } = makeProject();

    const response = await flowTrace(
      {
        originFile: '07-write.ts',
        originLine: 8,
        originColumn: 9,
      },
      project,
      repoRoot,
    );

    expect(response.query).toBe('flow-trace');
    expect(response.error).toBeUndefined();
    // hop 1 = origin (content), hop 2 = fs.writeFile call — terminal
    expect(response.results).toHaveLength(2);

    // hop 1: origin (content)
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hop: 1,
          kind: 'assignment',
          file: '07-write.ts',
          line: 8,
          confidence: 'exact',
          origin: expect.objectContaining({ symbol: 'content' }),
        }),
      ]),
    );

    // hop 2: fs.writeFile(path, content) — write hop (terminal)
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hop: 2,
          kind: 'write',
          file: '07-write.ts',
          confidence: 'exact',
          parentHop: 1,
        }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Test 12: Indirect tier (dynamic property access)
// Fixture: 10-indirect.ts — const val = obj[key]
// Expected: 2 hops (origin obj, indirect-confidence hop). No further descent.
// ---------------------------------------------------------------------------
describe('flow-trace — indirect tier (dynamic property access)', () => {
  it('emits origin row + one hop with indirect confidence for obj[key]; no further descent', async () => {
    const { project, repoRoot } = makeProject();

    const response = await flowTrace(
      {
        originFile: '10-indirect.ts',
        originLine: 6,
        originColumn: 9,
      },
      project,
      repoRoot,
    );

    expect(response.query).toBe('flow-trace');
    expect(response.error).toBeUndefined();
    // hop 1 = origin (obj), hop 2 = val = obj[key] — indirect, terminal
    expect(response.results).toHaveLength(2);

    // hop 1: origin (obj)
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hop: 1,
          kind: 'assignment',
          file: '10-indirect.ts',
          line: 6,
          confidence: 'exact',
          origin: expect.objectContaining({ symbol: 'obj' }),
        }),
      ]),
    );

    // hop 2: val = obj[key] — indirect confidence (dynamic access), terminal
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hop: 2,
          kind: 'assignment',
          confidence: 'indirect',
          file: '10-indirect.ts',
          parentHop: 1,
        }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Wave 5 Tests — bidIds nested-arg fix
// ---------------------------------------------------------------------------

function makeNestedArgProject() {
  return createProject({
    tsConfigFilePath: resolve(NESTED_ARG_FIXTURE_DIR, 'tsconfig.json'),
    repoRoot: NESTED_ARG_FIXTURE_DIR,
  });
}

// ---------------------------------------------------------------------------
// Test 17b-1: Nested object-literal property (PropertyAssignment)
// Fixture: 01-nested-property-arg.ts
// Pattern: rpc('fn', { p_project_ids: bidIds })
// Origin: const bidIds at line 14, col 9
// Expected: 2 hops — origin (assignment) + argument hop at the rpc() call site
// Hop kind: 'argument' (value flows as a call argument via object literal property)
// Confidence: 'exact' (static key, statically-known call)
// ---------------------------------------------------------------------------
describe('flow-trace — nested object-literal property argument (PropertyAssignment)', () => {
  it('emits origin row + argument hop when value flows via { key: value } into a call', async () => {
    const { project, repoRoot } = makeNestedArgProject();

    const response = await flowTrace(
      {
        originFile: '01-nested-property-arg.ts',
        originLine: 14,
        originColumn: 9,
      },
      project,
      repoRoot,
    );

    expect(response.query).toBe('flow-trace');
    expect(response.error).toBeUndefined();
    // Exactly 2 hops: origin + the argument hop at the rpc() call site
    expect(response.results).toHaveLength(2);

    // hop 1: origin (bidIds declaration)
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hop: 1,
          kind: 'assignment',
          file: '01-nested-property-arg.ts',
          line: 14,
          confidence: 'exact',
          origin: expect.objectContaining({ symbol: 'bidIds' }),
        }),
      ]),
    );

    // hop 2: rpc('get_bid_question_stats_batch', { p_project_ids: bidIds }) call
    // The walker must detect the PropertyAssignment → ObjectLiteralExpression →
    // CallExpression chain and classify the hop as 'argument'.
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hop: 2,
          kind: 'argument',
          file: '01-nested-property-arg.ts',
          line: 15,
          confidence: 'exact',
          parentHop: 1,
        }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Test 17b-2: Shorthand property argument (ShorthandPropertyAssignment)
// Fixture: 02-shorthand-property-arg.ts
// Pattern: rpc('fn', { bidIds }) — shorthand for { bidIds: bidIds }
// Origin: const bidIds at line 14, col 9
// Expected: 2 hops — origin (assignment) + argument hop at the rpc() call site
// Hop kind: 'argument', Confidence: 'exact'
// ---------------------------------------------------------------------------
describe('flow-trace — shorthand property argument (ShorthandPropertyAssignment)', () => {
  it('emits origin row + argument hop when value flows via { name } shorthand into a call', async () => {
    const { project, repoRoot } = makeNestedArgProject();

    const response = await flowTrace(
      {
        originFile: '02-shorthand-property-arg.ts',
        originLine: 14,
        originColumn: 9,
      },
      project,
      repoRoot,
    );

    expect(response.query).toBe('flow-trace');
    expect(response.error).toBeUndefined();
    // Exactly 2 hops: origin + the argument hop at the rpc() call site
    expect(response.results).toHaveLength(2);

    // hop 1: origin (bidIds declaration)
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hop: 1,
          kind: 'assignment',
          file: '02-shorthand-property-arg.ts',
          line: 14,
          confidence: 'exact',
          origin: expect.objectContaining({ symbol: 'bidIds' }),
        }),
      ]),
    );

    // hop 2: rpc('get_bid_question_stats_batch', { bidIds }) call
    // The walker must detect the ShorthandPropertyAssignment → ObjectLiteralExpression →
    // CallExpression chain and classify the hop as 'argument'.
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hop: 2,
          kind: 'argument',
          file: '02-shorthand-property-arg.ts',
          line: 15,
          confidence: 'exact',
          parentHop: 1,
        }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// WP3 Tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Test 10: Cycle detection (not maxDepth)
// Fixture: 08-cycle.ts — let a = seed; let b = a; a = b; (re-assignment)
// Walker detects cycle at step 3 because `a` position was already visited
// (as origin). Emits cycleCutoff synthetic row.
// Expected: 3 hops — origin (a), assignment (b=a), cycleCutoff.
// ---------------------------------------------------------------------------
describe('flow-trace — cycle detection', () => {
  it('emits cycleCutoff synthetic row when a visited position would be re-traced', async () => {
    const { project, repoRoot } = makeProject();

    const response = await flowTrace(
      {
        originFile: '08-cycle.ts',
        originLine: 17,
        originColumn: 7,  // 'a' in `let a = seed`
      },
      project,
      repoRoot,
    );

    expect(response.query).toBe('flow-trace');
    expect(response.error).toBeUndefined();
    // hop 1 = origin (a), hop 2 = assignment (b=a), hop 3 = cycleCutoff
    expect(response.results).toHaveLength(3);

    // hop 1: origin (a)
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hop: 1,
          kind: 'assignment',
          file: '08-cycle.ts',
          line: 17,
          confidence: 'exact',
          origin: expect.objectContaining({ symbol: 'a' }),
        }),
      ]),
    );

    // hop 2: b = a — assignment hop
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hop: 2,
          kind: 'assignment',
          file: '08-cycle.ts',
          confidence: 'exact',
          parentHop: 1,
        }),
      ]),
    );

    // hop 3: cycleCutoff — detected when b's walk would re-visit position of a
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hop: 3,
          kind: 'cycleCutoff',
          confidence: 'exact',
          parentHop: 2,
        }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Test 11: Max-depth cutoff (maxDepth=2, real chain=4)
// Fixture: 09-depth-cutoff.ts — linear chain a → b → c → d
// Invoked with maxDepth: 2; expects depthCutoff at hop 3.
// Expected: 3 hops — origin (a), assignment (b=a), depthCutoff.
// ---------------------------------------------------------------------------
describe('flow-trace — depth cutoff', () => {
  it('emits depthCutoff synthetic row when maxDepth is reached before the chain ends', async () => {
    const { project, repoRoot } = makeProject();

    const response = await flowTrace(
      {
        originFile: '09-depth-cutoff.ts',
        originLine: 14,
        originColumn: 9,
        maxDepth: 2,
      },
      project,
      repoRoot,
    );

    expect(response.query).toBe('flow-trace');
    expect(response.error).toBeUndefined();
    // hop 1 = origin (a), hop 2 = b=a (depth 1), hop 3 = depthCutoff (depth 2)
    expect(response.results).toHaveLength(3);

    // hop 1: origin (a)
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hop: 1,
          kind: 'assignment',
          file: '09-depth-cutoff.ts',
          line: 14,
          confidence: 'exact',
          origin: expect.objectContaining({ symbol: 'a' }),
        }),
      ]),
    );

    // hop 2: b = a — first real assignment at depth 1
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hop: 2,
          kind: 'assignment',
          file: '09-depth-cutoff.ts',
          confidence: 'exact',
          parentHop: 1,
        }),
      ]),
    );

    // hop 3: depthCutoff — fires at depth 2 (>= maxDepth 2) before emitting c=b
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hop: 3,
          kind: 'depthCutoff',
          confidence: 'exact',
          parentHop: 2,
        }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Test 13: Inter-function descent (interFunction: true)
// Fixture: 11-inter-function.ts — origin payload → argument at saveToDb(payload)
//   → descent into saveToDb's parameter (data) → apiCall at .insert(data)
// Expected: 4 hops — origin, argument (call site), argument (callee param), apiCall.
// OQ-FT3 LOCK: enclosing on callee hops is saveToDb (callee), not processData (caller).
// ---------------------------------------------------------------------------
describe('flow-trace — inter-function descent', () => {
  it('descends into callee on argument hop when interFunction:true; correct enclosing on child hops', async () => {
    const { project, repoRoot } = makeProject();

    const response = await flowTrace(
      {
        originFile: '11-inter-function.ts',
        originLine: 30,
        originColumn: 9,
        interFunction: true,
      },
      project,
      repoRoot,
    );

    expect(response.query).toBe('flow-trace');
    expect(response.error).toBeUndefined();
    // hop 1 = origin (payload), hop 2 = argument at saveToDb(payload),
    // hop 3 = argument (data param in saveToDb), hop 4 = apiCall at .insert(data)
    expect(response.results).toHaveLength(4);

    // hop 1: origin (payload) in processData
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hop: 1,
          kind: 'assignment',
          file: '11-inter-function.ts',
          confidence: 'exact',
          origin: expect.objectContaining({ symbol: 'payload' }),
        }),
      ]),
    );

    // hop 2: argument hop at saveToDb(payload) call site
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hop: 2,
          kind: 'argument',
          file: '11-inter-function.ts',
          confidence: 'exact',
          parentHop: 1,
        }),
      ]),
    );

    // hop 3: descent into saveToDb's parameter (data)
    // OQ-FT3: enclosing is 'fn:saveToDb' (callee), not 'fn:processData' (caller)
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hop: 3,
          kind: 'argument',
          file: '11-inter-function.ts',
          enclosing: 'fn:saveToDb',
          parentHop: 2,
        }),
      ]),
    );

    // hop 4: apiCall sink at .insert(data) inside saveToDb
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hop: 4,
          kind: 'apiCall',
          file: '11-inter-function.ts',
          enclosing: 'fn:saveToDb',
          parentHop: 3,
        }),
      ]),
    );
  });
});

import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProject } from '@/lib/ast-dataflow';
import { flowTrace } from '@/lib/ast-dataflow/queries/flow-trace';

const FIXTURE_DIR = resolve(__dirname, 'fixtures', '14-flow-trace');

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

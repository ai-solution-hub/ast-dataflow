/**
 * Performance smoke tests for the flow-trace query (PRODUCT.md P-19).
 *
 * OQ-FT5 resolution gate: both assertions must pass within 10 s (warm P95)
 * before WP3 is considered complete. If either fails, the default maxDepth
 * should be reduced to 6 and a backlog item opened.
 *
 * These tests use small synthetic fixtures from the 14-flow-trace fixture
 * directory, NOT the full KH corpus, to keep test time predictable on CI.
 * A one warm-up run is executed first; the measured time is the second run.
 */

import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProject } from '@/lib/ast-dataflow';
import { flowTrace } from '@/lib/ast-dataflow/queries/flow-trace';

const FIXTURE_DIR = resolve(__dirname, 'fixtures', '14-flow-trace');
const PERF_BUDGET_MS = 10_000; // 10 s per PRODUCT.md P-19 heuristic budget

function makeProject() {
  return createProject({
    tsConfigFilePath: resolve(FIXTURE_DIR, 'tsconfig.json'),
    repoRoot: FIXTURE_DIR,
  });
}

// ---------------------------------------------------------------------------
// 5-hop warm time assertion
// Fixture: perf-5hop.ts — raw → validated → enriched → formatted → final → .insert()
// Trace origin: `validated` (the first assignment from the parameter).
// ---------------------------------------------------------------------------
describe('flow-trace performance — 5-hop warm time', () => {
  it(`completes a 5-hop trace within ${PERF_BUDGET_MS / 1000} s on warm project`, async () => {
    const { project, repoRoot } = makeProject();

    // Warm-up run: load ts-morph project + caches
    await flowTrace(
      { originFile: 'perf-5hop.ts', originLine: 15, originColumn: 9 },
      project,
      repoRoot,
    );

    // Measured run
    const t0 = performance.now();
    const response = await flowTrace(
      { originFile: 'perf-5hop.ts', originLine: 15, originColumn: 9 },
      project,
      repoRoot,
    );
    const wallMs = performance.now() - t0;

    expect(response.error).toBeUndefined();
    // Trace: origin(validated) → enriched → formatted → final → .insert(final)
    // = 5 hops total
    expect(response.results).toHaveLength(5);
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'assignment', hop: 1 }),
        expect.objectContaining({ kind: 'assignment', hop: 2 }),
        expect.objectContaining({ kind: 'assignment', hop: 3 }),
        expect.objectContaining({ kind: 'assignment', hop: 4 }),
        expect.objectContaining({ kind: 'apiCall', hop: 5 }),
      ]),
    );

    // OQ-FT5: warm time must be within budget.
    expect(wallMs).toBeLessThan(PERF_BUDGET_MS);
  });
});

// ---------------------------------------------------------------------------
// 8-hop warm time assertion
// Fixture: perf-8hop.ts — a linear chain of 8 assignments.
// Trace origin: `a` (first assignment from the parameter).
// ---------------------------------------------------------------------------
describe('flow-trace performance — 8-hop warm time', () => {
  it(`completes an 8-hop trace within ${PERF_BUDGET_MS / 1000} s on warm project`, async () => {
    const { project, repoRoot } = makeProject();

    // Warm-up run
    await flowTrace(
      { originFile: 'perf-8hop.ts', originLine: 9, originColumn: 9 },
      project,
      repoRoot,
    );

    // Measured run
    const t0 = performance.now();
    const response = await flowTrace(
      { originFile: 'perf-8hop.ts', originLine: 9, originColumn: 9 },
      project,
      repoRoot,
    );
    const wallMs = performance.now() - t0;

    expect(response.error).toBeUndefined();
    // Trace: a(origin) + b,c,d,e,f,g,h (7 assignments) + depthCutoff = 9 hops.
    // The `return h` would be hop 10 but maxDepth:8 fires depthCutoff at depth 8.
    expect(response.results).toHaveLength(9);
    expect(response.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'assignment', hop: 1 }),
        expect.objectContaining({ kind: 'depthCutoff', hop: 9 }),
      ]),
    );

    // OQ-FT5: warm time must be within budget.
    expect(wallMs).toBeLessThan(PERF_BUDGET_MS);
  });
});

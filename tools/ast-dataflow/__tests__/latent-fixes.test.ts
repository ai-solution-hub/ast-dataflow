/**
 * latent-fixes.test.ts
 *
 * Regression coverage for the latent-bug sweep:
 *  1. findEnclosing — constructor / accessor / static-block scopes previously
 *     fell through to 'moduleTopLevel'; non-function object-property values
 *     were mislabelled method:<container>.<prop>.
 *  2. column-writes — spread-carried payloads (`.update({ ...p })`) and
 *     identifier array elements (`.insert([row])`) were silently skipped;
 *     provably-absent literals must stay excluded.
 *  3. column-reads — `.order()` / `.in()` column references were invisible.
 *  4. flow-trace — shadowed same-name bindings in nested scopes produced
 *     false hops; re-assignment into an existing binding (`out = data`)
 *     dropped the flow entirely.
 *  5. resolveSymbol — the zod value+type name-merge idiom errored
 *     ambiguous_symbol with no possible disambiguation.
 *  6. type-evolution — the documented excludeTests flag was ignored.
 */

import { resolve } from 'node:path';
import { SyntaxKind } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import {
  callers,
  columnReads,
  columnWrites,
  flowTrace,
  references,
  typeEvolution,
  createProject,
} from '@/tools/ast-dataflow';

const FIXTURE_DIR = resolve(__dirname, 'fixtures', '18-latent-fixes');

function makeProject() {
  return createProject({
    tsConfigFilePath: resolve(FIXTURE_DIR, 'tsconfig.json'),
    repoRoot: FIXTURE_DIR,
  });
}

/** Locate the 1-based position of the first `const <name>` declaration in a fixture file. */
function declPosition(
  project: ReturnType<typeof makeProject>['project'],
  file: string,
  name: string,
): { line: number; column: number } {
  const sf = project.getSourceFile(resolve(FIXTURE_DIR, file));
  if (!sf) throw new Error(`fixture file missing: ${file}`);
  const decl = sf
    .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
    .find((d) => d.getName() === name);
  if (!decl) throw new Error(`declaration ${name} missing in ${file}`);
  return sf.getLineAndColumnAtPos(decl.getStart());
}

// ── 1. findEnclosing class-member scopes ────────────────────────────────────

describe('findEnclosing — class members and property values', () => {
  it('labels calls inside constructor, accessor, and static block', async () => {
    const { project, repoRoot } = makeProject();
    const response = await callers(
      { symbol: 'enclosings.ts:target' },
      project,
      repoRoot,
    );
    expect(response.error).toBeUndefined();

    const enclosings = response.results.map((r) => r.enclosing);
    expect(enclosings).toContain('method:Widget.constructor');
    expect(enclosings).toContain('method:Widget.area');
    expect(enclosings).toContain('method:Widget.<static>');
    // Pre-fix these three reported 'moduleTopLevel'.
    const widgetRows = response.results.filter((r) =>
      r.enclosing.startsWith('method:Widget.'),
    );
    expect(widgetRows).toHaveLength(3);
  });

  it('reports the host function for non-function property values', async () => {
    const { project, repoRoot } = makeProject();
    const response = await callers(
      { symbol: 'enclosings.ts:target' },
      project,
      repoRoot,
    );

    // `const cfg = { handler: target() }` inside hostFunction —
    // pre-fix this row claimed method:cfg.handler.
    expect(
      response.results.some((r) => r.enclosing === 'fn:hostFunction'),
    ).toBe(true);
    expect(
      response.results.some((r) => r.enclosing === 'method:cfg.handler'),
    ).toBe(false);
  });

  it('labels arrow-function property values, resolving through `as const`', async () => {
    const { project, repoRoot } = makeProject();
    const response = await callers(
      { symbol: 'enclosings.ts:target' },
      project,
      repoRoot,
    );

    const enclosings = response.results.map((r) => r.enclosing);
    expect(enclosings).toContain('method:handlers.onPing');
    // `{ compute: () => target() } as const` — container name previously '<Object>'.
    expect(enclosings).toContain('method:frozen.compute');
  });
});

// ── 2 + 3. column-writes spread handling / column-reads filter methods ──────

describe('column-writes — spread and identifier payloads', () => {
  it('reports .update({ ...payload }) as an indirect write', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnWrites(
      { table: 'bid_questions', column: 'project_id' },
      project,
      repoRoot,
    );

    const spreadHits = response.results.filter(
      (r) => r.file === 'writes-spread.ts' && r.method === 'update',
    );
    // updateViaSpread must be present (indirect); the two provably-absent
    // updates (updateOtherColumnOnly, updateViaLocalWithoutKey) must not be.
    expect(spreadHits).toHaveLength(1);
    expect(spreadHits[0].confidence).toBe('indirect');
  });

  it('reports .insert([row]) with an identifier element as indirect', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnWrites(
      { table: 'bid_questions', column: 'project_id' },
      project,
      repoRoot,
    );

    const insertHits = response.results.filter(
      (r) => r.file === 'writes-spread.ts' && r.method === 'insert',
    );
    expect(insertHits).toHaveLength(1);
    expect(insertHits[0].confidence).toBe('indirect');
  });
});

describe('column-reads — filter/order chain methods', () => {
  it('reports .in() as a filter read with the concrete chainMethod', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnReads(
      { table: 'bid_questions', column: 'project_id' },
      project,
      repoRoot,
    );

    const inHits = response.results.filter(
      (r) => r.method === 'filter' && r.chainMethod === 'in',
    );
    expect(inHits).toHaveLength(1);
    expect(inHits[0].file).toBe('writes-spread.ts');
  });

  it('reports .order() as an order read', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnReads(
      { table: 'bid_questions', column: 'project_id' },
      project,
      repoRoot,
    );

    expect(response.results.some((r) => r.method === 'order')).toBe(true);
  });
});

// ── 4. flow-trace shadowing + re-assignment ─────────────────────────────────

describe('flow-trace — shadowed bindings and re-assignment', () => {
  it('does not hop into a shadowing binding in a nested scope', async () => {
    const { project, repoRoot } = makeProject();
    const origin = declPosition(project, 'flow-shadow.ts', 'data');

    const response = await flowTrace(
      {
        originFile: 'flow-shadow.ts',
        originLine: origin.line,
        originColumn: origin.column,
      },
      project,
      repoRoot,
    );
    expect(response.error).toBeUndefined();

    // The inner consume(data) call is on line 8 of the fixture (the shadow).
    // Only the outer flow may appear: origin + `const copy = data` assignment
    // + consume(copy) argument.
    const shadowCallRows = response.results.filter(
      (r) => r.kind === 'argument' && r.line <= 9,
    );
    expect(shadowCallRows).toEqual([]);

    expect(
      response.results.some((r) => r.kind === 'assignment' && r.hop > 1),
    ).toBe(true);
  });

  it('emits an assignment hop for `out = data` and continues the walk', async () => {
    const { project, repoRoot } = makeProject();
    const origin = declPosition(project, 'flow-reassign.ts', 'data');

    const response = await flowTrace(
      {
        originFile: 'flow-reassign.ts',
        originLine: origin.line,
        originColumn: origin.column,
      },
      project,
      repoRoot,
    );
    expect(response.error).toBeUndefined();

    // Pre-fix: only the origin row existed. Now: origin + assignment at
    // `out = data` + argument hop at sink(out).
    const kinds = response.results.map((r) => r.kind);
    expect(
      kinds.filter((k) => k === 'assignment').length,
    ).toBeGreaterThanOrEqual(
      2, // origin row (kind 'assignment' per spec) + the re-assignment hop
    );
    expect(kinds).toContain('argument');
  });
});

// ── 5. resolveSymbol zod value+type merge ───────────────────────────────────

describe('resolveSymbol — value + type declaration merge (zod idiom)', () => {
  it('resolves to the value declaration instead of erroring ambiguous_symbol', async () => {
    const { project, repoRoot } = makeProject();
    const response = await references(
      { symbol: 'zod-pair.ts:OrderSchema' },
      project,
      repoRoot,
    );

    expect(response.error).toBeUndefined();
    // The consumer's OrderSchema.parse call site must be found.
    expect(response.results.some((r) => r.file === 'zod-consumer.ts')).toBe(
      true,
    );
  });
});

// ── 6. type-evolution excludeTests ──────────────────────────────────────────

describe('type-evolution — excludeTests honoured', () => {
  it('drops __tests__/ rows when excludeTests is set', async () => {
    const { project, repoRoot } = makeProject();

    const withTests = await typeEvolution(
      { type: 'TargetShape', property: 'project_id', file: 'types-shape.ts' },
      project,
      repoRoot,
    );
    const withoutTests = await typeEvolution(
      {
        type: 'TargetShape',
        property: 'project_id',
        file: 'types-shape.ts',
        excludeTests: true,
      },
      project,
      repoRoot,
    );

    expect(withTests.error).toBeUndefined();
    expect(withoutTests.error).toBeUndefined();

    const testRowsBefore = withTests.results.filter((r) =>
      r.file.includes('__tests__/'),
    );
    const testRowsAfter = withoutTests.results.filter((r) =>
      r.file.includes('__tests__/'),
    );

    // Pre-fix the flag was ignored, so both sets contained test rows.
    expect(testRowsBefore.length).toBeGreaterThanOrEqual(1);
    expect(testRowsAfter).toEqual([]);
    // Production rows survive.
    expect(withoutTests.results.some((r) => r.file === 'types-shape.ts')).toBe(
      true,
    );
  });
});

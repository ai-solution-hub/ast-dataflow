/**
 * The uniform response envelope (caveats + summary + truncation narrowing).
 *
 * These tests drive `dispatch`, not the query functions, because dispatch is
 * what the CLI and the MCP server both call — testing the query function
 * directly would pass while the shipped surface stayed silent.
 */
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProject } from '@/tools/ast-dataflow';
import { QUERY_CAVEATS } from '@/tools/ast-dataflow/caveats';
import { QUERY_NAMES, dispatch } from '@/tools/ast-dataflow/dispatch';
import { createWarmState, warmDispatch } from '@/tools/ast-dataflow/staleness';

const REFERENCES_FIXTURE = resolve(__dirname, 'fixtures', '06-references');
const COLUMN_WRITES_FIXTURE = resolve(
  __dirname,
  'fixtures',
  '08-column-writes',
);

function projectAt(fixtureDir: string) {
  return createProject({
    tsConfigFilePath: resolve(fixtureDir, 'tsconfig.json'),
    repoRoot: fixtureDir,
  });
}

describe('envelope — catalogue coverage', () => {
  it('describes every query in the catalogue', () => {
    // Exhaustiveness is enforced by the type system too; this measures it, so
    // a future query cannot ship with an empty envelope.
    expect(Object.keys(QUERY_CAVEATS).sort()).toEqual([...QUERY_NAMES].sort());
  });

  it('gives every query a non-empty scan statement and searched-shape list', () => {
    for (const query of QUERY_NAMES) {
      const spec = QUERY_CAVEATS[query];
      expect(spec.scan.length, `${query} scan`).toBeGreaterThan(0);
      expect(spec.searched.length, `${query} searched`).toBeGreaterThan(0);
      expect(
        spec.invisibleSurfaces.length,
        `${query} invisibleSurfaces`,
      ).toBeGreaterThan(0);
    }
  });
});

describe('envelope — a zero-row answer says why it might be zero (G2)', () => {
  it('references: zero rows still report the corpus, the shapes searched, and the blind spots', async () => {
    const { project, repoRoot } = projectAt(REFERENCES_FIXTURE);
    // MY_CONSTANT is real and referenced — but never as a JSX component, so
    // this is the "no sites in the shapes I filtered to" zero.
    const response = await dispatch(
      'references',
      { symbol: 'target.ts:MY_CONSTANT', kind: 'jsxComponent' },
      project,
      repoRoot,
    );

    expect(response.results).toEqual([]);
    expect(response.error).toBeUndefined();

    const caveats = response.caveats;
    expect(caveats).toBeDefined();
    expect(caveats?.corpus.fileCount).toBeGreaterThan(0);
    expect(caveats?.corpus.tsconfigPath).toBe('tsconfig.json');
    expect(caveats?.corpus.testFilesExcluded).toBe(false);
    expect(caveats?.searched).toContain('JSX component tags');
    expect(caveats?.invisibleSurfaces.join(' ')).toContain(
      'string literals that merely spell the name',
    );
    // Nothing was dropped, so the histogram covers everything it found.
    expect(caveats?.summaryBasis).toBe('all-rows');
    expect(caveats?.narrowing).toBeUndefined();
  });

  it('column-reads: zero rows disclose whether the table and column were validated at all', async () => {
    // A repo with no generated Postgres types: the table and column cannot be
    // checked to exist, so this zero could equally be a typo. The response
    // must SAY the arguments went unvalidated rather than let the zero read
    // as "no sites exist".
    const { project, repoRoot } = projectAt(REFERENCES_FIXTURE);
    const response = await dispatch(
      'column-reads',
      { table: 'survey_questions', column: 'project_id' },
      project,
      repoRoot,
    );

    expect(response.results).toEqual([]);
    const caveats = response.caveats;
    expect(caveats?.schemaValidation?.validated).toBe(false);
    expect(caveats?.schemaValidation?.reason).toContain(
      'supabase/types/database.types.ts',
    );
    expect(caveats?.corpus.fileCount).toBeGreaterThan(0);
    expect(caveats?.searched.join(' ')).toContain('.eq()');
    expect(caveats?.invisibleSurfaces.join(' ')).toContain('raw SQL');
  });

  it('column-writes: a validated zero is marked as trustworthy, not merely empty', async () => {
    // The other half of the pair: this fixture DOES ship generated types, the
    // column really exists, and nothing writes it. That zero means something,
    // and the caveats are what let a caller tell it apart from the one above.
    const { project, repoRoot } = projectAt(COLUMN_WRITES_FIXTURE);
    const response = await dispatch(
      'column-writes',
      { table: 'bid_projects', column: 'title' },
      project,
      repoRoot,
    );

    expect(response.results).toEqual([]);
    expect(response.error).toBeUndefined();
    expect(response.caveats?.schemaValidation).toMatchObject({
      validated: true,
      source: 'supabase/types/database.types.ts',
      tableCount: 2,
    });
    expect(response.caveats?.schemaValidation?.reason).toBeUndefined();
  });
});

describe('envelope — bucket histogram', () => {
  it('counts references by kind over all rows when nothing was dropped', async () => {
    const { project, repoRoot } = projectAt(REFERENCES_FIXTURE);
    const response = await dispatch(
      'references',
      { symbol: 'target.ts:MY_CONSTANT' },
      project,
      repoRoot,
    );

    expect(response.summary).toBeDefined();
    const summary = response.summary ?? {};
    const totalCounted = Object.values(summary).reduce((a, b) => a + b, 0);
    expect(totalCounted).toBe(response.results.length);
    expect(response.caveats?.summaryBasis).toBe('all-rows');
  });
});

describe('envelope — truncation offers a narrowing path (G10)', () => {
  it('names the shown/total split, the real filters, and a concrete limit to re-run with', async () => {
    const { project, repoRoot } = projectAt(REFERENCES_FIXTURE);
    const response = await dispatch(
      'references',
      { symbol: 'target.ts:MY_CONSTANT', limit: 1 },
      project,
      repoRoot,
    );

    expect(response.truncated).toBe(true);
    expect(response.results).toHaveLength(1);
    const total = response.totalEstimated ?? 0;
    expect(total).toBeGreaterThan(1);

    const narrowing = response.caveats?.narrowing;
    expect(
      narrowing,
      'truncated responses must carry a narrowing block',
    ).toBeDefined();
    const text = (narrowing ?? []).join('\n');
    expect(text).toContain(`Showing 1 of ${total} rows`);
    // The kind filter is real for references, so it is safe to advertise.
    expect(text).toContain('--kind');
    expect(text).toContain('(arg: kind)');
    // The limit line must name a cap that would actually show more.
    expect(text).toContain(`--limit ${total}`);
    expect(text).toContain('it is currently 1');
  });

  it('marks the histogram as shown-rows only when rows were dropped', async () => {
    const { project, repoRoot } = projectAt(REFERENCES_FIXTURE);
    const response = await dispatch(
      'references',
      { symbol: 'target.ts:MY_CONSTANT', limit: 1 },
      project,
      repoRoot,
    );
    expect(response.caveats?.summaryBasis).toBe('shown-rows');
  });

  it('describes the truncation mechanism each query really uses', async () => {
    // Not pedantry: under spatial truncation the file list is near-complete
    // and the total is exact, while reexport-chain STOPS the walk at the cap,
    // so its total is a floor and whole branches went unvisited. Calling the
    // second one spatial would overstate how complete the answer is.
    const fixture = resolve(__dirname, 'fixtures', '10-reexport-chain');
    const { project, repoRoot } = projectAt(fixture);
    const response = await dispatch(
      'reexport-chain',
      { symbol: 'twoHopSymbol', from: 'two-hop-source.ts', limit: 3 },
      project,
      repoRoot,
    );

    expect(response.truncated).toBe(true);
    const text = (response.caveats?.narrowing ?? []).join('\n');
    expect(text).toContain('the walk STOPPED at the cap');
    expect(text).toContain('is a lower bound, not a total');
    expect(text).toContain('at least');
    expect(text).not.toContain('spatial-coverage truncation');
  });

  it('only advertises filters the query actually honours', () => {
    // A narrowing hint for an inert flag is worse than no hint: it sends the
    // caller to re-run a query that returns exactly the same rows.
    // `dead-exports` `scope` was exactly that — declared, read by no code —
    // until issue #2 implemented it; now that the query reads it (proven in
    // dead-exports.test.ts: scope really narrows the rows), the lever
    // belongs in the narrowing block.
    const args = QUERY_CAVEATS['dead-exports'].filters.map((f) => f.arg);
    expect(args, 'dead-exports must advertise scope now it is real').toContain(
      'scope',
    );
  });

  it('the scope lever it advertises for references really narrows the rows', async () => {
    const { project, repoRoot } = projectAt(REFERENCES_FIXTURE);
    const unscoped = await dispatch(
      'references',
      { symbol: 'target.ts:MY_CONSTANT' },
      project,
      repoRoot,
    );
    const scoped = await dispatch(
      'references',
      { symbol: 'target.ts:MY_CONSTANT', scope: 'case-read.ts' },
      project,
      repoRoot,
    );

    expect(unscoped.results.length).toBeGreaterThan(scoped.results.length);
    expect(scoped.results.length).toBeGreaterThan(0);
    expect(new Set(scoped.results.map((r) => r.file))).toEqual(
      new Set(['case-read.ts']),
    );
    // The applied filter is echoed in the corpus block, so a later reader can
    // see the answer was scoped rather than complete.
    expect(scoped.caveats?.corpus.scope).toBe('case-read.ts');
  });

  it('the scope lever it advertises for callers really narrows the rows', async () => {
    const fixture = resolve(__dirname, 'fixtures', '01-callers');
    const { project, repoRoot } = projectAt(fixture);
    const unscoped = await dispatch(
      'callers',
      { symbol: 'target.ts:target' },
      project,
      repoRoot,
    );
    const scoped = await dispatch(
      'callers',
      { symbol: 'target.ts:target', scope: 'no-such-dir/**' },
      project,
      repoRoot,
    );

    expect(unscoped.results.length).toBeGreaterThan(0);
    expect(scoped.results).toEqual([]);
  });
});

describe('envelope — the warm MCP path carries it too', () => {
  it('warmDispatch responses carry the same caveats as the CLI path', async () => {
    // CLI/MCP parity is the reason the envelope is attached in dispatch; this
    // measures it on the warm path rather than trusting the call graph.
    const state = createWarmState({ repoRoot: REFERENCES_FIXTURE });
    const response = await warmDispatch(state, 'references', {
      symbol: 'target.ts:MY_CONSTANT',
    });

    expect(response.caveats?.scan.length).toBeGreaterThan(0);
    expect(response.caveats?.corpus.fileCount).toBeGreaterThan(0);
    expect(response.summary).toBeDefined();
    // The staleness meta the warm path adds is still there.
    expect(response.meta.staleFiles).toEqual([]);
  });
});

describe('envelope — a query with richer caveats of its own keeps them', () => {
  it('schema-coverage keeps its scan text, invisible surfaces and all-rows basis', async () => {
    const fixture = resolve(__dirname, 'fixtures', '21-schema-coverage');
    const { project, repoRoot } = projectAt(fixture);
    const response = await dispatch('schema-coverage', {}, project, repoRoot);

    const caveats = response.caveats;
    expect(caveats?.scan).toContain('TypeScript query-chain evidence');
    expect(caveats?.invisibleSurfaces).toContain('RPC function bodies (SQL)');
    // Its own per-column histogram is computed pre-truncation.
    expect(caveats?.summaryBasis).toBe('all-rows');
    expect(response.summary?.unwired).toBeGreaterThanOrEqual(0);
    // The shared block still filled in what the query did not set.
    expect(caveats?.corpus.fileCount).toBeGreaterThan(0);
    expect(caveats?.schemaValidation?.validated).toBe(true);
  });
});

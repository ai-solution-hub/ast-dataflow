import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reexportChain, createProject } from '@/lib/ast-dataflow';

/**
 * reexport-chain query — Vitest suite
 *
 * Ground-truth fixture set under fixtures/10-reexport-chain/.
 * Tests verify real behaviour per docs/reference/test-philosophy.md:
 *   - Assertions are on the result shape and counts (not on call-chain internals).
 *   - toHaveLength pins exact counts; no toBeGreaterThanOrEqual(1) + find() antipattern.
 *   - Test titles read like product specs (what the user observes), not implementation.
 *
 * Row shape:
 *   { file, line, column, kind, symbolName, throughBarrel, distance, confidence }
 *   kind: 'declaration' | 'reexport' | 'importer'
 *   throughBarrel: string | null  (null for declaration + importer rows)
 *   distance: 0 at declaration, +1 per barrel hop
 */

const FIXTURE_DIR = resolve(__dirname, 'fixtures', '10-reexport-chain');

function makeProject() {
  return createProject({
    tsConfigFilePath: resolve(FIXTURE_DIR, 'tsconfig.json'),
    repoRoot: FIXTURE_DIR,
  });
}

// ---------------------------------------------------------------------------
// Scenario 1: direct import — no barrel (distance always 0)
// ---------------------------------------------------------------------------
describe('reexport-chain — scenario 1: symbol imported directly, no barrel hop', () => {
  it('returns a declaration row at distance 0 for directSymbol', async () => {
    const { project, repoRoot } = makeProject();
    const response = await reexportChain(
      { symbol: 'directSymbol', from: 'direct-declaration.ts' },
      project,
      repoRoot,
    );

    expect(response.query).toBe('reexport-chain');
    expect(response.error).toBeUndefined();

    const declarationRows = response.results.filter((r) => r.kind === 'declaration');
    expect(declarationRows).toHaveLength(1);
    expect(declarationRows[0]).toMatchObject({
      file: 'direct-declaration.ts',
      kind: 'declaration',
      symbolName: 'directSymbol',
      throughBarrel: null,
      distance: 0,
      confidence: 'exact',
    });
  });

  it('returns an importer row at distance 0 for the direct consumer', async () => {
    const { project, repoRoot } = makeProject();
    const response = await reexportChain(
      { symbol: 'directSymbol', from: 'direct-declaration.ts' },
      project,
      repoRoot,
    );

    expect(response.error).toBeUndefined();

    const importerRows = response.results.filter((r) => r.kind === 'importer');
    expect(importerRows).toHaveLength(1);
    expect(importerRows[0]).toMatchObject({
      file: 'direct-consumer.ts',
      kind: 'importer',
      symbolName: 'directSymbol',
      throughBarrel: null,
      distance: 0,
      confidence: 'exact',
    });
  });

  it('returns no reexport rows when there are no barrels in the chain', async () => {
    const { project, repoRoot } = makeProject();
    const response = await reexportChain(
      { symbol: 'directSymbol', from: 'direct-declaration.ts' },
      project,
      repoRoot,
    );

    expect(response.error).toBeUndefined();
    const reexportRows = response.results.filter((r) => r.kind === 'reexport');
    expect(reexportRows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: one barrel hop — declaration → barrel → importer
// ---------------------------------------------------------------------------
describe('reexport-chain — scenario 2: one barrel hop produces distance=1 at importer', () => {
  it('returns declaration row at distance 0, reexport row at distance 1, importer row at distance 1', async () => {
    const { project, repoRoot } = makeProject();
    const response = await reexportChain(
      { symbol: 'oneHopSymbol', from: 'one-hop-source.ts' },
      project,
      repoRoot,
    );

    expect(response.query).toBe('reexport-chain');
    expect(response.error).toBeUndefined();

    // Exact count: 1 declaration + 1 reexport + 1 importer = 3 rows
    expect(response.results).toHaveLength(3);

    const declarationRows = response.results.filter((r) => r.kind === 'declaration');
    expect(declarationRows).toHaveLength(1);
    expect(declarationRows[0]).toMatchObject({
      file: 'one-hop-source.ts',
      kind: 'declaration',
      symbolName: 'oneHopSymbol',
      throughBarrel: null,
      distance: 0,
      confidence: 'exact',
    });

    const reexportRows = response.results.filter((r) => r.kind === 'reexport');
    expect(reexportRows).toHaveLength(1);
    expect(reexportRows[0]).toMatchObject({
      file: 'one-hop-barrel.ts',
      kind: 'reexport',
      symbolName: 'oneHopSymbol',
      throughBarrel: 'one-hop-barrel.ts',
      distance: 1,
      confidence: 'exact',
    });

    const importerRows = response.results.filter((r) => r.kind === 'importer');
    expect(importerRows).toHaveLength(1);
    expect(importerRows[0]).toMatchObject({
      file: 'one-hop-consumer.ts',
      kind: 'importer',
      symbolName: 'oneHopSymbol',
      throughBarrel: null,
      distance: 1,
      confidence: 'exact',
    });
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: two barrel hops — distance=2 at importer, intermediate hops at 1 and 2
// ---------------------------------------------------------------------------
describe('reexport-chain — scenario 3: two barrel hops yield distance=2 at importer', () => {
  it('produces 4 rows: declaration(0) + reexport barrel-a(1) + reexport barrel-b(2) + importer(2)', async () => {
    const { project, repoRoot } = makeProject();
    const response = await reexportChain(
      { symbol: 'twoHopSymbol', from: 'two-hop-source.ts' },
      project,
      repoRoot,
    );

    expect(response.query).toBe('reexport-chain');
    expect(response.error).toBeUndefined();

    // Exact count: 1 declaration + 2 reexports + 1 importer = 4 rows
    expect(response.results).toHaveLength(4);

    const declarationRows = response.results.filter((r) => r.kind === 'declaration');
    expect(declarationRows).toHaveLength(1);
    expect(declarationRows[0]).toMatchObject({
      file: 'two-hop-source.ts',
      kind: 'declaration',
      distance: 0,
      throughBarrel: null,
    });

    const reexportRows = response.results.filter((r) => r.kind === 'reexport');
    // Pin both hops without find()/toBeDefined() — arrayContaining proves the
    // exact rows exist regardless of result order. toHaveLength(2) above bounds
    // the array, so this assertion fully constrains both hops.
    expect(reexportRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: 'two-hop-barrel-a.ts',
          kind: 'reexport',
          symbolName: 'twoHopSymbol',
          throughBarrel: 'two-hop-barrel-a.ts',
          distance: 1,
          confidence: 'exact',
        }),
        expect.objectContaining({
          file: 'two-hop-barrel-b.ts',
          kind: 'reexport',
          symbolName: 'twoHopSymbol',
          throughBarrel: 'two-hop-barrel-b.ts',
          distance: 2,
          confidence: 'exact',
        }),
      ]),
    );

    // Terminal importer gets cumulative distance 2 (two barrel hops)
    const importerRows = response.results.filter((r) => r.kind === 'importer');
    expect(importerRows).toHaveLength(1);
    expect(importerRows[0]).toMatchObject({
      file: 'two-hop-consumer.ts',
      kind: 'importer',
      symbolName: 'twoHopSymbol',
      distance: 2,
      throughBarrel: null,
      confidence: 'exact',
    });
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: named rename re-export — export { foo as bar }
// ---------------------------------------------------------------------------
describe('reexport-chain — scenario 4: named rename re-export tracks original symbol name', () => {
  it('returns reexport row with original symbolName renamedSymbol through rename-barrel.ts', async () => {
    const { project, repoRoot } = makeProject();
    const response = await reexportChain(
      { symbol: 'renamedSymbol', from: 'rename-source.ts' },
      project,
      repoRoot,
    );

    expect(response.query).toBe('reexport-chain');
    expect(response.error).toBeUndefined();

    // Exact count: 1 declaration + 1 reexport + 1 importer = 3 rows
    expect(response.results).toHaveLength(3);

    const reexportRows = response.results.filter((r) => r.kind === 'reexport');
    expect(reexportRows).toHaveLength(1);
    expect(reexportRows[0]).toMatchObject({
      file: 'rename-barrel.ts',
      kind: 'reexport',
      // The original symbol name is preserved in the row
      symbolName: 'renamedSymbol',
      throughBarrel: 'rename-barrel.ts',
      distance: 1,
      confidence: 'exact',
    });
  });

  it('returns importer row for the consumer of the renamed symbol', async () => {
    const { project, repoRoot } = makeProject();
    const response = await reexportChain(
      { symbol: 'renamedSymbol', from: 'rename-source.ts' },
      project,
      repoRoot,
    );

    expect(response.error).toBeUndefined();

    const importerRows = response.results.filter((r) => r.kind === 'importer');
    expect(importerRows).toHaveLength(1);
    expect(importerRows[0]).toMatchObject({
      file: 'rename-consumer.ts',
      kind: 'importer',
      distance: 1,
      confidence: 'exact',
    });
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: default re-export — export { default } from '...'
// ---------------------------------------------------------------------------
describe('reexport-chain — scenario 5: default re-export chain works', () => {
  it('returns declaration, reexport, and importer rows for a default export chain', async () => {
    const { project, repoRoot } = makeProject();
    const response = await reexportChain(
      { symbol: 'default', from: 'default-source.ts' },
      project,
      repoRoot,
    );

    expect(response.query).toBe('reexport-chain');
    expect(response.error).toBeUndefined();

    // Exact count: 1 declaration + 1 reexport + 1 importer = 3 rows
    expect(response.results).toHaveLength(3);

    const declarationRows = response.results.filter((r) => r.kind === 'declaration');
    expect(declarationRows).toHaveLength(1);
    expect(declarationRows[0]).toMatchObject({
      file: 'default-source.ts',
      kind: 'declaration',
      symbolName: 'default',
      throughBarrel: null,
      distance: 0,
      confidence: 'exact',
    });

    const reexportRows = response.results.filter((r) => r.kind === 'reexport');
    expect(reexportRows).toHaveLength(1);
    expect(reexportRows[0]).toMatchObject({
      file: 'default-barrel.ts',
      kind: 'reexport',
      symbolName: 'default',
      throughBarrel: 'default-barrel.ts',
      distance: 1,
      confidence: 'exact',
    });

    const importerRows = response.results.filter((r) => r.kind === 'importer');
    expect(importerRows).toHaveLength(1);
    expect(importerRows[0]).toMatchObject({
      file: 'default-consumer.ts',
      kind: 'importer',
      symbolName: 'default',
      throughBarrel: null,
      distance: 1,
      confidence: 'exact',
    });
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: response shape invariants (PRODUCT.md inv. 13, 15, 16, 29)
// ---------------------------------------------------------------------------
describe('reexport-chain — response shape invariants', () => {
  it('result rows carry required BaseResult fields with 1-based line/column', async () => {
    const { project, repoRoot } = makeProject();
    const response = await reexportChain(
      { symbol: 'oneHopSymbol', from: 'one-hop-source.ts' },
      project,
      repoRoot,
    );

    expect(response.error).toBeUndefined();
    for (const row of response.results) {
      // line and column must be 1-based (PRODUCT.md P-13).
      expect(row.line).toBeGreaterThanOrEqual(1);
      expect(row.column).toBeGreaterThanOrEqual(1);
      // file must be a relative POSIX path (PRODUCT.md P-16) — no absolute paths.
      expect(row.file).not.toMatch(/^[/\\]/);
      // confidence must be 'exact' for reexport-chain.
      expect(row.confidence).toBe('exact');
    }
  });

  it('query name is reexport-chain and response has truncated and durationMs fields', async () => {
    const { project, repoRoot } = makeProject();
    const response = await reexportChain(
      { symbol: 'oneHopSymbol', from: 'one-hop-source.ts' },
      project,
      repoRoot,
    );

    expect(response.query).toBe('reexport-chain');
    expect(typeof response.truncated).toBe('boolean');
    expect(typeof response.durationMs).toBe('number');
    expect(response.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns structured error when the symbol is not found in the specified file', async () => {
    const { project, repoRoot } = makeProject();
    const response = await reexportChain(
      { symbol: 'nonExistentSymbol', from: 'direct-declaration.ts' },
      project,
      repoRoot,
    );

    expect(response.error).toBeDefined();
    expect(response.error?.kind).toBe('out_of_corpus');
    expect(response.results).toHaveLength(0);
  });

  it('returns structured error when the specified file is not in the project', async () => {
    const { project, repoRoot } = makeProject();
    const response = await reexportChain(
      { symbol: 'anything', from: 'does-not-exist.ts' },
      project,
      repoRoot,
    );

    expect(response.error).toBeDefined();
    expect(response.error?.kind).toBe('unknown_file');
    expect(response.results).toHaveLength(0);
  });
});

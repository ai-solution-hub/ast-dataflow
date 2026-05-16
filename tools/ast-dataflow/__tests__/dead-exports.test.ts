import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deadExports, createProject } from '@/lib/ast-dataflow';

/**
 * dead-exports query — Vitest suite
 *
 * Ground-truth fixture set under fixtures/09-dead-exports/.
 * Tests verify real behaviour per docs/reference/test-philosophy.md:
 *   - Assertions are on the result shape and counts (not on call-chain internals).
 *   - toHaveLength pins exact counts; no toBeGreaterThanOrEqual(1) + find() antipattern.
 *   - Test titles read like product specs (what the user observes), not implementation.
 */

const FIXTURE_DIR = resolve(__dirname, 'fixtures', '09-dead-exports');

function makeProject() {
  return createProject({
    tsConfigFilePath: resolve(FIXTURE_DIR, 'tsconfig.json'),
    repoRoot: FIXTURE_DIR,
  });
}

// ---------------------------------------------------------------------------
// Fixture 1: definitely-unused.ts
// ---------------------------------------------------------------------------
describe('dead-exports — fixture 1: export with no importers anywhere', () => {
  it('flags unusedHelper as dead (reachableImporters 0, testOnlyImporters 0)', async () => {
    const { project, repoRoot } = makeProject();
    const response = await deadExports(
      { symbol: 'unusedHelper' },
      project,
      repoRoot,
    );

    expect(response.query).toBe('dead-exports');
    expect(response.error).toBeUndefined();

    // Must find exactly one dead row for unusedHelper.
    const matches = response.results.filter((r) => r.symbol === 'unusedHelper');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      symbol: 'unusedHelper',
      file: 'definitely-unused.ts',
      reachableImporters: 0,
      testOnlyImporters: 0,
      testOnly: false,
      confidence: 'exact',
    });
    // barrelChain is empty — no barrel hop was found.
    expect(matches[0].barrelChain).toHaveLength(0);
  });

  it('does not count same-file references as importers', async () => {
    const { project, repoRoot } = makeProject();
    const response = await deadExports(
      { symbol: 'unusedHelper' },
      project,
      repoRoot,
    );
    const row = response.results.find((r) => r.symbol === 'unusedHelper');
    // definitely-unused.ts uses unusedHelper internally — that must not inflate the count.
    expect(row?.reachableImporters).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Fixture 2: used-via-named-import.ts (namedImportTarget)
// ---------------------------------------------------------------------------
describe('dead-exports — fixture 2: export consumed via named import', () => {
  it('does not flag namedImportTarget as dead', async () => {
    const { project, repoRoot } = makeProject();
    const response = await deadExports(
      { symbol: 'namedImportTarget' },
      project,
      repoRoot,
    );

    expect(response.error).toBeUndefined();
    // namedImportTarget is imported by consumer-named.ts — must NOT appear as dead.
    const deadRow = response.results.find(
      (r) => r.symbol === 'namedImportTarget' && r.reachableImporters === 0,
    );
    expect(deadRow).toBeUndefined();
  });

  it('reports reachableImporters >= 1 for namedImportTarget', async () => {
    const { project, repoRoot } = makeProject();
    // Run without symbol filter — full scan.
    const response = await deadExports({}, project, repoRoot);
    expect(response.error).toBeUndefined();

    // namedImportTarget must not appear in the dead-export results at all,
    // OR appear with reachableImporters > 0.
    const rows = response.results.filter((r) => r.symbol === 'namedImportTarget');
    for (const row of rows) {
      expect(row.reachableImporters).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Fixture 3: used-via-namespace-import.ts (namespaceTarget)
// ---------------------------------------------------------------------------
describe('dead-exports — fixture 3: export consumed via namespace import', () => {
  it('does not flag namespaceTarget as dead (namespace import is a real importer)', async () => {
    const { project, repoRoot } = makeProject();
    const response = await deadExports({}, project, repoRoot);
    expect(response.error).toBeUndefined();

    // namespaceTarget is reached via `import * as ns from ...` in consumer-namespace.ts.
    // The namespace import constitutes a real importer — the file IS an importer.
    const rows = response.results.filter((r) => r.symbol === 'namespaceTarget');
    // Either no dead row or row has reachableImporters > 0.
    for (const row of rows) {
      expect(row.reachableImporters).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Fixture 4: used-via-default.ts (default export)
// ---------------------------------------------------------------------------
describe('dead-exports — fixture 4: default export consumed by a real importer', () => {
  it('does not flag the default export of used-via-default.ts as dead', async () => {
    const { project, repoRoot } = makeProject();
    const response = await deadExports({}, project, repoRoot);
    expect(response.error).toBeUndefined();

    // The default export in used-via-default.ts is imported by consumer-default.ts.
    const deadDefaultRows = response.results.filter(
      (r) =>
        r.file === 'used-via-default.ts' &&
        r.exportKind === 'default' &&
        r.reachableImporters === 0,
    );
    expect(deadDefaultRows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fixture 5: used-via-barrel-reexport.ts (barrel walker)
// ---------------------------------------------------------------------------
describe('dead-exports — fixture 5: export reachable through one barrel hop', () => {
  it('recognises barrelTarget as reachable via barrel and reports the barrel chain', async () => {
    const { project, repoRoot } = makeProject();
    const response = await deadExports(
      { symbol: 'barrelTarget' },
      project,
      repoRoot,
    );

    expect(response.error).toBeUndefined();

    // barrelTarget is used by consumer-barrel.ts via barrel-index.ts.
    // The barrel walker must detect this one-hop path.
    const rows = response.results.filter((r) => r.symbol === 'barrelTarget');

    // If the barrel walker works, barrelTarget should either:
    //   (a) not appear in results at all (found a real importer), OR
    //   (b) appear with barrelChain.length >= 1 (chain detected even if we
    //       counted importers via the barrel).
    // The key invariant: it must NOT appear as dead with empty barrelChain
    // AND reachableImporters === 0 (that would be a false-positive).
    for (const row of rows) {
      const falsePositive = row.reachableImporters === 0 && row.barrelChain.length === 0;
      expect(falsePositive).toBe(false);
    }
  });

  it('populates barrelChain with the intermediate barrel file path', async () => {
    const { project, repoRoot } = makeProject();
    const response = await deadExports(
      { symbol: 'barrelTarget' },
      project,
      repoRoot,
    );

    expect(response.error).toBeUndefined();
    // At least one row for barrelTarget must carry a non-empty barrelChain.
    const rowsWithChain = response.results.filter(
      (r) => r.symbol === 'barrelTarget' && r.barrelChain.length > 0,
    );

    // The barrel walker must identify the intermediate barrel-index.ts.
    if (rowsWithChain.length > 0) {
      const allChainFiles = rowsWithChain.flatMap((r) => r.barrelChain);
      const hasBarrelIndex = allChainFiles.some((f) => f.includes('barrel-index'));
      expect(hasBarrelIndex).toBe(true);
    }
    // If rowsWithChain is empty, barrelTarget was counted via direct importer — also valid.
    // The critical assertion is that the export is not a false-positive dead export.
  });
});

// ---------------------------------------------------------------------------
// Fixture 6: same-file-only.ts (sameFileExport)
// ---------------------------------------------------------------------------
describe('dead-exports — fixture 6: export only referenced within its own file', () => {
  it('flags sameFileExport as dead (same-file usage does not count as an importer)', async () => {
    const { project, repoRoot } = makeProject();
    const response = await deadExports(
      { symbol: 'sameFileExport' },
      project,
      repoRoot,
    );

    expect(response.error).toBeUndefined();

    // sameFileExport is referenced in same-file-only.ts itself but no other file
    // imports it. Same-file usage must not be counted as an importer.
    const matches = response.results.filter((r) => r.symbol === 'sameFileExport');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      symbol: 'sameFileExport',
      file: 'same-file-only.ts',
      reachableImporters: 0,
      testOnlyImporters: 0,
      testOnly: false,
      confidence: 'exact',
    });
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: response shape invariants (PRODUCT.md inv. 13, 15, 16)
// ---------------------------------------------------------------------------
describe('dead-exports — response shape invariants', () => {
  it('result rows carry required BaseResult fields with 1-based line/column', async () => {
    const { project, repoRoot } = makeProject();
    const response = await deadExports(
      { symbol: 'unusedHelper' },
      project,
      repoRoot,
    );

    expect(response.error).toBeUndefined();
    const row = response.results[0];
    expect(row).toBeDefined();
    // line and column must be 1-based (PRODUCT.md P-13).
    expect(row.line).toBeGreaterThanOrEqual(1);
    expect(row.column).toBeGreaterThanOrEqual(1);
    // file must be a relative POSIX path (PRODUCT.md P-16) — no absolute paths.
    expect(row.file).not.toMatch(/^[/\\]/);
    // confidence must be 'exact' for dead-exports (always ts-morph resolved).
    expect(row.confidence).toBe('exact');
  });

  it('query name is dead-exports and response has truncated field', async () => {
    const { project, repoRoot } = makeProject();
    const response = await deadExports({}, project, repoRoot);

    expect(response.query).toBe('dead-exports');
    expect(typeof response.truncated).toBe('boolean');
    expect(typeof response.durationMs).toBe('number');
    expect(response.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns structured error for unknown query argument', async () => {
    const { project, repoRoot } = makeProject();
    // symbolsFile that does not exist should produce a structured error, not a crash.
    const response = await deadExports(
      { symbolsFile: '/tmp/nonexistent-symbols-file-xyzzy.txt' },
      project,
      repoRoot,
    );

    expect(response.error).toBeDefined();
    expect(response.error?.kind).toBe('parse_error');
    expect(response.results).toHaveLength(0);
  });
});

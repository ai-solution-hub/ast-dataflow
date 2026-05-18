import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProject, importers } from '@/lib/ast-dataflow';

const FIXTURE_DIR = resolve(__dirname, 'fixtures', '05-importers');
const VITE_FIXTURE_DIR = resolve(__dirname, 'fixtures', '15-vite');

describe('importers query — fixture', () => {
  it('returns 7 rows for target.ts (one per importing file)', async () => {
    const { project, repoRoot } = createProject({
      tsConfigFilePath: resolve(FIXTURE_DIR, 'tsconfig.json'),
      repoRoot: FIXTURE_DIR,
    });

    const response = await importers(
      { modulePath: 'target.ts' },
      project,
      repoRoot,
    );

    expect(response.query).toBe('importers');
    expect(response.truncated).toBe(false);
    // 7 importing files: named, default, namespace, typeonly, reexport, aliased, unused
    expect(response.results.length).toBe(7);

    const files = response.results.map((r) => r.file).sort();
    expect(files).toEqual([
      'caller-aliased.ts',
      'caller-default.ts',
      'caller-named.ts',
      'caller-namespace.ts',
      'caller-reexport.ts',
      'caller-typeonly.ts',
      'caller-unused.ts',
    ]);
  });

  it('sets importStyle correctly for each import type', async () => {
    const { project, repoRoot } = createProject({
      tsConfigFilePath: resolve(FIXTURE_DIR, 'tsconfig.json'),
      repoRoot: FIXTURE_DIR,
    });

    const response = await importers(
      { modulePath: 'target.ts' },
      project,
      repoRoot,
    );

    const byFile = Object.fromEntries(response.results.map((r) => [r.file, r]));

    expect(byFile['caller-named.ts']?.importStyle).toBe('named');
    expect(byFile['caller-default.ts']?.importStyle).toBe('default');
    expect(byFile['caller-namespace.ts']?.importStyle).toBe('namespace');
    expect(byFile['caller-typeonly.ts']?.importStyle).toBe('typeOnly');
    // re-export has no ImportDeclaration; it appears via ExportDeclaration
    expect(byFile['caller-reexport.ts']?.importStyle).toBe('reexport');
    expect(byFile['caller-aliased.ts']?.importStyle).toBe('named');
    expect(byFile['caller-unused.ts']?.importStyle).toBe('named');
  });

  it('records the original name (not the alias) in namedImports for aliased imports', async () => {
    const { project, repoRoot } = createProject({
      tsConfigFilePath: resolve(FIXTURE_DIR, 'tsconfig.json'),
      repoRoot: FIXTURE_DIR,
    });

    const response = await importers(
      { modulePath: 'target.ts' },
      project,
      repoRoot,
    );

    const aliasedRow = response.results.find(
      (r) => r.file === 'caller-aliased.ts',
    );
    expect(aliasedRow).toBeDefined();
    // Original name is 'foo', not the alias 'renamedFoo'
    expect(aliasedRow?.namedImports).toEqual(['foo']);
  });

  it('sets isReexportOnly true only for the re-export file', async () => {
    const { project, repoRoot } = createProject({
      tsConfigFilePath: resolve(FIXTURE_DIR, 'tsconfig.json'),
      repoRoot: FIXTURE_DIR,
    });

    const response = await importers(
      { modulePath: 'target.ts' },
      project,
      repoRoot,
    );

    for (const row of response.results) {
      if (row.file === 'caller-reexport.ts') {
        expect(row.isReexportOnly).toBe(true);
      } else {
        expect(row.isReexportOnly).toBe(false);
      }
    }
  });

  it('marks unused imports as unused: true', async () => {
    const { project, repoRoot } = createProject({
      tsConfigFilePath: resolve(FIXTURE_DIR, 'tsconfig.json'),
      repoRoot: FIXTURE_DIR,
    });

    const response = await importers(
      { modulePath: 'target.ts' },
      project,
      repoRoot,
    );

    // Exhaustive expected-unused table for all 7 fixture files
    const expectedUnused: Record<string, boolean> = {
      'caller-unused.ts': true,
      'caller-named.ts': false,
      'caller-aliased.ts': false,
      'caller-default.ts': false,
      'caller-namespace.ts': false,
      'caller-reexport.ts': false,
      'caller-typeonly.ts': false,
    };

    for (const row of response.results) {
      expect(row.unused).toBe(expectedUnused[row.file] ?? false);
    }
  });

  it('excludes noise.ts which does not import target', async () => {
    const { project, repoRoot } = createProject({
      tsConfigFilePath: resolve(FIXTURE_DIR, 'tsconfig.json'),
      repoRoot: FIXTURE_DIR,
    });

    const response = await importers(
      { modulePath: 'target.ts' },
      project,
      repoRoot,
    );

    const noiseRow = response.results.find((r) => r.file === 'noise.ts');
    expect(noiseRow).toBeUndefined();
  });

  it('returns parse_error on empty modulePath', async () => {
    const { project, repoRoot } = createProject({
      tsConfigFilePath: resolve(FIXTURE_DIR, 'tsconfig.json'),
      repoRoot: FIXTURE_DIR,
    });

    const response = await importers({ modulePath: '' }, project, repoRoot);
    expect(response.error?.kind).toBe('parse_error');
    expect(response.results).toEqual([]);
  });

  it('confidence is always exact', async () => {
    const { project, repoRoot } = createProject({
      tsConfigFilePath: resolve(FIXTURE_DIR, 'tsconfig.json'),
      repoRoot: FIXTURE_DIR,
    });

    const response = await importers(
      { modulePath: 'target.ts' },
      project,
      repoRoot,
    );

    for (const row of response.results) {
      expect(row.confidence).toBe('exact');
    }
  });
});

describe('importers query — Vite fixture (non-@/ path alias)', () => {
  /**
   * Fixture 15-vite uses "~/*" → "./src/*" as its tsconfig path alias.
   * DateDisplay.tsx imports via ~/utils/format (alias path).
   * PriceTag.tsx imports via ../utils/format (relative path).
   * The importers query must resolve both correctly.
   */

  it('finds alias importer (~/utils/format) when querying src/utils/format.ts', async () => {
    const { project, repoRoot } = createProject({
      tsConfigFilePath: resolve(VITE_FIXTURE_DIR, 'tsconfig.json'),
      repoRoot: VITE_FIXTURE_DIR,
    });

    const response = await importers(
      { modulePath: 'src/utils/format.ts' },
      project,
      repoRoot,
    );

    expect(response.query).toBe('importers');
    expect(response.error).toBeUndefined();

    const files = response.results.map((r) => r.file).sort();
    // Both DateDisplay (alias import) and PriceTag (relative import) should appear
    expect(files).toContain('src/components/DateDisplay.tsx');
    expect(files).toContain('src/components/PriceTag.tsx');
    // 3 files: DateDisplay (alias), PriceTag (relative), AliasSuffixCallerOnly (relative)
    expect(files).toHaveLength(3);
  });

  it('resolves alias importer with exact confidence', async () => {
    const { project, repoRoot } = createProject({
      tsConfigFilePath: resolve(VITE_FIXTURE_DIR, 'tsconfig.json'),
      repoRoot: VITE_FIXTURE_DIR,
    });

    const response = await importers(
      { modulePath: 'src/utils/format.ts' },
      project,
      repoRoot,
    );

    for (const row of response.results) {
      expect(row.confidence).toBe('exact');
    }
  });

  it('finds the correct named imports from the alias importer', async () => {
    const { project, repoRoot } = createProject({
      tsConfigFilePath: resolve(VITE_FIXTURE_DIR, 'tsconfig.json'),
      repoRoot: VITE_FIXTURE_DIR,
    });

    const response = await importers(
      { modulePath: 'src/utils/format.ts' },
      project,
      repoRoot,
    );

    const byFile = Object.fromEntries(response.results.map((r) => [r.file, r]));

    // DateDisplay imports both formatDate and formatCurrency
    expect(byFile['src/components/DateDisplay.tsx']?.namedImports).toEqual(
      expect.arrayContaining(['formatDate', 'formatCurrency']),
    );

    // PriceTag imports only formatCurrency
    expect(byFile['src/components/PriceTag.tsx']?.namedImports).toEqual([
      'formatCurrency',
    ]);
  });

  it('resolves alias-prefixed modulePath (~/utils/format) to find importers', async () => {
    /**
     * This test exercises the alias-strip branch in resolveTargetFilePath.
     * The user passes the alias form ~/utils/format as the modulePath.
     * The query must strip the ~/ prefix (not just @/) to locate the file.
     */
    const { project, repoRoot } = createProject({
      tsConfigFilePath: resolve(VITE_FIXTURE_DIR, 'tsconfig.json'),
      repoRoot: VITE_FIXTURE_DIR,
    });

    const response = await importers(
      { modulePath: '~/utils/format' },
      project,
      repoRoot,
    );

    expect(response.query).toBe('importers');
    expect(response.error).toBeUndefined();
    // DateDisplay.tsx uses ~/utils/format alias import — must be found
    const files = response.results.map((r) => r.file);
    expect(files).toContain('src/components/DateDisplay.tsx');
  });
});

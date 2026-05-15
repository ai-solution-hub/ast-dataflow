import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProject, importers } from '@/lib/ast-dataflow';

const FIXTURE_DIR = resolve(__dirname, 'fixtures', '05-importers');

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

    const byFile = Object.fromEntries(
      response.results.map((r) => [r.file, r]),
    );

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

    const unusedRow = response.results.find(
      (r) => r.file === 'caller-unused.ts',
    );
    expect(unusedRow).toBeDefined();
    expect(unusedRow?.unused).toBe(true);

    // All other rows (that have named imports and use them) are not unused
    for (const row of response.results) {
      if (row.file !== 'caller-unused.ts' && row.namedImports.length > 0) {
        if (row.file !== 'caller-reexport.ts') {
          expect(row.unused).toBe(false);
        }
      }
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

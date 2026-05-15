import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProject, references } from '@/lib/ast-dataflow';

const FIXTURE_DIR = resolve(__dirname, 'fixtures', '06-references');

function makeProject() {
  return createProject({
    tsConfigFilePath: resolve(FIXTURE_DIR, 'tsconfig.json'),
    repoRoot: FIXTURE_DIR,
  });
}

describe('references query — typeReference kind', () => {
  it('classifies a type-annotation reference as typeReference', async () => {
    const { project, repoRoot } = makeProject();

    const response = await references(
      { symbol: 'target.ts:MyState' },
      project,
      repoRoot,
    );

    expect(response.query).toBe('references');
    // There should be at least one typeReference result (in case-typeReference.ts)
    const typeRefs = response.results.filter((r) => r.kind === 'typeReference');
    expect(typeRefs.length).toBeGreaterThanOrEqual(1);
    const inFixture = typeRefs.find((r) => r.file === 'case-typeReference.ts');
    expect(inFixture).toBeDefined();
    expect(inFixture?.confidence).toBe('exact');
    expect(inFixture?.isDefinition).toBe(false);
  });
});

describe('references query — read kind', () => {
  it('classifies a runtime identifier read as read', async () => {
    const { project, repoRoot } = makeProject();

    const response = await references(
      { symbol: 'target.ts:MY_CONSTANT' },
      project,
      repoRoot,
    );

    const readRefs = response.results.filter((r) => r.kind === 'read');
    expect(readRefs.length).toBeGreaterThanOrEqual(1);
    const inFixture = readRefs.find((r) => r.file === 'case-read.ts');
    expect(inFixture).toBeDefined();
  });
});

describe('references query — write kind', () => {
  it('classifies a mutation assignment as write', async () => {
    const { project, repoRoot } = makeProject();

    const response = await references(
      { symbol: 'case-write.ts:writableState' },
      project,
      repoRoot,
    );

    const writeRefs = response.results.filter((r) => r.kind === 'write');
    expect(writeRefs.length).toBeGreaterThanOrEqual(1);
    const inFixture = writeRefs.find((r) => r.file === 'case-write.ts');
    expect(inFixture).toBeDefined();
  });
});

describe('references query — reexport kind', () => {
  it('classifies a named re-export as reexport', async () => {
    const { project, repoRoot } = makeProject();

    const response = await references(
      { symbol: 'target.ts:MY_CONSTANT' },
      project,
      repoRoot,
    );

    const reexportRefs = response.results.filter((r) => r.kind === 'reexport');
    expect(reexportRefs.length).toBeGreaterThanOrEqual(1);
    const inFixture = reexportRefs.find((r) => r.file === 'case-reexport.ts');
    expect(inFixture).toBeDefined();
  });
});

describe('references query — typeOnly kind', () => {
  it('classifies an import type reference as typeOnly', async () => {
    const { project, repoRoot } = makeProject();

    const response = await references(
      { symbol: 'target.ts:MyState' },
      project,
      repoRoot,
    );

    const typeOnlyRefs = response.results.filter((r) => r.kind === 'typeOnly');
    expect(typeOnlyRefs.length).toBeGreaterThanOrEqual(1);
    const inFixture = typeOnlyRefs.find((r) => r.file === 'case-typeOnly.ts');
    expect(inFixture).toBeDefined();
  });
});

describe('references query — jsxComponent kind', () => {
  it('classifies a JSX component reference as jsxComponent', async () => {
    const { project, repoRoot } = makeProject();

    const response = await references(
      { symbol: 'component-target.tsx:MyWidget' },
      project,
      repoRoot,
    );

    const jsxRefs = response.results.filter((r) => r.kind === 'jsxComponent');
    expect(jsxRefs.length).toBeGreaterThanOrEqual(1);
    const inFixture = jsxRefs.find((r) => r.file === 'case-jsxComponent.tsx');
    expect(inFixture).toBeDefined();
  });
});

describe('references query — general behaviour', () => {
  it('includes definition row when isDefinition=true', async () => {
    const { project, repoRoot } = makeProject();

    const response = await references(
      { symbol: 'target.ts:MY_CONSTANT' },
      project,
      repoRoot,
    );

    const defRow = response.results.find((r) => r.isDefinition);
    expect(defRow).toBeDefined();
    expect(defRow?.file).toBe('target.ts');
  });

  it('--kind filter returns only matching rows', async () => {
    const { project, repoRoot } = makeProject();

    const response = await references(
      { symbol: 'target.ts:MY_CONSTANT', kind: 'reexport' },
      project,
      repoRoot,
    );

    expect(response.results.every((r) => r.kind === 'reexport')).toBe(true);
    expect(response.results.length).toBeGreaterThanOrEqual(1);
  });

  it('returns enclosing for each non-definition row', async () => {
    const { project, repoRoot } = makeProject();

    const response = await references(
      { symbol: 'target.ts:MY_CONSTANT' },
      project,
      repoRoot,
    );

    for (const row of response.results.filter((r) => !r.isDefinition)) {
      expect(typeof row.enclosing).toBe('string');
      expect(row.enclosing.length).toBeGreaterThan(0);
    }
  });
});

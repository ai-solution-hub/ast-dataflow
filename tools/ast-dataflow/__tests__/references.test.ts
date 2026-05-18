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
    // case-typeReference.ts line 4: function return type annotation — typeReference
    const typeRefs = response.results.filter((r) => r.kind === 'typeReference');
    const inFixture = typeRefs.find((r) => r.file === 'case-typeReference.ts');
    expect(inFixture).toMatchObject({
      file: 'case-typeReference.ts',
      line: 4,
      column: 22,
      confidence: 'exact',
      kind: 'typeReference',
      isDefinition: false,
      enclosing: 'fn:getState',
    });
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
    // case-read.ts line 5: console.log(MY_CONSTANT) — runtime read
    const inFixture = readRefs.find(
      (r) => r.file === 'case-read.ts' && r.line === 5,
    );
    expect(inFixture).toMatchObject({
      file: 'case-read.ts',
      line: 5,
      column: 15,
      confidence: 'exact',
      kind: 'read',
      isDefinition: false,
      enclosing: 'fn:printConstant',
    });
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
    // case-write.ts line 9: writableState += 1 — LHS of BinaryExpression
    const inFixture = writeRefs.find(
      (r) => r.file === 'case-write.ts' && r.line === 9,
    );
    expect(inFixture).toMatchObject({
      file: 'case-write.ts',
      line: 9,
      column: 1,
      confidence: 'exact',
      kind: 'write',
      isDefinition: false,
      enclosing: 'moduleTopLevel',
    });
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
    // case-reexport.ts line 2: export { MY_CONSTANT } from './target'
    const inFixture = reexportRefs.find((r) => r.file === 'case-reexport.ts');
    expect(inFixture).toMatchObject({
      file: 'case-reexport.ts',
      line: 2,
      column: 10,
      confidence: 'exact',
      kind: 'reexport',
      isDefinition: false,
      enclosing: 'moduleTopLevel',
    });
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
    // case-typeOnly.ts line 2: import type { MyState } — typeOnly import
    const inFixture = typeOnlyRefs.find((r) => r.file === 'case-typeOnly.ts');
    expect(inFixture).toMatchObject({
      file: 'case-typeOnly.ts',
      line: 2,
      column: 15,
      confidence: 'exact',
      kind: 'typeOnly',
      isDefinition: false,
      enclosing: 'moduleTopLevel',
    });
    // Note: case-typeOnly.ts line 4 (`type StateAlias = MyState`) legitimately
    // produces kind:'typeReference' — a type usage in a type alias is correctly
    // classified as typeReference, not typeOnly. The priority-rule leak guard
    // from the audit (no typeReference rows in case-typeOnly.ts) cannot be applied
    // because the production code correctly emits one for the type alias usage.
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
    // case-jsxComponent.tsx line 6: <MyWidget /> — JSX opening element
    const inFixture = jsxRefs.find((r) => r.file === 'case-jsxComponent.tsx');
    expect(inFixture).toMatchObject({
      file: 'case-jsxComponent.tsx',
      line: 6,
      column: 11,
      confidence: 'exact',
      kind: 'jsxComponent',
      isDefinition: false,
      enclosing: 'fn:Page',
    });
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

    // Expected enclosing per (file, line) for every non-definition row
    const expectedEnclosing: Record<string, string> = {
      'target.ts:5': 'fn:myFunction',
      'case-read.ts:1': 'moduleTopLevel',
      'case-read.ts:5': 'fn:printConstant',
      'case-reexport.ts:2': 'moduleTopLevel',
    };

    for (const row of response.results.filter((r) => !r.isDefinition)) {
      const key = `${row.file}:${row.line}`;
      expect(row.enclosing).toBe(expectedEnclosing[key]);
    }
  });
});

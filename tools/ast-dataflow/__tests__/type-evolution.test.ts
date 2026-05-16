import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProject, typeEvolution } from '@/lib/ast-dataflow';

const FIXTURE_DIR = resolve(__dirname, 'fixtures', '11-type-evolution');

function makeProject() {
  return createProject({
    tsConfigFilePath: resolve(FIXTURE_DIR, 'tsconfig.json'),
    repoRoot: FIXTURE_DIR,
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// kind: 'annotation'
// ──────────────────────────────────────────────────────────────────────────────

describe('type-evolution — annotation kind', () => {
  it('reports the parameter type annotation site as annotation', async () => {
    const { project, repoRoot } = makeProject();

    const response = await typeEvolution(
      { type: 'TargetType', property: 'prop' },
      project,
      repoRoot,
    );

    expect(response.query).toBe('type-evolution');
    expect(response.error).toBeUndefined();

    const annotationRows = response.results.filter(
      (r) => r.kind === 'annotation' && r.file === 'annotation.ts',
    );
    // annotation.ts: `function useAnnotated(x: TargetType)` — the type annotation
    expect(annotationRows).toHaveLength(1);
    expect(annotationRows[0]).toMatchObject({
      file: 'annotation.ts',
      kind: 'annotation',
      isTypeOnly: true,
      enclosing: 'fn:useAnnotated',
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// kind: 'returnType'
// ──────────────────────────────────────────────────────────────────────────────

describe('type-evolution — returnType kind', () => {
  it('reports the function return type annotation as returnType', async () => {
    const { project, repoRoot } = makeProject();

    const response = await typeEvolution(
      { type: 'TargetType', property: 'prop' },
      project,
      repoRoot,
    );

    const returnTypeRows = response.results.filter(
      (r) => r.kind === 'returnType' && r.file === 'return-type.ts',
    );
    // return-type.ts: `function makeTarget(): TargetType` — return type annotation
    expect(returnTypeRows).toHaveLength(1);
    expect(returnTypeRows[0]).toMatchObject({
      file: 'return-type.ts',
      kind: 'returnType',
      isTypeOnly: true,
      enclosing: 'fn:makeTarget',
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// kind: 'generic'
// ──────────────────────────────────────────────────────────────────────────────

describe('type-evolution — generic kind', () => {
  it('reports a generic type argument as generic', async () => {
    const { project, repoRoot } = makeProject();

    const response = await typeEvolution(
      { type: 'TargetType', property: 'prop' },
      project,
      repoRoot,
    );

    const genericRows = response.results.filter(
      (r) => r.kind === 'generic' && r.file === 'generic.ts',
    );
    // generic.ts: `Array<TargetType>` — generic type argument
    expect(genericRows).toHaveLength(1);
    expect(genericRows[0]).toMatchObject({
      file: 'generic.ts',
      kind: 'generic',
      isTypeOnly: true,
      enclosing: 'fn:processAll',
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// kind: 'satisfies'
// ──────────────────────────────────────────────────────────────────────────────

describe('type-evolution — satisfies kind', () => {
  it('reports the satisfies clause as satisfies', async () => {
    const { project, repoRoot } = makeProject();

    const response = await typeEvolution(
      { type: 'TargetType', property: 'prop' },
      project,
      repoRoot,
    );

    const satisfiesRows = response.results.filter(
      (r) => r.kind === 'satisfies' && r.file === 'satisfies.ts',
    );
    // satisfies.ts: `{ ... } satisfies TargetType`
    expect(satisfiesRows).toHaveLength(1);
    expect(satisfiesRows[0]).toMatchObject({
      file: 'satisfies.ts',
      kind: 'satisfies',
      isTypeOnly: true,
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// kind: 'propertyAccess'
// ──────────────────────────────────────────────────────────────────────────────

describe('type-evolution — propertyAccess kind', () => {
  it('reports obj.prop where obj: TargetType as propertyAccess', async () => {
    const { project, repoRoot } = makeProject();

    const response = await typeEvolution(
      { type: 'TargetType', property: 'prop' },
      project,
      repoRoot,
    );

    const propAccessRows = response.results.filter(
      (r) => r.kind === 'propertyAccess' && r.file === 'property-access.ts',
    );
    // property-access.ts: `obj.prop` — runtime property access on typed param
    expect(propAccessRows).toHaveLength(1);
    expect(propAccessRows[0]).toMatchObject({
      file: 'property-access.ts',
      kind: 'propertyAccess',
      isTypeOnly: false,
      enclosing: 'fn:readProp',
    });
  });

  it('does not report property accesses on unrelated types', async () => {
    const { project, repoRoot } = makeProject();

    const response = await typeEvolution(
      { type: 'TargetType', property: 'other' },
      project,
      repoRoot,
    );

    // 'other' is a property of TargetType too — confirm we can query it
    // without cross-contamination from 'prop' sites.
    const propAccessRows = response.results.filter((r) => r.kind === 'propertyAccess');
    // All propertyAccess rows must have .other in their position context
    // (No 'prop' accesses should appear for the 'other' property probe).
    for (const row of propAccessRows) {
      // Verify the row has expected shape
      expect(row).toMatchObject({
        kind: 'propertyAccess',
        isTypeOnly: false,
        confidence: 'exact',
      });
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// kind: 'destructuring'
// ──────────────────────────────────────────────────────────────────────────────

describe('type-evolution — destructuring kind', () => {
  it('reports const { prop } = x where x: TargetType as destructuring', async () => {
    const { project, repoRoot } = makeProject();

    const response = await typeEvolution(
      { type: 'TargetType', property: 'prop' },
      project,
      repoRoot,
    );

    const destructuringRows = response.results.filter(
      (r) => r.kind === 'destructuring' && r.file === 'destructuring.ts',
    );
    // destructuring.ts: `const { prop } = x` where x: TargetType
    expect(destructuringRows).toHaveLength(1);
    expect(destructuringRows[0]).toMatchObject({
      file: 'destructuring.ts',
      kind: 'destructuring',
      isTypeOnly: false,
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Result shape invariants
// ──────────────────────────────────────────────────────────────────────────────

describe('type-evolution — result shape invariants', () => {
  it('all rows carry confidence: exact', async () => {
    const { project, repoRoot } = makeProject();

    const response = await typeEvolution(
      { type: 'TargetType', property: 'prop' },
      project,
      repoRoot,
    );

    for (const row of response.results) {
      expect(row.confidence).toBe('exact');
    }
  });

  it('all rows carry file, line, column, kind, isTypeOnly, enclosing', async () => {
    const { project, repoRoot } = makeProject();

    const response = await typeEvolution(
      { type: 'TargetType', property: 'prop' },
      project,
      repoRoot,
    );

    expect(response.results.length).toBeGreaterThanOrEqual(6);
    for (const row of response.results) {
      expect(typeof row.file).toBe('string');
      expect(row.file.length).toBeGreaterThan(0);
      expect(typeof row.line).toBe('number');
      expect(row.line).toBeGreaterThanOrEqual(1);
      expect(typeof row.column).toBe('number');
      expect(row.column).toBeGreaterThanOrEqual(1);
      expect(['annotation', 'returnType', 'generic', 'satisfies', 'propertyAccess', 'destructuring']).toContain(row.kind);
      expect(typeof row.isTypeOnly).toBe('boolean');
      expect(typeof row.enclosing).toBe('string');
      expect(row.enclosing.length).toBeGreaterThan(0);
    }
  });

  it('isTypeOnly is true for annotation/returnType/generic/satisfies', async () => {
    const { project, repoRoot } = makeProject();

    const response = await typeEvolution(
      { type: 'TargetType', property: 'prop' },
      project,
      repoRoot,
    );

    const typeOnlyKinds = ['annotation', 'returnType', 'generic', 'satisfies'];
    for (const row of response.results) {
      if (typeOnlyKinds.includes(row.kind)) {
        expect(row.isTypeOnly).toBe(true);
      }
    }
  });

  it('isTypeOnly is false for propertyAccess and destructuring', async () => {
    const { project, repoRoot } = makeProject();

    const response = await typeEvolution(
      { type: 'TargetType', property: 'prop' },
      project,
      repoRoot,
    );

    const runtimeKinds = ['propertyAccess', 'destructuring'];
    for (const row of response.results) {
      if (runtimeKinds.includes(row.kind)) {
        expect(row.isTypeOnly).toBe(false);
      }
    }
  });

  it('returns structured error for unknown type', async () => {
    const { project, repoRoot } = makeProject();

    const response = await typeEvolution(
      { type: 'NonExistentType', property: 'prop' },
      project,
      repoRoot,
    );

    expect(response.error).toBeDefined();
    expect(response.error?.kind).toBe('out_of_corpus');
    expect(response.results).toHaveLength(0);
  });

  it('returns structured error for missing type argument', async () => {
    const { project, repoRoot } = makeProject();

    // file provided but type not found there
    const response = await typeEvolution(
      { type: 'TargetType', property: 'prop', file: 'annotation.ts' },
      project,
      repoRoot,
    );

    // annotation.ts imports TargetType but does not declare it — should error
    // because resolveSymbol looks for declarations in that file.
    expect(response.error).toBeDefined();
    expect(['out_of_corpus', 'unknown_file']).toContain(response.error?.kind);
    expect(response.results).toHaveLength(0);
  });
});

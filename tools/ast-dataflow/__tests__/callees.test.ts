import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { callees, createProject } from '@/tools/ast-dataflow';

const FIXTURE_DIR = resolve(__dirname, 'fixtures', '19-callees');

function makeProject() {
  return createProject({
    tsConfigFilePath: resolve(FIXTURE_DIR, 'tsconfig.json'),
    repoRoot: FIXTURE_DIR,
  });
}

describe('callees query — fixture', () => {
  it('reports direct local and imported calls with call-site and callee positions', async () => {
    const { project, repoRoot } = makeProject();
    const response = await callees(
      { symbol: 'target.ts:subject' },
      project,
      repoRoot,
    );

    expect(response.query).toBe('callees');
    expect(response.truncated).toBe(false);
    // 9 call sites in subject's body; arr.map is external and excluded.
    expect(response.results).toHaveLength(8);

    const helperRow = response.results.find((r) => r.calleeName === 'helper');
    expect(helperRow).toMatchObject({
      file: 'target.ts',
      line: 16,
      column: 3,
      confidence: 'exact',
      enclosing: 'fn:subject',
      callKind: 'call',
      resolution: 'direct',
      callee: { file: 'target.ts', line: 5 },
    });

    const utilRow = response.results.find((r) => r.calleeName === 'util');
    expect(utilRow).toMatchObject({
      file: 'target.ts',
      line: 17,
      resolution: 'direct',
      confidence: 'exact',
      callee: { file: 'lib.ts', line: 1 },
    });
  });

  it('flags aliased import calls with importAlias metadata', async () => {
    const { project, repoRoot } = makeProject();
    const response = await callees(
      { symbol: 'target.ts:subject' },
      project,
      repoRoot,
    );

    const aliased = response.results.find((r) => r.line === 18);
    expect(aliased).toMatchObject({
      calleeName: 'u2',
      resolution: 'aliased',
      importAlias: 'u2',
      confidence: 'exact',
      callee: { file: 'lib2.ts', line: 1 },
    });
  });

  it('resolves method calls on annotated and inferred receivers to the same declaration', async () => {
    const { project, repoRoot } = makeProject();
    const response = await callees(
      { symbol: 'service-consumer.ts:usesService' },
      project,
      repoRoot,
    );

    // svcTyped.doThing() + s.doThing() + makeSvc().doThing()
    const doThingRows = response.results.filter(
      (r) => r.calleeName === 'doThing',
    );
    expect(doThingRows).toHaveLength(3);
    for (const row of doThingRows) {
      expect(row).toMatchObject({
        resolution: 'direct',
        confidence: 'exact',
        callee: { file: 'service.ts', line: 2 },
      });
    }
  });

  it('resolves a property chain to the rightmost name declaration', async () => {
    const { project, repoRoot } = makeProject();
    const response = await callees(
      { symbol: 'chain.ts:usesChain' },
      project,
      repoRoot,
    );

    expect(response.results).toHaveLength(1);
    expect(response.results[0]).toMatchObject({
      calleeName: 'get',
      callKind: 'call',
      resolution: 'direct',
      confidence: 'exact',
      callee: { file: 'chain.ts', line: 2 },
    });
  });

  it('reports a variable holding a function reference as indirect with the variable declaration site', async () => {
    const { project, repoRoot } = makeProject();
    const response = await callees(
      { symbol: 'target.ts:subject' },
      project,
      repoRoot,
    );

    const fnRefRow = response.results.find((r) => r.calleeName === 'fnRef');
    expect(fnRefRow).toMatchObject({
      line: 20,
      resolution: 'indirect',
      confidence: 'exact',
      callee: { file: 'target.ts', line: 19 },
    });
  });

  it('reports a callback parameter call as indirect with the parameter declaration site', async () => {
    const { project, repoRoot } = makeProject();
    const response = await callees(
      { symbol: 'target.ts:subject' },
      project,
      repoRoot,
    );

    const cbRow = response.results.find((r) => r.calleeName === 'cb');
    expect(cbRow).toMatchObject({
      line: 21,
      resolution: 'indirect',
      confidence: 'exact',
      callee: { file: 'target.ts', line: 15 },
    });
  });

  it('reports a dynamic element access as computed-property with indirect confidence', async () => {
    const { project, repoRoot } = makeProject();
    const response = await callees(
      { symbol: 'target.ts:subject' },
      project,
      repoRoot,
    );

    const dynamicRow = response.results.find((r) => r.line === 22);
    expect(dynamicRow).toMatchObject({
      calleeName: '<computed>',
      resolution: 'computed-property',
      confidence: 'indirect',
      callee: { file: null, line: null },
    });
  });

  it('includes calls inside nested closures with the outer enclosing function', async () => {
    const { project, repoRoot } = makeProject();
    const response = await callees(
      { symbol: 'target.ts:subject' },
      project,
      repoRoot,
    );

    const nestedRow = response.results.find((r) => r.calleeName === 'helper2');
    expect(nestedRow).toMatchObject({
      line: 23,
      enclosing: 'fn:subject',
      resolution: 'direct',
      callee: { file: 'target.ts', line: 9 },
    });
  });

  it('reports new-expressions with callKind new and the constructor as callee', async () => {
    const { project, repoRoot } = makeProject();
    const response = await callees(
      { symbol: 'target.ts:subject' },
      project,
      repoRoot,
    );

    const newRow = response.results.find((r) => r.calleeName === 'Widget');
    expect(newRow).toMatchObject({
      line: 24,
      callKind: 'new',
      resolution: 'direct',
      callee: { file: 'widget.ts', line: 4 },
    });
  });

  it('classifies super and this method calls with their base and own declarations', async () => {
    const { project, repoRoot } = makeProject();
    const response = await callees(
      { symbol: 'class-fixture.ts:Sub' },
      project,
      repoRoot,
    );

    const superRow = response.results.find((r) => r.line === 13);
    expect(superRow).toMatchObject({
      calleeName: 'm',
      callKind: 'super',
      resolution: 'direct',
      callee: { file: 'class-fixture.ts', line: 6 },
    });

    const thisRow = response.results.find((r) => r.line === 14);
    expect(thisRow).toMatchObject({
      calleeName: 'own',
      callKind: 'thisMethod',
      resolution: 'direct',
      callee: { file: 'class-fixture.ts', line: 18 },
    });
  });

  it('excludes external callees by default, surfaces them via externalCount, and never emits their paths', async () => {
    const { project, repoRoot } = makeProject();
    const defaultResponse = await callees(
      { symbol: 'target.ts:subject' },
      project,
      repoRoot,
    );

    expect(
      defaultResponse.results.filter((r) => r.calleeName === 'map'),
    ).toHaveLength(0);
    expect(defaultResponse.externalCount).toBe(1);

    const withExternal = await callees(
      { symbol: 'target.ts:subject', includeExternal: true },
      project,
      repoRoot,
    );
    expect(withExternal.results).toHaveLength(9);
    const mapRow = withExternal.results.find((r) => r.calleeName === 'map');
    expect(mapRow).toMatchObject({
      external: true,
      callee: { file: null, line: null },
    });
    // Inv 16: no node_modules or absolute paths anywhere in the envelope.
    const serialised = JSON.stringify(withExternal);
    expect(serialised).not.toContain('node_modules');
    expect(serialised).not.toContain(FIXTURE_DIR);
  });

  it('reports rows from every method body when the subject is a class', async () => {
    const { project, repoRoot } = makeProject();
    const response = await callees(
      { symbol: 'class-fixture.ts:Sub' },
      project,
      repoRoot,
    );

    expect(response.results).toHaveLength(3);
    const enclosings = response.results.map((r) => r.enclosing).sort();
    expect(enclosings).toEqual([
      'method:Sub.m',
      'method:Sub.m',
      'method:Sub.own',
    ]);
  });

  it('returns not_callable for a plain const and unknown_file for a missing file', async () => {
    const { project, repoRoot } = makeProject();

    const notCallable = await callees(
      { symbol: 'non-callable.ts:CONFIG' },
      project,
      repoRoot,
    );
    expect(notCallable.error?.kind).toBe('not_callable');
    expect(notCallable.results).toEqual([]);

    const unknownFile = await callees(
      { symbol: 'missing.ts:whatever' },
      project,
      repoRoot,
    );
    expect(unknownFile.error?.kind).toBe('unknown_file');
    expect(unknownFile.results).toEqual([]);
  });

  it('caps rows at the limit and reports the true total', async () => {
    const { project, repoRoot } = makeProject();
    const response = await callees(
      { symbol: 'target.ts:subject', limit: 2 },
      project,
      repoRoot,
    );

    expect(response.results).toHaveLength(2);
    expect(response.truncated).toBe(true);
    expect(response.totalEstimated).toBe(8);
  });
});

import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { callers, createProject } from '@/lib/ast-dataflow';

const FIXTURE_DIR = resolve(
  __dirname,
  'fixtures',
  '01-callers',
);

const ANON_FIXTURE_DIR = resolve(
  __dirname,
  'fixtures',
  '04-anonymous-enclosings',
);

describe('callers query — fixture', () => {
  it('finds direct callers across files', async () => {
    const { project, repoRoot } = createProject({
      tsConfigFilePath: resolve(FIXTURE_DIR, 'tsconfig.json'),
      repoRoot: FIXTURE_DIR,
    });

    const response = await callers(
      { symbol: 'target.ts:target' },
      project,
      repoRoot,
    );

    expect(response.query).toBe('callers');
    expect(response.truncated).toBe(false);
    // Direct: 3 hits (consumerOne + 2× consumerTwo)
    // Aliased: 1 hit (aliasedConsumer)
    // Total: 4
    expect(response.results.length).toBe(4);

    const files = response.results.map((r) => r.file).sort();
    expect(files).toEqual([
      'caller-aliased.ts',
      'caller-direct.ts',
      'caller-direct.ts',
      'caller-direct.ts',
    ]);
  });

  it('flags aliased imports with importAlias metadata', async () => {
    const { project, repoRoot } = createProject({
      tsConfigFilePath: resolve(FIXTURE_DIR, 'tsconfig.json'),
      repoRoot: FIXTURE_DIR,
    });

    const response = await callers(
      { symbol: 'target.ts:target' },
      project,
      repoRoot,
    );

    const aliased = response.results.find(
      (r) => r.file === 'caller-aliased.ts',
    );
    expect(aliased).toBeDefined();
    expect(aliased?.resolution).toBe('aliased');
    expect(aliased?.importAlias).toBe('renamedTarget');
  });

  it('records the enclosing function name', async () => {
    const { project, repoRoot } = createProject({
      tsConfigFilePath: resolve(FIXTURE_DIR, 'tsconfig.json'),
      repoRoot: FIXTURE_DIR,
    });

    const response = await callers(
      { symbol: 'target.ts:target' },
      project,
      repoRoot,
    );

    const enclosings = response.results.map((r) => r.enclosing).sort();
    expect(enclosings).toEqual([
      'fn:aliasedConsumer',
      'fn:consumerOne',
      'fn:consumerTwo',
      'fn:consumerTwo',
    ]);
  });

  it('excludes references that are not call sites', async () => {
    const { project, repoRoot } = createProject({
      tsConfigFilePath: resolve(FIXTURE_DIR, 'tsconfig.json'),
      repoRoot: FIXTURE_DIR,
    });

    const response = await callers(
      { symbol: 'target.ts:alsoCalled' },
      project,
      repoRoot,
    );

    // alsoCalled is imported in non-caller.ts and used as a call (1 hit only)
    expect(response.results.length).toBe(1);
    expect(response.results[0].file).toBe('non-caller.ts');
  });

  it('returns parse_error on malformed symbol identifier (no colon)', async () => {
    const { project, repoRoot } = createProject({
      tsConfigFilePath: resolve(FIXTURE_DIR, 'tsconfig.json'),
      repoRoot: FIXTURE_DIR,
    });

    const response = await callers(
      { symbol: 'no-colon-here' },
      project,
      repoRoot,
    );
    expect(response.error?.kind).toBe('parse_error');
    expect(response.results).toEqual([]);
  });

  it('returns out_of_corpus on unknown symbol in a known file', async () => {
    const { project, repoRoot } = createProject({
      tsConfigFilePath: resolve(FIXTURE_DIR, 'tsconfig.json'),
      repoRoot: FIXTURE_DIR,
    });

    const response = await callers(
      { symbol: 'target.ts:doesNotExist' },
      project,
      repoRoot,
    );
    expect(response.error?.kind).toBe('out_of_corpus');
    expect(response.results).toEqual([]);
  });
});

describe('callers query — anonymous enclosing resolution', () => {
  function makeProject() {
    return createProject({
      tsConfigFilePath: resolve(ANON_FIXTURE_DIR, 'tsconfig.json'),
      repoRoot: ANON_FIXTURE_DIR,
    });
  }

  it('PropertyAssignment: method shorthand resolves to method:<obj>.name', async () => {
    const { project, repoRoot } = makeProject();
    const response = await callers(
      { symbol: 'target.ts:target' },
      project,
      repoRoot,
    );
    const row = response.results.find((r) => r.file === 'property-assignment.ts' && r.line === 8);
    expect(row?.enclosing).toBe('method:myService.doWork');
  });

  it('PropertyAssignment: arrow-function value resolves to method:<obj>.name', async () => {
    const { project, repoRoot } = makeProject();
    const response = await callers(
      { symbol: 'target.ts:target' },
      project,
      repoRoot,
    );
    const row = response.results.find((r) => r.file === 'property-assignment.ts' && r.line === 16);
    expect(row?.enclosing).toBe('method:anotherService.transform');
  });

  it('CallExpression callback: .map() arrow resolves to outer named function', async () => {
    const { project, repoRoot } = makeProject();
    const response = await callers(
      { symbol: 'target.ts:target' },
      project,
      repoRoot,
    );
    const row = response.results.find((r) => r.file === 'callback-map.ts');
    expect(row?.enclosing).toBe('fn:processItems');
  });

  it('CallExpression callback: useEffect arrow resolves to outer named fn', async () => {
    const { project, repoRoot } = makeProject();
    const response = await callers(
      { symbol: 'target.ts:target' },
      project,
      repoRoot,
    );
    const row = response.results.find((r) => r.file === 'callback-useeffect.ts');
    expect(row?.enclosing).toBe('fn:MyComponent');
  });

  it('module-level export const arrow: resolves to fn:GET', async () => {
    const { project, repoRoot } = makeProject();
    const response = await callers(
      { symbol: 'target.ts:target' },
      project,
      repoRoot,
    );
    const row = response.results.find((r) => r.file === 'module-export-arrow.ts');
    expect(row?.enclosing).toBe('fn:GET');
  });

  it('module-level export function declaration: resolves to fn:POST', async () => {
    const { project, repoRoot } = makeProject();
    const response = await callers(
      { symbol: 'target.ts:target' },
      project,
      repoRoot,
    );
    const row = response.results.find((r) => r.file === 'module-export-fn-decl.ts');
    expect(row?.enclosing).toBe('fn:POST');
  });

  it('nested callbacks: bubbles up past .then/.map to outer named function', async () => {
    const { project, repoRoot } = makeProject();
    const response = await callers(
      { symbol: 'target.ts:target' },
      project,
      repoRoot,
    );
    const row = response.results.find((r) => r.file === 'nested-callbacks.ts');
    expect(row?.enclosing).toBe('fn:fetchAndProcess');
  });
});

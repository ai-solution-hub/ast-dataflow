import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { callers, createProject } from '@/lib/ast-dataflow';

const FIXTURE_DIR = resolve(
  __dirname,
  'fixtures',
  '01-callers',
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

  it('errors on malformed symbol identifier', async () => {
    const { project, repoRoot } = createProject({
      tsConfigFilePath: resolve(FIXTURE_DIR, 'tsconfig.json'),
      repoRoot: FIXTURE_DIR,
    });

    await expect(
      callers({ symbol: 'no-colon-here' }, project, repoRoot),
    ).rejects.toThrow(/Symbol must be/);
  });

  it('errors on unknown symbol in a known file', async () => {
    const { project, repoRoot } = createProject({
      tsConfigFilePath: resolve(FIXTURE_DIR, 'tsconfig.json'),
      repoRoot: FIXTURE_DIR,
    });

    await expect(
      callers(
        { symbol: 'target.ts:doesNotExist' },
        project,
        repoRoot,
      ),
    ).rejects.toThrow(/not found/);
  });
});

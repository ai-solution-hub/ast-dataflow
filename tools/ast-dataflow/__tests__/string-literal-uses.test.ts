import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringLiteralUses, createProject } from '@/lib/ast-dataflow';

/**
 * string-literal-uses query — Vitest suite
 *
 * Ground-truth fixture set under fixtures/12-string-literal-uses/.
 * Tests verify real behaviour per docs/reference/test-philosophy.md:
 *   - Assertions are on the result shape and counts (not call-chain internals).
 *   - toHaveLength pins exact counts; no toBeGreaterThanOrEqual(1) + find() antipattern.
 *   - expect.arrayContaining + expect.objectContaining for set-membership assertions.
 *   - Test titles read like product specs (what the user observes), not implementation.
 *
 * Row shape:
 *   { file, line, column, confidence, kind, enclosing }
 *   kind: 'viMock' | 'jsxProp' | 'sqlTag' | 'envKey' | 'argument'
 *   enclosing: string — nearest named function/method/class via findEnclosing
 */

const FIXTURE_DIR = resolve(__dirname, 'fixtures', '12-string-literal-uses');

function makeProject() {
  return createProject({
    tsConfigFilePath: resolve(FIXTURE_DIR, 'tsconfig.json'),
    repoRoot: FIXTURE_DIR,
  });
}

// ---------------------------------------------------------------------------
// Fixture 1: vi.mock() argument — kind 'viMock'
// ---------------------------------------------------------------------------
describe("string-literal-uses — fixture 1: vi.mock('@/lib/foo') argument", () => {
  it("returns exactly one viMock row for '@/lib/foo' in the vi-mock fixture", async () => {
    const { project, repoRoot } = makeProject();
    const response = await stringLiteralUses(
      { value: '@/lib/foo' },
      project,
      repoRoot,
    );

    expect(response.query).toBe('string-literal-uses');
    expect(response.error).toBeUndefined();

    const rows = response.results.filter(
      (r) => r.file === 'fixture-vi-mock.ts',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      file: 'fixture-vi-mock.ts',
      kind: 'viMock',
      confidence: 'exact',
    });
  });

  it("does not return a row for '@/lib/other' when searching for '@/lib/foo'", async () => {
    const { project, repoRoot } = makeProject();
    const response = await stringLiteralUses(
      { value: '@/lib/foo' },
      project,
      repoRoot,
    );

    // Exactly one result from the vi-mock fixture file — '@/lib/other' is excluded
    const rows = response.results.filter(
      (r) => r.file === 'fixture-vi-mock.ts',
    );
    expect(rows).toHaveLength(1);
    // The single row is for '@/lib/foo', not '@/lib/other'
    expect(rows[0]).toMatchObject({ kind: 'viMock', confidence: 'exact' });
  });
});

// ---------------------------------------------------------------------------
// Fixture 2: JSX prop value — kind 'jsxProp'
// ---------------------------------------------------------------------------
describe('string-literal-uses — fixture 2: JSX href prop value', () => {
  it("returns exactly one jsxProp row for 'https://example.com/page' in the JSX fixture", async () => {
    const { project, repoRoot } = makeProject();
    const response = await stringLiteralUses(
      { value: 'https://example.com/page' },
      project,
      repoRoot,
    );

    expect(response.query).toBe('string-literal-uses');
    expect(response.error).toBeUndefined();

    const rows = response.results.filter(
      (r) => r.file === 'fixture-jsx-prop.tsx',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      file: 'fixture-jsx-prop.tsx',
      kind: 'jsxProp',
      confidence: 'exact',
    });
  });

  it("does not return 'https://other.com' row when searching for 'https://example.com/page'", async () => {
    const { project, repoRoot } = makeProject();
    const response = await stringLiteralUses(
      { value: 'https://example.com/page' },
      project,
      repoRoot,
    );

    const rows = response.results.filter(
      (r) => r.file === 'fixture-jsx-prop.tsx',
    );
    // Only the matching href, not the non-matching one
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Fixture 3: sql tagged template — kind 'sqlTag'
// ---------------------------------------------------------------------------
describe('string-literal-uses — fixture 3: sql`` tagged template content', () => {
  it("returns exactly one sqlTag row for 'SELECT * FROM projects' in the sql fixture", async () => {
    const { project, repoRoot } = makeProject();
    const response = await stringLiteralUses(
      { value: 'SELECT * FROM projects' },
      project,
      repoRoot,
    );

    expect(response.query).toBe('string-literal-uses');
    expect(response.error).toBeUndefined();

    const rows = response.results.filter(
      (r) => r.file === 'fixture-sql-tag.ts',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      file: 'fixture-sql-tag.ts',
      kind: 'sqlTag',
      confidence: 'exact',
    });
  });

  it("does not return the 'SELECT id FROM users' row when searching for 'SELECT * FROM projects'", async () => {
    const { project, repoRoot } = makeProject();
    const response = await stringLiteralUses(
      { value: 'SELECT * FROM projects' },
      project,
      repoRoot,
    );

    const rows = response.results.filter(
      (r) => r.file === 'fixture-sql-tag.ts',
    );
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Fixture 4: process.env bracket key — kind 'envKey'
// ---------------------------------------------------------------------------
describe("string-literal-uses — fixture 4: process.env['MY_API_KEY'] bracket access", () => {
  it("returns the envKey row for 'MY_API_KEY' as a bracket-access key", async () => {
    const { project, repoRoot } = makeProject();
    const response = await stringLiteralUses(
      { value: 'MY_API_KEY' },
      project,
      repoRoot,
    );

    expect(response.query).toBe('string-literal-uses');
    expect(response.error).toBeUndefined();

    const rows = response.results.filter(
      (r) => r.file === 'fixture-env-key.ts',
    );
    // Two rows: one envKey (bracket access) and one argument (useKey call)
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'envKey', confidence: 'exact' }),
        expect.objectContaining({ kind: 'argument', confidence: 'exact' }),
      ]),
    );
  });

  it("does not return 'OTHER_KEY' when searching for 'MY_API_KEY'", async () => {
    const { project, repoRoot } = makeProject();
    const response = await stringLiteralUses(
      { value: 'MY_API_KEY' },
      project,
      repoRoot,
    );

    const rows = response.results.filter(
      (r) => r.file === 'fixture-env-key.ts',
    );
    // Neither row should be the OTHER_KEY access
    const otherKeyRows = rows.filter((r) => r.kind === 'envKey');
    // Only one envKey row (the MY_API_KEY one, not OTHER_KEY)
    expect(otherKeyRows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Fixture 5: plain argument literal — kind 'argument'
// ---------------------------------------------------------------------------
describe('string-literal-uses — fixture 5: plain call-expression argument literal', () => {
  it("returns two argument rows for 'project_id' in the argument fixture", async () => {
    const { project, repoRoot } = makeProject();
    const response = await stringLiteralUses(
      { value: 'project_id' },
      project,
      repoRoot,
    );

    expect(response.query).toBe('string-literal-uses');
    expect(response.error).toBeUndefined();

    const rows = response.results.filter(
      (r) => r.file === 'fixture-argument.ts',
    );
    // query('project_id') and filter('project_id', 'value') — two sites
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'argument', confidence: 'exact' }),
        expect.objectContaining({ kind: 'argument', confidence: 'exact' }),
      ]),
    );
  });

  it("does not return 'other_column' row when searching for 'project_id'", async () => {
    const { project, repoRoot } = makeProject();
    const response = await stringLiteralUses(
      { value: 'project_id' },
      project,
      repoRoot,
    );

    const rows = response.results.filter(
      (r) => r.file === 'fixture-argument.ts',
    );
    // Exactly 2 — not 3 (the 'other_column' literal is excluded)
    expect(rows).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Error contract: missing required --value argument
// ---------------------------------------------------------------------------
describe('string-literal-uses — error contract: missing value argument', () => {
  it('returns a parse_error structured response when value is empty string', async () => {
    const { project, repoRoot } = makeProject();
    const response = await stringLiteralUses({ value: '' }, project, repoRoot);

    expect(response.error).toBeDefined();
    expect(response.error?.kind).toBe('parse_error');
    expect(response.results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Result shape: confidence is always 'exact', enclosing is populated
// ---------------------------------------------------------------------------
describe('string-literal-uses — result shape invariants', () => {
  it("all rows have confidence 'exact' and a non-empty enclosing string", async () => {
    const { project, repoRoot } = makeProject();
    const response = await stringLiteralUses(
      { value: '@/lib/foo' },
      project,
      repoRoot,
    );

    expect(response.results).toHaveLength(1);
    for (const row of response.results) {
      expect(row.confidence).toBe('exact');
      expect(typeof row.enclosing).toBe('string');
      expect(row.enclosing.length).toBeGreaterThan(0);
    }
  });

  it('response envelope has query name, args, truncated flag, and durationMs', async () => {
    const { project, repoRoot } = makeProject();
    const response = await stringLiteralUses(
      { value: '@/lib/foo' },
      project,
      repoRoot,
    );

    expect(response.query).toBe('string-literal-uses');
    expect(response.args).toMatchObject({ value: '@/lib/foo' });
    expect(typeof response.truncated).toBe('boolean');
    expect(typeof response.durationMs).toBe('number');
  });
});

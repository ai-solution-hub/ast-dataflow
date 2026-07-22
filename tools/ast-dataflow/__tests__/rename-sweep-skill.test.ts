import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createProject,
  importers,
  references,
  stringLiteralUses,
} from '@/tools/ast-dataflow';

/**
 * Rename-sweep verifier — 3-query battery test
 *
 * Validates the skill workflow described in:
 *   .claude/skills/ast-dataflow/ast-dataflow-rename-sweep/SKILL.md
 *
 * Scenario: gitnexus_rename applied a TypeScript-symbol rename
 *   generateReport → generateChangeReport
 * with high-confidence graph edits. Two string-literal sites were
 * classified as "ast_search / review carefully" and missed by the executor.
 *
 * The rename-sweep battery (Q1 + Q2 + Q3) surfaces those misses.
 *
 * Fixture: tools/ast-dataflow/__tests__/fixtures/16-rename-sweep/
 *   post-rename-source.ts     — renamed module (generateChangeReport)
 *   consumer-renamed.ts       — correctly-updated consumer (no misses)
 *   test-with-missed-string.ts — test file with two unmissed string literals
 *
 * Tests follow docs/reference/testing/test-philosophy.md:
 *   - Assertions on result shape and counts (not internal call-chain).
 *   - toHaveLength pins exact counts; no toBeGreaterThanOrEqual(1) antipattern.
 *   - Test titles read like product specs (what the operator observes).
 */

const FIXTURE_DIR = resolve(__dirname, 'fixtures', '16-rename-sweep');

function makeProject() {
  return createProject({
    tsConfigFilePath: resolve(FIXTURE_DIR, 'tsconfig.json'),
    repoRoot: FIXTURE_DIR,
  });
}

// ---------------------------------------------------------------------------
// Q1 — string-literal-uses: unmissed vi.mock path site
// ---------------------------------------------------------------------------
describe('rename-sweep Q1 — string-literal-uses: old module path in vi.mock', () => {
  it('finds the vi.mock unmissed site referencing the old module path', async () => {
    const { project, repoRoot } = makeProject();
    const response = await stringLiteralUses(
      { value: '@/lib/reports/generate-report' },
      project,
      repoRoot,
    );

    expect(response.query).toBe('string-literal-uses');
    expect(response.error).toBeUndefined();

    const rows = response.results.filter(
      (r) => r.file === 'test-with-missed-string.ts',
    );
    // Exactly one unmissed site: the vi.mock('@/lib/reports/generate-report') call
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      file: 'test-with-missed-string.ts',
      kind: 'viMock',
      confidence: 'exact',
    });
  });

  it('reports no matches for the NEW module path (confirming path was not double-renamed)', async () => {
    const { project, repoRoot } = makeProject();
    const response = await stringLiteralUses(
      { value: '@/lib/reports/generate-change-report' },
      project,
      repoRoot,
    );

    expect(response.error).toBeUndefined();
    // No file in the fixture uses the new path as a string literal
    expect(response.results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Q1 — string-literal-uses: unmissed argument site (old function name as key)
// ---------------------------------------------------------------------------
describe('rename-sweep Q1 — string-literal-uses: old function name as string argument', () => {
  it('finds the registerMock argument site still using the old name as a string', async () => {
    const { project, repoRoot } = makeProject();
    const response = await stringLiteralUses(
      { value: 'generateReport' },
      project,
      repoRoot,
    );

    expect(response.query).toBe('string-literal-uses');
    expect(response.error).toBeUndefined();

    const rows = response.results.filter(
      (r) => r.file === 'test-with-missed-string.ts',
    );
    // One unmissed site: registerMock('generateReport', ...) call argument
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      file: 'test-with-missed-string.ts',
      kind: 'argument',
      confidence: 'exact',
    });
  });

  it('returns no results for old name in the correctly-renamed consumer', async () => {
    const { project, repoRoot } = makeProject();
    const response = await stringLiteralUses(
      { value: 'generateReport' },
      project,
      repoRoot,
    );

    const consumerRows = response.results.filter(
      (r) => r.file === 'consumer-renamed.ts',
    );
    // consumer-renamed.ts has no string literals containing the old name
    expect(consumerRows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Q2 — importers: old module path has no importers after rename
// ---------------------------------------------------------------------------
describe('rename-sweep Q2 — importers: no file imports the old module path', () => {
  it('returns zero importers for the old module path post-rename', async () => {
    const { project, repoRoot } = makeProject();
    // The old module path no longer exists in the fixture — importers returns an empty
    // result set with no error (the resolver treats missing modules as "no importers
    // found" rather than surfacing unknown_file, because no candidate matches).
    const response = await importers(
      { modulePath: 'pre-rename-source.ts' },
      project,
      repoRoot,
    );

    expect(response.error).toBeUndefined();
    expect(response.results).toHaveLength(0);
  });

  it('finds exactly two importers for the new module path', async () => {
    const { project, repoRoot } = makeProject();
    const response = await importers(
      { modulePath: 'post-rename-source.ts' },
      project,
      repoRoot,
    );

    expect(response.error).toBeUndefined();
    // consumer-renamed.ts and test-with-missed-string.ts both import post-rename-source.ts.
    const files = response.results.map((r) => r.file).sort();
    expect(files).toHaveLength(2);
    expect(files).toEqual([
      'consumer-renamed.ts',
      'test-with-missed-string.ts',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Q3 — references: new symbol has references; old symbol has none
// ---------------------------------------------------------------------------
describe('rename-sweep Q3 — references: generateChangeReport is referenced; generateReport is not', () => {
  it('finds references to generateChangeReport in both consumer and test fixture', async () => {
    const { project, repoRoot } = makeProject();
    const response = await references(
      { symbol: 'post-rename-source.ts:generateChangeReport' },
      project,
      repoRoot,
    );

    expect(response.query).toBe('references');
    expect(response.error).toBeUndefined();

    // Three fixture files contain references to the new symbol: the declaration
    // site (post-rename-source.ts) plus the two importing files. Importers each
    // reference the symbol twice; the declaration once → 5 total rows, 3 unique files.
    const referenceFiles = new Set(response.results.map((r) => r.file));
    expect(response.results).toHaveLength(5);
    expect(referenceFiles.size).toBe(3);
    expect(referenceFiles).toContain('post-rename-source.ts');
    expect(referenceFiles).toContain('consumer-renamed.ts');
    expect(referenceFiles).toContain('test-with-missed-string.ts');
  });

  it('all references to generateChangeReport have exact confidence', async () => {
    const { project, repoRoot } = makeProject();
    const response = await references(
      { symbol: 'post-rename-source.ts:generateChangeReport' },
      project,
      repoRoot,
    );

    expect(response.error).toBeUndefined();
    const nonExact = response.results.filter((r) => r.confidence !== 'exact');
    expect(nonExact).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Battery result: combined Q1+Q2+Q3 summary
// ---------------------------------------------------------------------------
describe('rename-sweep battery — combined result shape', () => {
  it('Q1 finds 2 total unmissed string-literal sites in test-with-missed-string.ts', async () => {
    const { project, repoRoot } = makeProject();

    // Run both Q1 passes: old module path + old function name
    const [pathResponse, nameResponse] = await Promise.all([
      stringLiteralUses(
        { value: '@/lib/reports/generate-report' },
        project,
        repoRoot,
      ),
      stringLiteralUses({ value: 'generateReport' }, project, repoRoot),
    ]);

    const pathHits = pathResponse.results.filter(
      (r) => r.file === 'test-with-missed-string.ts',
    );
    const nameHits = nameResponse.results.filter(
      (r) => r.file === 'test-with-missed-string.ts',
    );

    // Total unmissed sites: 2 (one vi.mock path, one argument key)
    expect(pathHits.length + nameHits.length).toBe(2);
  });
});

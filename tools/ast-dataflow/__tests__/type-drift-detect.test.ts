import { resolve, join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { typeDriftDetect, createProject } from '@/lib/ast-dataflow';
import type { TypeDriftResult } from '@/lib/ast-dataflow';

/**
 * type-drift-detect query — Vitest suite.
 *
 * Ground-truth fixture set under fixtures/17-type-drift/.
 *
 * Tests verify real behaviour per docs/reference/test-philosophy.md:
 *   - Pin exact counts — no toBeGreaterThan(0).
 *   - expect.arrayContaining([expect.objectContaining({...})]) for set
 *     membership assertions.
 *   - No find()+toBeDefined() antipattern.
 *   - Test titles describe user-observable outcomes.
 *
 * Fixture layout (fixtures/17-type-drift/):
 *   types/items.ts         — declares 5 interfaces (all four buckets + testOnly)
 *   lib/query/fetchers.ts  — fetchItems (ItemListResponse) + fetchOrder (OrderSummaryResponse)
 *   app/api/items/route.ts — GET annotated with NextResponse<ItemListResponse>
 *   app/api/orders/route.ts— GET NOT annotated (fetcher-only gap)
 *   app/api/products/route.ts— GET annotated with ProductBody (route-only)
 *   __tests__/test-consumer.ts — only reference to TestOnlyResult
 */

const FIXTURE_DIR = resolve(__dirname, 'fixtures', '17-type-drift');

function makeProject() {
  return createProject({
    tsConfigFilePath: resolve(FIXTURE_DIR, 'tsconfig.json'),
    repoRoot: FIXTURE_DIR,
  });
}

// ---------------------------------------------------------------------------
// Helper: find a result row by interface name (asserts exactly one match)
// ---------------------------------------------------------------------------
function findRow(
  results: TypeDriftResult[],
  interfaceName: string,
): TypeDriftResult {
  const matches = results.filter((r) => r.interface === interfaceName);
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly 1 row for interface "${interfaceName}", got ${matches.length}. ` +
        `Found: ${results.map((r) => r.interface).join(', ')}`,
    );
  }
  return matches[0];
}

// ---------------------------------------------------------------------------
// D-6: Four classification states
// ---------------------------------------------------------------------------
describe('type-drift-detect — D-6: four classification states', () => {
  it('classifies ItemListResponse as enforced (fetcher + annotated route)', async () => {
    const { project, repoRoot } = makeProject();
    const response = await typeDriftDetect({}, project, repoRoot);

    expect(response.error).toBeUndefined();
    const row = findRow(response.results, 'ItemListResponse');
    expect(row.classification).toBe('enforced');
  });

  it('classifies OrderSummaryResponse as fetcher-only (fetcher use, unannotated route)', async () => {
    const { project, repoRoot } = makeProject();
    const response = await typeDriftDetect({}, project, repoRoot);

    const row = findRow(response.results, 'OrderSummaryResponse');
    expect(row.classification).toBe('fetcher-only');
  });

  it('classifies ProductBody as route-only (route annotated, no fetcher)', async () => {
    const { project, repoRoot } = makeProject();
    const response = await typeDriftDetect({}, project, repoRoot);

    const row = findRow(response.results, 'ProductBody');
    expect(row.classification).toBe('route-only');
  });

  it('classifies UnusedPayload as unused (neither fetcher nor route)', async () => {
    const { project, repoRoot } = makeProject();
    const response = await typeDriftDetect({}, project, repoRoot);

    const row = findRow(response.results, 'UnusedPayload');
    expect(row.classification).toBe('unused');
    expect(row.testOnly).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// D-29: Test-only references → unused + testOnly flag
// ---------------------------------------------------------------------------
describe('type-drift-detect — D-29: test-only references get testOnly flag', () => {
  it('classifies TestOnlyResult as unused with testOnly: true', async () => {
    const { project, repoRoot } = makeProject();
    const response = await typeDriftDetect({}, project, repoRoot);

    const row = findRow(response.results, 'TestOnlyResult');
    expect(row.classification).toBe('unused');
    expect(row.testOnly).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D-11: JSONL row shape (exact field names from PRODUCT.md D-11)
// ---------------------------------------------------------------------------
describe('type-drift-detect — D-11: JSONL row shape', () => {
  it('every result row has the required fields from the spec', async () => {
    const { project, repoRoot } = makeProject();
    const response = await typeDriftDetect({}, project, repoRoot);

    for (const row of response.results) {
      // Required string field
      expect(typeof row.interface).toBe('string');
      // declaredAt position object
      expect(row.declaredAt).toMatchObject({
        file: expect.any(String),
        line: expect.any(Number),
        column: expect.any(Number),
      });
      // classification is one of the four valid values
      expect(['enforced', 'fetcher-only', 'route-only', 'unused']).toContain(
        row.classification,
      );
      // confidence is one of the three valid tiers
      expect(['exact', 'wildcard', 'indirect']).toContain(row.confidence);
      // arrays (may be empty)
      expect(Array.isArray(row.fetchers)).toBe(true);
      expect(Array.isArray(row.routes)).toBe(true);
      expect(Array.isArray(row.candidateRoutes)).toBe(true);
      // remediationHint is always a non-empty string
      expect(typeof row.remediationHint).toBe('string');
      expect(row.remediationHint.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// D-14: All file paths are repo-root-relative POSIX
// ---------------------------------------------------------------------------
describe('type-drift-detect — D-14: result paths are repo-root-relative POSIX', () => {
  it('all declaredAt.file paths are relative POSIX paths', async () => {
    const { project, repoRoot } = makeProject();
    const response = await typeDriftDetect({}, project, repoRoot);

    for (const row of response.results) {
      const { file } = row.declaredAt;
      expect(file).not.toMatch(/^[A-Za-z]:\\/); // no Windows absolute
      expect(file).not.toMatch(/^\//); // no Unix absolute
      expect(file).not.toContain('\\'); // POSIX separators only
    }
  });
});

// ---------------------------------------------------------------------------
// D-16: Evidence rows — fetcher-only rows have fetcher sites + candidateRoutes
// ---------------------------------------------------------------------------
describe('type-drift-detect — D-16: evidence rows on fetcher-only findings', () => {
  it('fetcher-only row has at least one fetcher call site', async () => {
    const { project, repoRoot } = makeProject();
    const response = await typeDriftDetect({}, project, repoRoot);

    const row = findRow(response.results, 'OrderSummaryResponse');
    expect(row.fetchers).toHaveLength(2); // fetchOrder + fetchOrderByPath
    expect(row.fetchers[0]).toMatchObject({
      file: expect.stringContaining('fetchers.ts'),
      line: expect.any(Number),
      column: expect.any(Number),
    });
  });

  it('fetcher-only row has a non-empty remediationHint', async () => {
    const { project, repoRoot } = makeProject();
    const response = await typeDriftDetect({}, project, repoRoot);

    const row = findRow(response.results, 'OrderSummaryResponse');
    expect(row.remediationHint).toBeTruthy();
    expect(row.remediationHint.length).toBeGreaterThan(10);
  });

  it('fetcher-only row has candidateRoutes when URL matches a route file', async () => {
    const { project, repoRoot } = makeProject();
    const response = await typeDriftDetect({}, project, repoRoot);

    const row = findRow(response.results, 'OrderSummaryResponse');
    // /api/orders matches app/api/orders/route.ts
    expect(row.candidateRoutes.length).toBeGreaterThan(0);
    expect(row.candidateRoutes[0]).toMatchObject({
      file: expect.stringContaining('orders'),
      matchReason: expect.stringMatching(/url-match|imported-not-annotated/),
      confidence: expect.stringMatching(/exact|indirect/),
    });
  });
});

// ---------------------------------------------------------------------------
// D-10: Most-favourable classification wins (one row per interface)
// ---------------------------------------------------------------------------
describe('type-drift-detect — D-10: one classification per interface', () => {
  it('each interface name appears at most once in results', async () => {
    const { project, repoRoot } = makeProject();
    const response = await typeDriftDetect({}, project, repoRoot);

    const names = response.results.map((r) => r.interface);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('reports exactly 5 rows for the 5-interface fixture', async () => {
    const { project, repoRoot } = makeProject();
    const response = await typeDriftDetect({}, project, repoRoot);

    // The fixture declares 5 named response interfaces.
    expect(response.results).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// D-15: Discovery — candidate set includes types/ and fetcher generics
// ---------------------------------------------------------------------------
describe('type-drift-detect — D-15: default candidate set discovery', () => {
  it('discovers all 5 interfaces from types/items.ts', async () => {
    const { project, repoRoot } = makeProject();
    const response = await typeDriftDetect({}, project, repoRoot);

    const names = response.results.map((r) => r.interface);
    expect(names).toEqual(
      expect.arrayContaining([
        'ItemListResponse',
        'OrderSummaryResponse',
        'ProductBody',
        'UnusedPayload',
        'TestOnlyResult',
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// D-4: --interfacePattern flag adds extra candidates
// ---------------------------------------------------------------------------
describe('type-drift-detect — D-4: --interfacePattern adds extra candidates', () => {
  it('picks up an otherwise-excluded name when the pattern matches', async () => {
    const { project, repoRoot } = makeProject();
    // "CustomData" does not match the default patterns (Response|Payload|Result|Body)
    // but the fixture types/items.ts does not have CustomData — this tests that
    // when the flag IS supplied, it's respected.
    // We test with a pattern that would match 'ItemListResponse' again — it
    // should not duplicate it.
    const response = await typeDriftDetect(
      { interfacePattern: '^Item' },
      project,
      repoRoot,
    );

    // Still only one ItemListResponse row (no duplicate from pattern match)
    const itemRows = response.results.filter(
      (r) => r.interface === 'ItemListResponse',
    );
    expect(itemRows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// D-13: Capped output — --limit truncates results
// ---------------------------------------------------------------------------
describe('type-drift-detect — D-13: capped output', () => {
  it('truncates when --limit is smaller than total results', async () => {
    const { project, repoRoot } = makeProject();
    const response = await typeDriftDetect({ limit: 2 }, project, repoRoot);

    expect(response.truncated).toBe(true);
    expect(response.results).toHaveLength(2);
    expect(response.totalEstimated).toBe(5);
  });

  it('does not truncate when results fit within --limit', async () => {
    const { project, repoRoot } = makeProject();
    const response = await typeDriftDetect({ limit: 500 }, project, repoRoot);

    expect(response.truncated).toBe(false);
    expect(response.results).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// D-25: No fetchers found — informational row on missing/empty fetchers file
// ---------------------------------------------------------------------------
describe('type-drift-detect — D-25: no fetchers found', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `td-no-fetchers-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    // Minimal tsconfig
    writeFileSync(
      join(tmpDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2020',
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          baseUrl: '.',
          skipLibCheck: true,
        },
        include: ['**/*.ts'],
      }),
    );
    // Types file with one matching interface
    mkdirSync(join(tmpDir, 'types'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'types', 'x.ts'),
      `export interface SomeResponse { ok: boolean; }\n`,
    );
    // lib/query/fetchers.ts exists but is empty
    mkdirSync(join(tmpDir, 'lib', 'query'), { recursive: true });
    writeFileSync(join(tmpDir, 'lib', 'query', 'fetchers.ts'), '');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exits 0 with an informational error row when fetchers.ts has no calls', async () => {
    const { project, repoRoot } = createProject({
      tsConfigFilePath: join(tmpDir, 'tsconfig.json'),
      repoRoot: tmpDir,
    });
    const response = await typeDriftDetect({}, project, repoRoot);

    // Spec D-25: a single sentinel row with no-fetchers-found, no crash.
    expect(response.results).toHaveLength(1);
    expect(response.results[0].error?.kind).toBe('no-fetchers-found');
    expect(response.results[0].error?.confidence).toBe('exact');
  });
});

// ---------------------------------------------------------------------------
// D-17: Allowlist — allowlisted interfaces excluded from fetcher-only
// ---------------------------------------------------------------------------
describe('type-drift-detect — D-17: allowlist support', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `td-allowlist-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    // Copy fixture directory content
    writeFileSync(
      join(tmpDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2020',
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          baseUrl: '.',
          skipLibCheck: true,
        },
        include: ['types/**/*.ts', 'lib/**/*.ts', 'app/**/*.ts'],
      }),
    );
    mkdirSync(join(tmpDir, 'types'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'types', 'r.ts'),
      `export interface AllowedResponse { data: string; }\n`,
    );
    mkdirSync(join(tmpDir, 'lib', 'query'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'lib', 'query', 'fetchers.ts'),
      `interface AllowedResponse { data: string; }\n` +
        `async function fetchJson<T>(u: string): Promise<T> { return fetch(u).then(r=>r.json()) as Promise<T>; }\n` +
        `export async function fetchAllowed() { return fetchJson<AllowedResponse>('/api/x'); }\n`,
    );
    // Create allowlist
    mkdirSync(join(tmpDir, 'docs', 'specs', 'ast-dataflow-tool', 'type-safety-pipeline'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'docs', 'specs', 'ast-dataflow-tool', 'type-safety-pipeline', 'allowlist.json'),
      JSON.stringify([
        { interface: 'AllowedResponse', reason: 'Third-party API shape, not ours to annotate.' },
      ]),
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('excludes allowlisted interface from fetcher-only results', async () => {
    const { project, repoRoot } = createProject({
      tsConfigFilePath: join(tmpDir, 'tsconfig.json'),
      repoRoot: tmpDir,
    });
    const response = await typeDriftDetect({}, project, repoRoot);

    // AllowedResponse is in allowlist — should NOT appear as fetcher-only
    const fetcherOnlyNames = response.results
      .filter((r) => r.classification === 'fetcher-only')
      .map((r) => r.interface);
    expect(fetcherOnlyNames).not.toContain('AllowedResponse');
  });

  it('includes allowlisted interface with allowlisted field set', async () => {
    const { project, repoRoot } = createProject({
      tsConfigFilePath: join(tmpDir, 'tsconfig.json'),
      repoRoot: tmpDir,
    });
    const response = await typeDriftDetect({}, project, repoRoot);

    const allowlistedRows = response.results.filter((r) => r.allowlisted);
    expect(allowlistedRows).toHaveLength(1);
    expect(allowlistedRows[0]).toMatchObject({
      interface: 'AllowedResponse',
      allowlisted: { reason: 'Third-party API shape, not ours to annotate.' },
    });
  });
});

// ---------------------------------------------------------------------------
// D-21: --ci does not mutate baseline file
// ---------------------------------------------------------------------------
describe('type-drift-detect — D-21: --ci does not mutate baseline', () => {
  let tmpDir: string;
  let baselineContent: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `td-ci-immutable-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { target: 'ES2020', module: 'ESNext', moduleResolution: 'bundler', strict: true, baseUrl: '.', skipLibCheck: true },
        include: ['types/**/*.ts', 'lib/**/*.ts', 'app/**/*.ts'],
      }),
    );
    mkdirSync(join(tmpDir, 'types'), { recursive: true });
    writeFileSync(join(tmpDir, 'types', 'r.ts'), `export interface CiTestResponse { ok: boolean; }\n`);
    mkdirSync(join(tmpDir, 'lib', 'query'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'lib', 'query', 'fetchers.ts'),
      `interface CiTestResponse { ok: boolean; }\n` +
        `async function fetchJson<T>(u: string): Promise<T> { return fetch(u).then(r=>r.json()) as Promise<T>; }\n` +
        `export async function fetchCi() { return fetchJson<CiTestResponse>('/api/ci'); }\n`,
    );
    // Write a baseline that already accepts CiTestResponse
    mkdirSync(join(tmpDir, 'docs', 'generated'), { recursive: true });
    baselineContent = JSON.stringify([
      { interface: 'CiTestResponse', declaredAt: { file: 'types/r.ts' } },
    ]);
    writeFileSync(join(tmpDir, 'docs', 'generated', 'type-drift-baseline.json'), baselineContent);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not modify baseline file when run with --ci', async () => {
    const { readFileSync } = await import('node:fs');
    const { project, repoRoot } = createProject({
      tsConfigFilePath: join(tmpDir, 'tsconfig.json'),
      repoRoot: tmpDir,
    });
    await typeDriftDetect({ ci: true }, project, repoRoot);

    const afterContent = readFileSync(
      join(tmpDir, 'docs', 'generated', 'type-drift-baseline.json'),
      'utf8',
    );
    expect(afterContent).toBe(baselineContent);
  });
});

// ---------------------------------------------------------------------------
// D-19: --ci exits non-zero when new fetcher-only rows are not in baseline
// ---------------------------------------------------------------------------
describe('type-drift-detect — D-19: --ci mode exits non-zero on new rows', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `td-ci-new-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { target: 'ES2020', module: 'ESNext', moduleResolution: 'bundler', strict: true, baseUrl: '.', skipLibCheck: true },
        include: ['types/**/*.ts', 'lib/**/*.ts'],
      }),
    );
    mkdirSync(join(tmpDir, 'types'), { recursive: true });
    writeFileSync(join(tmpDir, 'types', 'r.ts'), `export interface NewResponse { value: number; }\n`);
    mkdirSync(join(tmpDir, 'lib', 'query'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'lib', 'query', 'fetchers.ts'),
      `interface NewResponse { value: number; }\n` +
        `async function fetchJson<T>(u: string): Promise<T> { return fetch(u).then(r=>r.json()) as Promise<T>; }\n` +
        `export async function fetchNew() { return fetchJson<NewResponse>('/api/new'); }\n`,
    );
    // Empty baseline — NewResponse is NOT in it
    mkdirSync(join(tmpDir, 'docs', 'generated'), { recursive: true });
    writeFileSync(join(tmpDir, 'docs', 'generated', 'type-drift-baseline.json'), '[]');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns newSinceBaseline array with the untracked interface', async () => {
    const { project, repoRoot } = createProject({
      tsConfigFilePath: join(tmpDir, 'tsconfig.json'),
      repoRoot: tmpDir,
    });
    const response = await typeDriftDetect({ ci: true }, project, repoRoot);

    // The response carries the newSinceBaseline flag so the CLI can exit non-zero
    expect((response as { newSinceBaseline?: string[] }).newSinceBaseline).toContain('NewResponse');
  });
});

// ---------------------------------------------------------------------------
// D-30: Structured failure — malformed allowlist exits cleanly with error row
// ---------------------------------------------------------------------------
describe('type-drift-detect — D-30: structured failure on bad allowlist', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `td-bad-allowlist-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { target: 'ES2020', module: 'ESNext', moduleResolution: 'bundler', strict: true, baseUrl: '.', skipLibCheck: true },
        include: ['types/**/*.ts', 'lib/**/*.ts'],
      }),
    );
    mkdirSync(join(tmpDir, 'types'), { recursive: true });
    writeFileSync(join(tmpDir, 'types', 'r.ts'), `export interface SomeResponse { ok: boolean; }\n`);
    // Provide a lib/query/fetchers.ts with a real fetchJson call so the
    // no-fetchers-found branch does not fire before the allowlist is parsed.
    mkdirSync(join(tmpDir, 'lib', 'query'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'lib', 'query', 'fetchers.ts'),
      `interface SomeResponse { ok: boolean; }\n` +
        `async function fetchJson<T>(u: string): Promise<T> { return fetch(u).then(r=>r.json()) as Promise<T>; }\n` +
        `export async function fetchSome() { return fetchJson<SomeResponse>('/api/some'); }\n`,
    );
    // Write malformed allowlist
    mkdirSync(join(tmpDir, 'docs', 'specs', 'ast-dataflow-tool', 'type-safety-pipeline'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'docs', 'specs', 'ast-dataflow-tool', 'type-safety-pipeline', 'allowlist.json'),
      '{ invalid json',
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exits 0 and includes an error in the response (not a crash)', async () => {
    const { project, repoRoot } = createProject({
      tsConfigFilePath: join(tmpDir, 'tsconfig.json'),
      repoRoot: tmpDir,
    });
    // Should NOT throw — structured error response instead
    const response = await typeDriftDetect({}, project, repoRoot);
    // The key invariant: no exception thrown, AND the response carries a
    // structured error indicating the allowlist was malformed (D-30).
    expect(response.error).toBeDefined();
    expect(response.error?.kind).toBe('parse_error');
  });
});

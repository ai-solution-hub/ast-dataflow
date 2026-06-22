import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { columnWrites, createProject } from '@/tools/ast-dataflow';

const FIXTURE_DIR = resolve(__dirname, 'fixtures', '08-column-writes');

function makeProject() {
  return createProject({
    tsConfigFilePath: resolve(FIXTURE_DIR, 'tsconfig.json'),
    repoRoot: FIXTURE_DIR,
  });
}

// ---------------------------------------------------------------------------
// Typed client — .insert()
// ---------------------------------------------------------------------------
describe('column-writes query — typed .insert()', () => {
  it('finds single-row .insert({ project_id }) with exact confidence', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnWrites(
      { table: 'bid_questions', column: 'project_id' },
      project,
      repoRoot,
    );
    expect(response.query).toBe('column-writes');

    const hits = response.results.filter(
      (r) => r.file === 'typed-insert.ts' && r.method === 'insert',
    );
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]).toMatchObject({
      file: 'typed-insert.ts',
      method: 'insert',
      columnPath: 'project_id',
      table: 'bid_questions',
      isTyped: true,
      confidence: 'exact',
    });
  });

  it('finds array-form .insert([{ project_id }]) as an insert hit', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnWrites(
      { table: 'bid_questions', column: 'project_id' },
      project,
      repoRoot,
    );

    const hits = response.results.filter(
      (r) => r.file === 'typed-insert.ts' && r.method === 'insert',
    );
    // Both single-row and array-form inserts must be detected
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Typed client — .update() longhand + shorthand
// ---------------------------------------------------------------------------
describe('column-writes query — typed .update()', () => {
  it('finds .update({ project_id: value }) longhand with exact confidence', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnWrites(
      { table: 'bid_questions', column: 'project_id' },
      project,
      repoRoot,
    );

    const hits = response.results.filter(
      (r) => r.file === 'typed-update.ts' && r.method === 'update',
    );
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]).toMatchObject({
      file: 'typed-update.ts',
      method: 'update',
      columnPath: 'project_id',
      table: 'bid_questions',
      isTyped: true,
      confidence: 'exact',
    });
  });

  it('finds .update({ project_id }) shorthand as an update hit', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnWrites(
      { table: 'bid_questions', column: 'project_id' },
      project,
      repoRoot,
    );

    const hits = response.results.filter(
      (r) => r.file === 'typed-update.ts' && r.method === 'update',
    );
    // Both longhand and shorthand must be detected
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Typed client — .upsert()
// ---------------------------------------------------------------------------
describe('column-writes query — typed .upsert()', () => {
  it('finds single-row .upsert({ project_id }) with exact confidence', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnWrites(
      { table: 'bid_questions', column: 'project_id' },
      project,
      repoRoot,
    );

    const hits = response.results.filter(
      (r) => r.file === 'typed-upsert.ts' && r.method === 'upsert',
    );
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]).toMatchObject({
      file: 'typed-upsert.ts',
      method: 'upsert',
      columnPath: 'project_id',
      table: 'bid_questions',
      isTyped: true,
      confidence: 'exact',
    });
  });

  it('finds array-form .upsert([{ project_id }]) as an upsert hit', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnWrites(
      { table: 'bid_questions', column: 'project_id' },
      project,
      repoRoot,
    );

    const hits = response.results.filter(
      (r) => r.file === 'typed-upsert.ts' && r.method === 'upsert',
    );
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Typed client — .match() (longhand + shorthand)
// ---------------------------------------------------------------------------
describe('column-writes query — .match() as column reference site', () => {
  it('finds .match({ project_id: value }) longhand hit with method=match', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnWrites(
      { table: 'bid_questions', column: 'project_id' },
      project,
      repoRoot,
    );

    const hits = response.results.filter(
      (r) => r.file === 'match-object.ts' && r.method === 'match',
    );
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]).toMatchObject({
      file: 'match-object.ts',
      method: 'match',
      columnPath: 'project_id',
      table: 'bid_questions',
      isTyped: true,
      confidence: 'exact',
    });
  });

  it('finds .match({ project_id }) shorthand hit with method=match', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnWrites(
      { table: 'bid_questions', column: 'project_id' },
      project,
      repoRoot,
    );

    // Both longhand and shorthand must be detected
    const hits = response.results.filter(
      (r) => r.file === 'match-object.ts' && r.method === 'match',
    );
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Spread one-hop chase
// ---------------------------------------------------------------------------
describe('column-writes query — spread one-hop chase', () => {
  it('resolves local const payload with project_id to exact confidence', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnWrites(
      { table: 'bid_questions', column: 'project_id' },
      project,
      repoRoot,
    );

    // updateWithLocalSpread uses `const payload = { project_id: ... }` then
    // `.update(payload)` — tool should trace the one-hop reference.
    const exactHits = response.results.filter(
      (r) =>
        r.file === 'spread-one-hop.ts' &&
        r.method === 'update' &&
        r.confidence === 'exact',
    );
    expect(exactHits).toHaveLength(1);
    expect(exactHits[0]).toMatchObject({
      file: 'spread-one-hop.ts',
      method: 'update',
      columnPath: 'project_id',
      confidence: 'exact',
      isTyped: true,
    });
  });

  it('falls back to indirect confidence when spread source is a function parameter', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnWrites(
      { table: 'bid_questions', column: 'project_id' },
      project,
      repoRoot,
    );

    // updateWithParamSpread uses a parameter payload — cannot trace beyond one hop.
    const indirectHits = response.results.filter(
      (r) =>
        r.file === 'spread-one-hop.ts' &&
        r.method === 'update' &&
        r.confidence === 'indirect',
    );
    expect(indirectHits.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// False-positive guard
// ---------------------------------------------------------------------------
describe('column-writes query — false-positive guard', () => {
  it('suppresses hits from noise.ts (wrong table and wrong column)', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnWrites(
      { table: 'bid_questions', column: 'project_id' },
      project,
      repoRoot,
    );

    // Wrong table — other_table.insert({ project_id }) must not appear.
    // Wrong column — bid_questions.insert({ other_column }) must not appear.
    // Bare string literal — must not appear.
    const noiseHits = response.results.filter((r) => r.file === 'noise.ts');
    expect(noiseHits).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// excludeTests filter
// ---------------------------------------------------------------------------
describe('column-writes query — excludeTests filter', () => {
  it('returns results when excludeTests is false (default)', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnWrites(
      { table: 'bid_questions', column: 'project_id', excludeTests: false },
      project,
      repoRoot,
    );
    expect(response.results.length).toBeGreaterThan(0);
  });

  it('suppresses __tests__/** hits when excludeTests is true', async () => {
    const { project, repoRoot } = makeProject();
    // Inject a synthetic source file under a __tests__/ subpath of the
    // fixture project with a write chain against bid_questions.project_id.
    project.createSourceFile(
      resolve(FIXTURE_DIR, '__tests__', 'synthetic-test-file.ts'),
      `
import { createClient } from '../supabase-stub.js';
type Database = {
  public: { Tables: { bid_questions: { Row: { project_id: string } } } };
};
const sb = createClient<Database>('', '');
export function writeProjectId(procurementId: string) {
  return sb.from('bid_questions').insert({ project_id: procurementId });
}
`,
      { overwrite: true },
    );

    const without = await columnWrites(
      { table: 'bid_questions', column: 'project_id', excludeTests: false },
      project,
      repoRoot,
    );
    const withFlag = await columnWrites(
      { table: 'bid_questions', column: 'project_id', excludeTests: true },
      project,
      repoRoot,
    );

    const synthHitsWithout = without.results.filter((r) =>
      r.file.startsWith('__tests__/'),
    );
    const synthHitsWith = withFlag.results.filter((r) =>
      r.file.startsWith('__tests__/'),
    );

    expect(synthHitsWithout.length).toBeGreaterThanOrEqual(1);
    expect(synthHitsWith).toEqual([]);
    expect(withFlag.results.length).toBeLessThan(without.results.length);
  });
});

// ---------------------------------------------------------------------------
// Structured error
// ---------------------------------------------------------------------------
describe('column-writes query — structured error', () => {
  it('returns parse_error when table is empty', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnWrites(
      { table: '', column: 'project_id' },
      project,
      repoRoot,
    );
    expect(response.error?.kind).toBe('parse_error');
    expect(response.results).toEqual([]);
  });

  it('returns parse_error when column is empty', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnWrites(
      { table: 'bid_questions', column: '' },
      project,
      repoRoot,
    );
    expect(response.error?.kind).toBe('parse_error');
    expect(response.results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Metadata invariants
// ---------------------------------------------------------------------------
describe('column-writes query — metadata', () => {
  it('echoes table in every result row', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnWrites(
      { table: 'bid_questions', column: 'project_id' },
      project,
      repoRoot,
    );
    for (const row of response.results) {
      expect(row.table).toBe('bid_questions');
    }
  });

  it('records durationMs', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnWrites(
      { table: 'bid_questions', column: 'project_id' },
      project,
      repoRoot,
    );
    expect(response.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('sets line and column numbers on every result', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnWrites(
      { table: 'bid_questions', column: 'project_id' },
      project,
      repoRoot,
    );
    for (const row of response.results) {
      expect(row.line).toBeGreaterThanOrEqual(1);
      expect(row.column).toBeGreaterThanOrEqual(1);
    }
  });
});

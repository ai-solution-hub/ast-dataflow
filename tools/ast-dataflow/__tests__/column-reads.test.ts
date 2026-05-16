import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { columnReads, createProject } from '@/lib/ast-dataflow';

const FIXTURE_DIR = resolve(__dirname, 'fixtures', '07-column-reads');

function makeProject() {
  return createProject({
    tsConfigFilePath: resolve(FIXTURE_DIR, 'tsconfig.json'),
    repoRoot: FIXTURE_DIR,
  });
}

describe('column-reads query — typed client', () => {
  it('finds .select() hit with project_id in column list', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnReads(
      { table: 'bid_questions', column: 'project_id' },
      project,
      repoRoot,
    );
    expect(response.query).toBe('column-reads');

    const selectHits = response.results.filter(
      (r) => r.file === 'typed-client.ts' && r.method === 'select',
    );
    // typed-client.ts line 20: .select('project_id, question_text')
    expect(selectHits).toHaveLength(1);
    expect(selectHits[0]).toMatchObject({
      isTyped: true,
      confidence: 'exact',
      table: 'bid_questions',
      columnPath: 'project_id',
      method: 'select',
      line: 20,
    });
  });

  it('finds .eq() hit with project_id as column argument', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnReads(
      { table: 'bid_questions', column: 'project_id' },
      project,
      repoRoot,
    );

    const eqHits = response.results.filter(
      (r) => r.file === 'typed-client.ts' && r.method === 'eq',
    );
    // typed-client.ts line 25: .eq('project_id', bidId)
    expect(eqHits).toHaveLength(1);
    expect(eqHits[0]).toMatchObject({
      isTyped: true,
      confidence: 'exact',
      table: 'bid_questions',
      columnPath: 'project_id',
      method: 'eq',
      line: 25,
    });
  });
});

describe('column-reads query — untyped client', () => {
  it('finds .select() hit with confidence=indirect and isTyped=false', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnReads(
      { table: 'bid_questions', column: 'project_id' },
      project,
      repoRoot,
    );

    const selectHits = response.results.filter(
      (r) => r.file === 'untyped-client.ts' && r.method === 'select',
    );
    // untyped-client.ts line 10: .select('project_id, question_text')
    expect(selectHits).toHaveLength(1);
    expect(selectHits[0]).toMatchObject({
      isTyped: false,
      confidence: 'indirect',
      table: 'bid_questions',
      columnPath: 'project_id',
      method: 'select',
      line: 10,
    });
  });

  it('finds .eq() hit with confidence=indirect and isTyped=false', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnReads(
      { table: 'bid_questions', column: 'project_id' },
      project,
      repoRoot,
    );

    const eqHits = response.results.filter(
      (r) => r.file === 'untyped-client.ts' && r.method === 'eq',
    );
    // untyped-client.ts line 15: .eq('project_id', bidId)
    expect(eqHits).toHaveLength(1);
    expect(eqHits[0]).toMatchObject({
      isTyped: false,
      confidence: 'indirect',
      table: 'bid_questions',
      columnPath: 'project_id',
      method: 'eq',
      line: 15,
    });
  });
});

describe('column-reads query — match object', () => {
  it('finds .match({ project_id: value }) longhand hit with method=match', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnReads(
      { table: 'bid_questions', column: 'project_id' },
      project,
      repoRoot,
    );

    const matchHits = response.results.filter(
      (r) => r.file === 'match-object.ts' && r.method === 'match',
    );
    // match-object.ts has exactly 2 match rows: longhand (line 19) + shorthand (line 28)
    expect(matchHits).toHaveLength(2);
    const longhand = matchHits.find((r) => r.line === 19);
    expect(longhand).toMatchObject({
      isTyped: true,
      confidence: 'exact',
      columnPath: 'project_id',
      method: 'match',
      file: 'match-object.ts',
    });
  });

  it('finds .match({ project_id }) shorthand hit with method=match', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnReads(
      { table: 'bid_questions', column: 'project_id' },
      project,
      repoRoot,
    );

    const matchHits = response.results.filter(
      (r) => r.file === 'match-object.ts' && r.method === 'match',
    );
    // match-object.ts has exactly 2 match rows: longhand (line 19) + shorthand (line 28)
    expect(matchHits).toHaveLength(2);
    const shorthand = matchHits.find((r) => r.line === 28);
    expect(shorthand).toMatchObject({
      columnPath: 'project_id',
      method: 'match',
      file: 'match-object.ts',
    });
  });

  it('matches Supabase colon-alias select(pid:project_id) as a project_id read', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnReads(
      { table: 'bid_questions', column: 'project_id' },
      project,
      repoRoot,
    );

    // match-object.ts line 39: .select('pid:project_id, question_text') — alias read
    const aliasHits = response.results.filter(
      (r) => r.file === 'match-object.ts' && r.method === 'select',
    );
    expect(aliasHits).toHaveLength(1);
    expect(aliasHits[0]).toMatchObject({
      columnPath: 'project_id',
      method: 'select',
      line: 39,
    });
  });
});

describe('column-reads query — false-positive guard', () => {
  it('suppresses hits from noise.ts (wrong table, wrong column, bare string)', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnReads(
      { table: 'bid_questions', column: 'project_id' },
      project,
      repoRoot,
    );

    const noiseHits = response.results.filter((r) => r.file === 'noise.ts');
    expect(noiseHits).toHaveLength(0);
  });
});

describe('column-reads query — excludeTests filter', () => {
  it('returns results when excludeTests is false (default)', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnReads(
      { table: 'bid_questions', column: 'project_id', excludeTests: false },
      project,
      repoRoot,
    );
    // Fixture has 8 rows across typed-client.ts (2), untyped-client.ts (2), match-object.ts (4)
    expect(response.results).toHaveLength(8);
    const files = response.results.map((r) => r.file);
    expect(files).toContain('typed-client.ts');
    expect(files).toContain('untyped-client.ts');
    expect(files).toContain('match-object.ts');
  });

  it('suppresses __tests__/** hits when excludeTests is true', async () => {
    const { project, repoRoot } = makeProject();
    // Inject a synthetic source file under a __tests__/ subpath of the
    // fixture project. The file uses the typed Supabase stub from the
    // fixture and contains a .select('project_id') call against bid_questions.
    project.createSourceFile(
      resolve(FIXTURE_DIR, '__tests__', 'synthetic-test-file.ts'),
      `
import { createClient } from '../supabase-stub.js';
type Database = {
  public: { Tables: { bid_questions: { Row: { project_id: string } } } };
};
const sb = createClient<Database>('', '');
export function readProjectId() {
  return sb.from('bid_questions').select('project_id').eq('project_id', 'x');
}
`,
      { overwrite: true },
    );

    const without = await columnReads(
      { table: 'bid_questions', column: 'project_id', excludeTests: false },
      project,
      repoRoot,
    );
    const withFlag = await columnReads(
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

describe('column-reads query — structured error', () => {
  it('returns parse_error when table is empty', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnReads(
      { table: '', column: 'project_id' },
      project,
      repoRoot,
    );
    expect(response.error?.kind).toBe('parse_error');
    expect(response.results).toEqual([]);
  });

  it('returns parse_error when column is empty', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnReads(
      { table: 'bid_questions', column: '' },
      project,
      repoRoot,
    );
    expect(response.error?.kind).toBe('parse_error');
    expect(response.results).toEqual([]);
  });
});

describe('column-reads query — wildcard select', () => {
  it('detects .select("*") as a wildcard row with confidence="wildcard" and columnPath="*"', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnReads(
      { table: 'bid_questions', column: 'project_id' },
      project,
      repoRoot,
    );

    const wildcardHits = response.results.filter(
      (r) => r.file === 'wildcard-select.ts' && r.method === 'select',
    );
    expect(wildcardHits).toHaveLength(1);
    expect(wildcardHits[0]).toMatchObject({
      confidence: 'wildcard',
      columnPath: '*',
      table: 'bid_questions',
      isTyped: true,
    });
  });

  it('does not emit wildcard rows for files with only explicit column selects', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnReads(
      { table: 'bid_questions', column: 'project_id' },
      project,
      repoRoot,
    );

    // typed-client.ts only has .select('project_id, question_text') — no wildcards
    const typedWildcardHits = response.results.filter(
      (r) => r.file === 'typed-client.ts' && r.confidence === 'wildcard',
    );
    expect(typedWildcardHits).toHaveLength(0);
  });
});

describe('column-reads query — metadata', () => {
  it('echoes table in every result row', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnReads(
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
    const response = await columnReads(
      { table: 'bid_questions', column: 'project_id' },
      project,
      repoRoot,
    );
    expect(response.durationMs).toEqual(expect.any(Number));
  });
});

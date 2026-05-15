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
    expect(selectHits.length).toBeGreaterThanOrEqual(1);
    expect(selectHits[0].isTyped).toBe(true);
    expect(selectHits[0].confidence).toBe('exact');
    expect(selectHits[0].table).toBe('bid_questions');
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
    expect(eqHits.length).toBeGreaterThanOrEqual(1);
    expect(eqHits[0].isTyped).toBe(true);
    expect(eqHits[0].confidence).toBe('exact');
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
    expect(selectHits.length).toBeGreaterThanOrEqual(1);
    expect(selectHits[0].isTyped).toBe(false);
    expect(selectHits[0].confidence).toBe('indirect');
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
    expect(eqHits.length).toBeGreaterThanOrEqual(1);
    expect(eqHits[0].isTyped).toBe(false);
    expect(eqHits[0].confidence).toBe('indirect');
  });
});

describe('column-reads query — match object', () => {
  it('finds .match({ project_id }) hit with method=match', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnReads(
      { table: 'bid_questions', column: 'project_id' },
      project,
      repoRoot,
    );

    const matchHits = response.results.filter(
      (r) => r.file === 'match-object.ts' && r.method === 'match',
    );
    expect(matchHits.length).toBeGreaterThanOrEqual(1);
    expect(matchHits[0].isTyped).toBe(true);
    expect(matchHits[0].confidence).toBe('exact');
    expect(matchHits[0].columnPath).toBe('project_id');
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
    expect(response.results.length).toBeGreaterThan(0);
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
    expect(response.durationMs).toBeGreaterThanOrEqual(0);
  });
});

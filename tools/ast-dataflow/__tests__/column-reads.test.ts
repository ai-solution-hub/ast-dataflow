import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { columnReads, createProject } from '@/tools/ast-dataflow';

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
    // typed-client.ts line 25: .eq('project_id', procurementId)
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
    // untyped-client.ts line 15: .eq('project_id', procurementId)
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

describe('column-reads query — typed-detection guards', () => {
  it('reports a hand-rolled structural builder as isTyped=false / indirect', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnReads(
      { table: 'bid_questions', column: 'project_id' },
      project,
      repoRoot,
    );

    // untyped-structural-client.ts: one chain — select + eq, both at line 27.
    // The old heuristic's branch 1-b claimed exact from the structural
    // return-type text.
    const hits = response.results.filter(
      (r) => r.file === 'untyped-structural-client.ts',
    );
    expect(hits).toHaveLength(2);
    expect(hits.map((r) => r.method).sort()).toEqual(['eq', 'select']);
    for (const hit of hits) {
      expect(hit).toMatchObject({
        isTyped: false,
        confidence: 'indirect',
        table: 'bid_questions',
        columnPath: 'project_id',
        line: 27,
      });
    }
  });

  it('reports a bare SupabaseClient parameter as isTyped=false / indirect', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnReads(
      { table: 'bid_questions', column: 'project_id' },
      project,
      repoRoot,
    );

    // untyped-param-client.ts: select at line 13, eq at line 18. The stub's
    // builder generics still echo the table name — the old branch 1-a false
    // positive.
    const hits = response.results.filter(
      (r) => r.file === 'untyped-param-client.ts',
    );
    expect(hits).toHaveLength(2);
    expect(hits.map((r) => r.method).sort()).toEqual(['eq', 'select']);
    for (const hit of hits) {
      expect(hit).toMatchObject({
        isTyped: false,
        confidence: 'indirect',
        table: 'bid_questions',
        columnPath: 'project_id',
      });
    }
  });

  it('resolves a SupabaseClient<Database> parameter to isTyped=true / exact across the function boundary', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnReads(
      { table: 'bid_questions', column: 'project_id' },
      project,
      repoRoot,
    );

    // typed-param-client.ts: strategy 2 cannot see a parameter binding —
    // strategy 1 resolves the Relation's Row shape from the .from() return type.
    const hits = response.results.filter(
      (r) => r.file === 'typed-param-client.ts',
    );
    expect(hits).toHaveLength(2);
    expect(hits.map((r) => r.method).sort()).toEqual(['eq', 'select']);
    for (const hit of hits) {
      expect(hit).toMatchObject({
        isTyped: true,
        confidence: 'exact',
        table: 'bid_questions',
        columnPath: 'project_id',
      });
    }
  });

  it('keeps the untyped stub client indirect despite the table-name echo in its builder generics', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnReads(
      { table: 'bid_questions', column: 'project_id' },
      project,
      repoRoot,
    );

    // Regression guard: the stub mirrors supabase-js in echoing the table-name
    // literal into the untyped builder's type arguments — text matching on the
    // return type would flip these back to exact.
    const hits = response.results.filter((r) => r.file === 'untyped-client.ts');
    expect(hits).toHaveLength(2);
    for (const hit of hits) {
      expect(hit).toMatchObject({ isTyped: false, confidence: 'indirect' });
    }
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

    // match-object.ts line 36: .select('pid:project_id, question_text') — alias read
    const aliasHits = response.results.filter(
      (r) => r.file === 'match-object.ts' && r.method === 'select',
    );
    expect(aliasHits).toHaveLength(1);
    expect(aliasHits[0]).toMatchObject({
      columnPath: 'project_id',
      method: 'select',
      line: 36,
    });
  });
});

describe('column-reads query — .from(CONST) table-name resolution', () => {
  it('resolves a literal-typed const table argument to exact rows', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnReads(
      { table: 'bid_questions', column: 'project_id' },
      project,
      repoRoot,
    );

    // const-table-read.ts line 35: .from(BID_QUESTIONS_TABLE) chain — the
    // const's type is the string-literal 'bid_questions'.
    const hits = response.results.filter(
      (r) => r.file === 'const-table-read.ts' && r.line === 35,
    );
    expect(hits).toHaveLength(2);
    expect(hits.map((r) => r.method).sort()).toEqual(['eq', 'select']);
    for (const hit of hits) {
      expect(hit).toMatchObject({
        isTyped: true,
        confidence: 'exact',
        table: 'bid_questions',
        columnPath: 'project_id',
      });
    }
  });

  it('resolves an as-const map property table argument to an exact row', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnReads(
      { table: 'bid_questions', column: 'project_id' },
      project,
      repoRoot,
    );

    // const-table-read.ts line 44: .from(TABLES.bid_questions) chain — the
    // `as const` map property's type is the string-literal 'bid_questions'.
    const hits = response.results.filter(
      (r) => r.file === 'const-table-read.ts' && r.line === 44,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      isTyped: true,
      confidence: 'exact',
      table: 'bid_questions',
      columnPath: 'project_id',
      method: 'select',
    });
  });

  it('excludes widened-string and union-of-literals table arguments as unattributable', async () => {
    const { project, repoRoot } = makeProject();
    const response = await columnReads(
      { table: 'bid_questions', column: 'project_id' },
      project,
      repoRoot,
    );

    // Only the two resolvable chains produce rows — the widened-string map
    // property, `string` parameter, and union-ternary decoys contribute none.
    const hits = response.results.filter(
      (r) => r.file === 'const-table-read.ts',
    );
    expect(hits).toHaveLength(3);
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
    // Fixture has 18 rows: typed-client.ts (2), untyped-client.ts (2),
    // match-object.ts (4), wildcard-select.ts (1),
    // untyped-structural-client.ts (2), untyped-param-client.ts (2),
    // typed-param-client.ts (2), const-table-read.ts (3)
    expect(response.results).toHaveLength(18);
    const files = response.results.map((r) => r.file);
    expect(files).toContain('typed-client.ts');
    expect(files).toContain('const-table-read.ts');
    expect(files).toContain('untyped-client.ts');
    expect(files).toContain('match-object.ts');
    expect(files).toContain('wildcard-select.ts');
    expect(files).toContain('untyped-structural-client.ts');
    expect(files).toContain('untyped-param-client.ts');
    expect(files).toContain('typed-param-client.ts');
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

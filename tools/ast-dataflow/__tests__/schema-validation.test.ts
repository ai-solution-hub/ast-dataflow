/**
 * G3 — schema-addressed queries must be loud about arguments that do not
 * exist.
 *
 * Before this, `column-reads` and `column-writes` answered an unknown table or
 * a misspelled column with a silent `[]`, while `schema-coverage` — same
 * binary, same generated types — reported `unknown_table` with a hint. The two
 * answers are now built from one enumeration (tools/ast-dataflow/schema.ts).
 *
 * The column-writes case is the sharper one: every row it emits is stamped
 * with the requested column name, so a nonexistent column used to come back
 * as rows attributing writes to a column that is not in the schema.
 */
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { columnReads, columnWrites, createProject } from '@/tools/ast-dataflow';
import { dispatch } from '@/tools/ast-dataflow/dispatch';
import { loadSchema, lookupTableColumn } from '@/tools/ast-dataflow/schema';

const READS_FIXTURE = resolve(__dirname, 'fixtures', '07-column-reads');
const WRITES_FIXTURE = resolve(__dirname, 'fixtures', '08-column-writes');
const NO_SCHEMA_FIXTURE = resolve(__dirname, 'fixtures', '06-references');

function projectAt(fixtureDir: string) {
  return createProject({
    tsConfigFilePath: resolve(fixtureDir, 'tsconfig.json'),
    repoRoot: fixtureDir,
  });
}

describe('schema enumeration', () => {
  it('parses the generated types the fixture ships', () => {
    const schema = loadSchema(READS_FIXTURE);
    expect(schema.available).toBe(true);
    if (!schema.available) return;
    expect([...schema.tables.keys()].sort()).toEqual([
      'bid_projects',
      'survey_questions',
    ]);
    expect(schema.tables.get('survey_questions')).toEqual([
      'created_at',
      'id',
      'project_id',
      'question_text',
    ]);
  });

  it('reads Row only — Insert-only columns are not part of the Row shape', () => {
    // insert_only_decoy exists in the fixture's Insert block. Row is the
    // contract these queries address, so the decoy must not be accepted.
    const outcome = lookupTableColumn(
      READS_FIXTURE,
      'survey_questions',
      'insert_only_decoy',
    );
    expect(outcome.failure?.kind).toBe('unknown_column');
  });

  it('reports the generated types as unavailable in a repo without them', () => {
    const schema = loadSchema(NO_SCHEMA_FIXTURE);
    expect(schema.available).toBe(false);
    if (schema.available) return;
    expect(schema.kind).toBe('unknown_file');
    expect(schema.message).toContain('supabase/types/database.types.ts');
  });
});

describe('column-reads — unknown table / column', () => {
  it('rejects an unknown table with unknown_table and a hint, not a silent zero', async () => {
    const { project, repoRoot } = projectAt(READS_FIXTURE);
    const response = await columnReads(
      { table: 'survey_question', column: 'project_id' },
      project,
      repoRoot,
    );

    expect(response.error?.kind).toBe('unknown_table');
    expect(response.error?.message).toContain("Table 'survey_question'");
    expect(response.error?.message).toContain('2 tables');
    // The near-miss is the whole point of the hint for a typo.
    expect(response.error?.hint).toContain('survey_questions');
    expect(response.results).toEqual([]);
  });

  it('rejects an unknown column on a real table with unknown_column and the known columns', async () => {
    const { project, repoRoot } = projectAt(READS_FIXTURE);
    const response = await columnReads(
      { table: 'survey_questions', column: 'projectid' },
      project,
      repoRoot,
    );

    expect(response.error?.kind).toBe('unknown_column');
    expect(response.error?.message).toContain("Column 'projectid'");
    expect(response.error?.hint).toContain('project_id');
    expect(response.results).toEqual([]);
  });

  it('no longer answers an unknown column with honest-looking wildcard rows', async () => {
    // Previously a bogus column on a real table came back as
    // `columnPath: '*', confidence: 'wildcard'` rows from the fixture's
    // .select('*') site — truthful about the wildcard, silent about the fact
    // that the column does not exist at all.
    const { project, repoRoot } = projectAt(READS_FIXTURE);
    const response = await columnReads(
      { table: 'survey_questions', column: 'no_such_column' },
      project,
      repoRoot,
    );
    expect(response.results).toEqual([]);
    expect(response.error?.kind).toBe('unknown_column');
  });

  it('still answers a real table and column normally', async () => {
    const { project, repoRoot } = projectAt(READS_FIXTURE);
    const response = await columnReads(
      { table: 'survey_questions', column: 'project_id' },
      project,
      repoRoot,
    );
    expect(response.error).toBeUndefined();
    expect(response.results.length).toBeGreaterThan(0);
  });
});

describe('column-writes — unknown table / column', () => {
  it('rejects an unknown table with unknown_table', async () => {
    const { project, repoRoot } = projectAt(WRITES_FIXTURE);
    const response = await columnWrites(
      { table: 'survey_quesions', column: 'project_id' },
      project,
      repoRoot,
    );

    expect(response.error?.kind).toBe('unknown_table');
    expect(response.error?.hint).toContain('survey_questions');
    expect(response.results).toEqual([]);
  });

  it('never emits rows stamped with a column name that is not in the schema', async () => {
    // The fabrication this fixes: column-writes stamps every row with
    // `columnPath: args.column`, and its indirect paths (spread-carried and
    // untraceable payloads) emit a row without ever confirming the key. A
    // nonexistent column therefore produced rows asserting a write to a
    // column the schema has never had.
    const { project, repoRoot } = projectAt(WRITES_FIXTURE);
    const response = await columnWrites(
      { table: 'survey_questions', column: 'ghost_column' },
      project,
      repoRoot,
    );

    expect(response.error?.kind).toBe('unknown_column');
    expect(response.results).toEqual([]);
    const stamped = response.results.map((r) => r.columnPath);
    expect(stamped).not.toContain('ghost_column');
  });

  it('still answers a real table and column normally', async () => {
    const { project, repoRoot } = projectAt(WRITES_FIXTURE);
    const response = await columnWrites(
      { table: 'survey_questions', column: 'project_id' },
      project,
      repoRoot,
    );
    expect(response.error).toBeUndefined();
    expect(response.results.length).toBeGreaterThan(0);
  });
});

describe('column queries agree with schema-coverage on the same repo', () => {
  it('all three report unknown_table for the same bogus table', async () => {
    const fixture = resolve(__dirname, 'fixtures', '21-schema-coverage');
    const { project, repoRoot } = projectAt(fixture);

    const kinds = await Promise.all(
      (['column-reads', 'column-writes', 'schema-coverage'] as const).map(
        async (query) => {
          const response = await dispatch(
            query,
            { table: 'bid_project', column: 'id' },
            project,
            repoRoot,
          );
          return response.error?.kind;
        },
      ),
    );

    expect(kinds).toEqual(['unknown_table', 'unknown_table', 'unknown_table']);
  });

  it('all three report unknown_column for the same bogus column', async () => {
    const fixture = resolve(__dirname, 'fixtures', '21-schema-coverage');
    const { project, repoRoot } = projectAt(fixture);

    const kinds = await Promise.all(
      (['column-reads', 'column-writes', 'schema-coverage'] as const).map(
        async (query) => {
          const response = await dispatch(
            query,
            { table: 'bid_projects', column: 'nope' },
            project,
            repoRoot,
          );
          return response.error?.kind;
        },
      ),
    );

    expect(kinds).toEqual([
      'unknown_column',
      'unknown_column',
      'unknown_column',
    ]);
  });
});

describe('column queries without generated types', () => {
  it('run the walk instead of failing, and disclose that nothing was validated', async () => {
    const { project, repoRoot } = projectAt(NO_SCHEMA_FIXTURE);
    const response = await dispatch(
      'column-writes',
      { table: 'anything_at_all', column: 'whatever' },
      project,
      repoRoot,
    );

    // Refusing to run outside a Supabase repo would make the tool useless on
    // every other repo; skipping the check silently is what G3 fixes.
    expect(response.error).toBeUndefined();
    expect(response.caveats?.schemaValidation?.validated).toBe(false);
    expect(response.caveats?.schemaValidation?.reason).toContain(
      'Cannot read supabase/types/database.types.ts',
    );
  });
});

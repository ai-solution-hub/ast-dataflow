// Fixture: false-positive guard.
// None of these calls should appear in column-writes for table='bid_questions',
// column='project_id':
//   1. .from('other_table').insert({ project_id }) — wrong table, suppress.
//   2. .from('bid_questions').insert({ other_column: 'x' }) — wrong column, suppress.
//   3. Bare string literal 'project_id' — not in a Supabase write chain, suppress.
//   4. .from('bid_questions').update({ project_id }) — correct table + column,
//      but intentionally in this noise file to confirm the guard reads per-file.
//      Wait — that would produce a hit. Exclude that pattern from noise.
import { createClient } from './supabase-stub.js';

type Database = {
  public: {
    Tables: {
      bid_questions: { Row: { project_id: string; other_column: string } };
      other_table: { Row: { project_id: string } };
    };
  };
};

const sb = createClient<Database>('https://example.supabase.co', 'anon-key');

// Wrong table — should NOT be returned.
async function insertWrongTable(projectId: string) {
  const { data } = await sb
    .from('other_table')
    .insert({ project_id: projectId })
    .single();
  return data;
}

// Wrong column — should NOT be returned.
async function insertWrongColumn() {
  const { data } = await sb
    .from('bid_questions')
    .insert({ other_column: 'value' })
    .single();
  return data;
}

// Bare string literal — not a Supabase write chain, should NOT be returned.
const projectIdKey = 'project_id';

export { insertWrongTable, insertWrongColumn, projectIdKey };

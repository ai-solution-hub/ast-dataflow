// Fixture: false-positive guard.
// Neither call should appear in column-reads for table='bid_questions', column='project_id':
//   1. .from('other_table').select('project_id') — wrong table, suppress.
//   2. .from('bid_questions').select('other_column') — wrong column, suppress.
//   3. Bare string 'project_id' in a variable — not a Supabase chain, suppress.
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
async function wrongTable() {
  const result = await sb
    .from('other_table')
    .select('project_id')
    .single();
  return result;
}

// Wrong column — should NOT be returned.
async function wrongColumn() {
  const result = await sb
    .from('bid_questions')
    .select('other_column')
    .single();
  return result;
}

// Bare string literal — not a Supabase chain, should NOT be returned.
const projectIdKey = 'project_id';

export { wrongTable, wrongColumn, projectIdKey };

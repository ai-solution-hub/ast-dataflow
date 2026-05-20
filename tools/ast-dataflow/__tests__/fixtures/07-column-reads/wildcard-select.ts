// Fixture: typed Supabase client with .select('*') — wildcard confidence tier.
// Expected column-reads hits for table='bid_questions', column='project_id':
//   Line 21 — .select('*')  method='select'  columnPath='*'  isTyped=true  confidence='wildcard'
// The .select('*') call returns all columns including project_id; the tool
// cannot know which specific columns are returned, so it reports confidence='wildcard'.
import { createClient } from './supabase-stub.js';

type Database = {
  public: {
    Tables: {
      bid_questions: {
        Row: { project_id: string; question_text: string; id: string };
      };
    };
  };
};

const sb = createClient<Database>('https://example.supabase.co', 'anon-key');

async function fetchAllQuestions(procurementId: string) {
  const { data } = await sb
    .from('bid_questions')
    .select('*')
    .eq('id', procurementId)
    .single();

  return data;
}

export { fetchAllQuestions };

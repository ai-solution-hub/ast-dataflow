// Fixture: typed Supabase client (.from('bid_questions') with Database generic).
// Expected column-reads hits for table='bid_questions', column='project_id':
//   Line 15 — .select('project_id, question_text')  method='select'  isTyped=true  confidence='exact'
//   Line 19 — .eq('project_id', '123')               method='eq'      isTyped=true  confidence='exact'
import { createClient } from './supabase-stub.js';

type Database = {
  public: {
    Tables: {
      bid_questions: {
        Row: { project_id: string; question_text: string };
      };
    };
  };
};

const sb = createClient<Database>('https://example.supabase.co', 'anon-key');

async function fetchQuestions(procurementId: string) {
  const { data: bySelect } = await sb
    .from('bid_questions')
    .select('project_id, question_text')
    .single();

  const { data: byEq } = await sb
    .from('bid_questions')
    .select('question_text')
    .eq('project_id', procurementId)
    .single();

  return { bySelect, byEq };
}

export { fetchQuestions };

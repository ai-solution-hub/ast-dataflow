// Fixture: typed Supabase client (.from('survey_questions') with Database generic).
// Expected column-reads hits for table='survey_questions', column='project_id':
//   Line 15 — .select('project_id, question_text')  method='select'  isTyped=true  confidence='exact'
//   Line 19 — .eq('project_id', '123')               method='eq'      isTyped=true  confidence='exact'
import { createClient } from './supabase-stub.js';

type Database = {
  public: {
    Tables: {
      survey_questions: {
        Row: { project_id: string; question_text: string };
      };
    };
  };
};

const sb = createClient<Database>('https://example.supabase.co', 'anon-key');

async function fetchQuestions(projectId: string) {
  const { data: bySelect } = await sb
    .from('survey_questions')
    .select('project_id, question_text')
    .single();

  const { data: byEq } = await sb
    .from('survey_questions')
    .select('question_text')
    .eq('project_id', projectId)
    .single();

  return { bySelect, byEq };
}

export { fetchQuestions };

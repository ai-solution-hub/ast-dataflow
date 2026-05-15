// Fixture: .match({ project_id: value }) — object-literal method.
// Expected column-reads hits for table='bid_questions', column='project_id':
//   Line 11 — .match({ project_id: '789' })  method='match'  isTyped=true  confidence='exact'
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

async function fetchByMatch(projectId: string) {
  const result = await sb
    .from('bid_questions')
    .match({ project_id: projectId })
    .single();
  return result;
}

export { fetchByMatch };

// Fixture: typed Supabase client — .update() with project_id property.
// Expected column-writes hits for table='bid_questions', column='project_id':
//   Line 22 — .update({ project_id: newId, status: 'active' })  method='update'  isTyped=true  confidence='exact'
import { createClient } from './supabase-stub.js';

type Database = {
  public: {
    Tables: {
      bid_questions: {
        Row: {
          project_id: string;
          question_text: string;
          id: string;
          status: string;
        };
      };
    };
  };
};

const sb = createClient<Database>('https://example.supabase.co', 'anon-key');

// Update reassigning project_id — longhand property
async function reassignQuestion(questionId: string, newProjectId: string) {
  const { data } = await sb
    .from('bid_questions')
    .update({ project_id: newProjectId, status: 'active' })
    .eq('id', questionId)
    .single();
  return data;
}

// Update using shorthand property assignment
async function reassignQuestionShorthand(
  questionId: string,
  project_id: string,
) {
  const { data } = await sb
    .from('bid_questions')
    .update({ project_id })
    .eq('id', questionId)
    .single();
  return data;
}

export { reassignQuestion, reassignQuestionShorthand };

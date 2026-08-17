// Fixture: typed Supabase client — .match() with project_id property.
// .match() is a filter/WHERE clause; it is treated as a column reference site
// (not a mutation). The query reports it with method='match'.
//
// Expected column-writes hits for table='survey_questions', column='project_id':
//   Line 23 — .match({ project_id: projectId })  method='match'  isTyped=true  confidence='exact'  (longhand)
//   Line 31 — .match({ project_id })  method='match'  isTyped=true  confidence='exact'  (shorthand)
import { createClient } from './supabase-stub.js';

type Database = {
  public: {
    Tables: {
      survey_questions: {
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

// Longhand match — { project_id: value }
async function updateByProject(projectId: string) {
  const { data } = await sb
    .from('survey_questions')
    .update({ status: 'archived' })
    .match({ project_id: projectId })
    .single();
  return data;
}

// Shorthand match — { project_id } (ES2015+ shorthand)
async function archiveByProject(project_id: string) {
  const { data } = await sb
    .from('survey_questions')
    .update({ status: 'archived' })
    .match({ project_id })
    .single();
  return data;
}

export { updateByProject, archiveByProject };

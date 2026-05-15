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

// Shorthand-property syntax: `{ project_id }` — equivalent to `{ project_id: project_id }`.
async function fetchByMatchShorthand(project_id: string) {
  const result = await sb
    .from('bid_questions')
    .match({ project_id })
    .single();
  return result;
}

// Colon-alias select: `'pid:project_id'` reads the project_id column and
// aliases it as `pid` in the result. The column-reads query should match
// this as a project_id read.
async function fetchWithColumnAlias(projectId: string) {
  const result = await sb
    .from('bid_questions')
    .select('pid:project_id, question_text')
    .eq('project_id', projectId);
  return result;
}

export { fetchByMatch, fetchByMatchShorthand, fetchWithColumnAlias };

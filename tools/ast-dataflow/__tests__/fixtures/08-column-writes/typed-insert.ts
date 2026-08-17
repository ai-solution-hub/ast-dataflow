// Fixture: typed Supabase client — .insert() with project_id property.
// Expected column-writes hits for table='survey_questions', column='project_id':
//   Line 22 — .insert({ project_id: projectId, ... })  method='insert'  isTyped=true  confidence='exact'
//   Line 30 — .insert([{ project_id: projectId, ... }]) method='insert'  isTyped=true  confidence='exact'
import { createClient } from './supabase-stub.js';

type Database = {
  public: {
    Tables: {
      survey_questions: {
        Row: {
          project_id: string;
          question_text: string;
          id: string;
        };
      };
    };
  };
};

const sb = createClient<Database>('https://example.supabase.co', 'anon-key');

// Single-row insert — longhand property
async function insertSingleQuestion(projectId: string, text: string) {
  const { data } = await sb
    .from('survey_questions')
    .insert({ project_id: projectId, question_text: text })
    .select('id')
    .single();
  return data;
}

// Array insert — single row in array form
async function insertArrayQuestion(projectId: string, text: string) {
  const { data } = await sb
    .from('survey_questions')
    .insert([{ project_id: projectId, question_text: text }])
    .select('id')
    .single();
  return data;
}

export { insertSingleQuestion, insertArrayQuestion };

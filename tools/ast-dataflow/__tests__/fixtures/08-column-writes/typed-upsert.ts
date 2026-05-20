// Fixture: typed Supabase client — .upsert() with project_id property.
// Expected column-writes hits for table='bid_questions', column='project_id':
//   Line 22 — .upsert({ project_id: procurementId, ... })  method='upsert'  isTyped=true  confidence='exact'
//   Line 30 — .upsert([{ project_id: procurementId, ... }])  method='upsert'  isTyped=true  confidence='exact'
import { createClient } from './supabase-stub.js';

type Database = {
  public: {
    Tables: {
      bid_questions: {
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

// Single-row upsert — longhand property
async function upsertQuestion(procurementId: string, text: string) {
  const { data } = await sb
    .from('bid_questions')
    .upsert({ project_id: procurementId, question_text: text }, { onConflict: 'id' })
    .select('id')
    .single();
  return data;
}

// Array upsert — single row in array form
async function upsertArrayQuestion(procurementId: string, text: string) {
  const { data } = await sb
    .from('bid_questions')
    .upsert([{ project_id: procurementId, question_text: text }], { onConflict: 'id' })
    .select('id')
    .single();
  return data;
}

export { upsertQuestion, upsertArrayQuestion };

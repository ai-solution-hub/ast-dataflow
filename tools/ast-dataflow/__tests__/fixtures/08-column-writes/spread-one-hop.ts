// Fixture: spread-one-hop — local const with project_id key, then spread into
// .update(payload). The query follows the reference ONE hop to the declaration.
//
// Expected column-writes hits for table='bid_questions', column='project_id':
//   Scenario A (typed update with resolved spread):
//     the payload variable declared two lines above contains project_id — exact.
//
// Scenario B (spread source is a parameter — cannot trace, indirect):
//     the payload parameter comes from the caller, tool cannot inspect it.
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

// Scenario A: spread source is a local const — one-hop traceable.
// Expected: method='update', confidence='exact' (traced project_id from payload decl).
async function updateWithLocalSpread(questionId: string, newProjectId: string) {
  const payload = { project_id: newProjectId, question_text: 'updated' };
  const { data } = await sb
    .from('bid_questions')
    .update(payload)
    .eq('id', questionId)
    .single();
  return data;
}

// Scenario B: spread source is a function parameter — beyond one hop.
// Expected: method='update', confidence='indirect' (cannot trace the param).
async function updateWithParamSpread(questionId: string, payload: { project_id: string }) {
  const { data } = await sb
    .from('bid_questions')
    .update(payload)
    .eq('id', questionId)
    .single();
  return data;
}

export { updateWithLocalSpread, updateWithParamSpread };

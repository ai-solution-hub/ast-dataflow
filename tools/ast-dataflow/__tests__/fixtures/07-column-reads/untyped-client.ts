// Fixture: untyped Supabase client (no Database generic parameter).
// Expected column-reads hits for table='bid_questions', column='project_id':
//   Line 10 — .select('project_id, question_text')  method='select'  isTyped=false  confidence='indirect'
//   Line 14 — .eq('project_id', '456')              method='eq'      isTyped=false  confidence='indirect'
import { createClient } from './supabase-stub.js';

const sb = createClient('https://example.supabase.co', 'anon-key');

async function fetchQuestionsUntyped(bidId: string) {
  const { data: bySelect } = await sb
    .from('bid_questions')
    .select('project_id, question_text')
    .single();

  const { data: byEq } = await sb
    .from('bid_questions')
    .select('question_text')
    .eq('project_id', bidId)
    .single();

  return { bySelect, byEq };
}

export { fetchQuestionsUntyped };

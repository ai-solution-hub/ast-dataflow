// Fixture: client received as a bare `SupabaseClient` parameter (no Database
// generic) — the schema-derived builder generics degrade to `any` while the
// table-name literal is still echoed into them (old branch 1-a fired on the echo).
// Expected column-reads hits for table='bid_questions', column='project_id':
//   Line 13 — .select('project_id, question_text')  method='select'  isTyped=false  confidence='indirect'
//   Line 18 — .eq('project_id', procurementId)      method='eq'      isTyped=false  confidence='indirect'
import { type SupabaseClient } from './supabase-stub.js';

async function fetchViaBareParam(
  client: SupabaseClient,
  procurementId: string,
) {
  const { data: bySelect } = await client
    .from('bid_questions')
    .select('project_id, question_text')
    .single();

  const { data: byEq } = await client
    .from('bid_questions')
    .select('question_text')
    .eq('project_id', procurementId)
    .single();

  return { bySelect, byEq };
}

export { fetchViaBareParam };

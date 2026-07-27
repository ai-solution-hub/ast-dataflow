// Fixture: client received as a `SupabaseClient<Database>` parameter —
// strategy 2 cannot see a parameter binding, but strategy 1 resolves the
// Relation type argument's concrete Row shape across the function boundary.
// Expected column-reads hits for table='bid_questions', column='project_id':
//   Line 23 — .select('project_id, question_text')  method='select'  isTyped=true  confidence='exact'
//   Line 28 — .eq('project_id', procurementId)      method='eq'      isTyped=true  confidence='exact'
import { type SupabaseClient } from './supabase-stub.js';

type Database = {
  public: {
    Tables: {
      bid_questions: {
        Row: { project_id: string; question_text: string };
      };
    };
  };
};

async function fetchViaTypedParam(
  client: SupabaseClient<Database>,
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

export { fetchViaTypedParam };

// Fixture: one-hop .from(CONST) table-name resolution — writes.
// Expected column-writes hits for table='bid_questions', column='project_id':
//   updateViaLiteralConst — .from(BID_QUESTIONS_TABLE).update({ project_id })  method='update'  isTyped=true  confidence='exact'
//   upsertViaTableMap     — .from(TABLES.bid_questions).upsert({ project_id }) method='upsert'  isTyped=true  confidence='exact'
// Decoy that must NOT match: a widened-`string` parameter table argument.
import { createClient } from './supabase-stub.js';

type Database = {
  public: {
    Tables: {
      bid_questions: { Row: { project_id: string; question_text: string } };
    };
  };
};

const BID_QUESTIONS_TABLE = 'bid_questions';

const TABLES = {
  bid_questions: 'bid_questions',
} as const;

const sb = createClient<Database>('https://example.supabase.co', 'anon-key');

// Untyped client for the decoy — a typed client would reject a widened
// `string` table argument at compile time.
const sbUntyped = createClient('https://example.supabase.co', 'anon-key');

async function updateViaLiteralConst(procurementId: string) {
  const { data } = await sb
    .from(BID_QUESTIONS_TABLE)
    .update({ project_id: procurementId })
    .single();
  return data;
}

async function upsertViaTableMap(procurementId: string) {
  const { data } = await sb
    .from(TABLES.bid_questions)
    .upsert({ project_id: procurementId })
    .single();
  return data;
}

async function insertViaStringParam(tableName: string, procurementId: string) {
  const { data } = await sbUntyped
    .from(tableName)
    .insert({ project_id: procurementId })
    .single();
  return data;
}

export { updateViaLiteralConst, upsertViaTableMap, insertViaStringParam };

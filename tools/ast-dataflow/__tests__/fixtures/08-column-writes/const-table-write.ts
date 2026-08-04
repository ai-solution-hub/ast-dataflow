// Fixture: one-hop .from(CONST) table-name resolution — writes.
// Expected column-writes hits for table='survey_questions', column='project_id':
//   updateViaLiteralConst — .from(SURVEY_QUESTIONS_TABLE).update({ project_id })  method='update'  isTyped=true  confidence='exact'
//   upsertViaTableMap     — .from(TABLES.survey_questions).upsert({ project_id }) method='upsert'  isTyped=true  confidence='exact'
// Decoy that must NOT match: a widened-`string` parameter table argument.
import { createClient } from './supabase-stub.js';

type Database = {
  public: {
    Tables: {
      survey_questions: { Row: { project_id: string; question_text: string } };
    };
  };
};

const SURVEY_QUESTIONS_TABLE = 'survey_questions';

const TABLES = {
  survey_questions: 'survey_questions',
} as const;

const sb = createClient<Database>('https://example.supabase.co', 'anon-key');

// Untyped client for the decoy — a typed client would reject a widened
// `string` table argument at compile time.
const sbUntyped = createClient('https://example.supabase.co', 'anon-key');

async function updateViaLiteralConst(procurementId: string) {
  const { data } = await sb
    .from(SURVEY_QUESTIONS_TABLE)
    .update({ project_id: procurementId })
    .single();
  return data;
}

async function upsertViaTableMap(procurementId: string) {
  const { data } = await sb
    .from(TABLES.survey_questions)
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

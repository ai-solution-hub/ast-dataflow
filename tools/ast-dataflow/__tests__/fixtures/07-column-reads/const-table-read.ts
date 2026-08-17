// Fixture: one-hop .from(CONST) table-name resolution — reads.
// Expected column-reads hits for table='survey_questions', column='project_id':
//   readViaLiteralConst — .from(SURVEY_QUESTIONS_TABLE) chain: select + eq rows  isTyped=true  confidence='exact'
//   readViaTableMap     — .from(TABLES.survey_questions) chain: select row       isTyped=true  confidence='exact'
// Decoys that must NOT match: a widened-`string` map property, a `string`
// parameter, and a union-of-literals ternary (ambiguous).
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

// No `as const` — the property type widens to `string`, so it must NOT resolve.
const WIDENED_TABLES = {
  survey_questions: 'survey_questions',
};

const sb = createClient<Database>('https://example.supabase.co', 'anon-key');

// Untyped client for the decoys — a typed client would reject a widened
// `string` table argument at compile time.
const sbUntyped = createClient('https://example.supabase.co', 'anon-key');

async function readViaLiteralConst(projectId: string) {
  const { data } = await sb
    .from(SURVEY_QUESTIONS_TABLE)
    .select('project_id, question_text')
    .eq('project_id', projectId)
    .single();
  return data;
}

async function readViaTableMap() {
  const { data } = await sb
    .from(TABLES.survey_questions)
    .select('project_id')
    .single();
  return data;
}

async function readViaWidenedMapProperty() {
  const { data } = await sbUntyped
    .from(WIDENED_TABLES.survey_questions)
    .select('project_id')
    .single();
  return data;
}

async function readViaStringParam(tableName: string) {
  const { data } = await sbUntyped
    .from(tableName)
    .select('project_id')
    .single();
  return data;
}

async function readViaUnionTernary(useOther: boolean) {
  const table = useOther ? 'other_table' : 'survey_questions';
  const { data } = await sbUntyped.from(table).select('project_id').single();
  return data;
}

export {
  readViaLiteralConst,
  readViaTableMap,
  readViaWidenedMapProperty,
  readViaStringParam,
  readViaUnionTernary,
};

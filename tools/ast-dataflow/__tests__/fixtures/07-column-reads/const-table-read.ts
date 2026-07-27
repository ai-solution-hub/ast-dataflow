// Fixture: one-hop .from(CONST) table-name resolution — reads.
// Expected column-reads hits for table='bid_questions', column='project_id':
//   readViaLiteralConst — .from(BID_QUESTIONS_TABLE) chain: select + eq rows  isTyped=true  confidence='exact'
//   readViaTableMap     — .from(TABLES.bid_questions) chain: select row       isTyped=true  confidence='exact'
// Decoys that must NOT match: a widened-`string` map property, a `string`
// parameter, and a union-of-literals ternary (ambiguous).
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

// No `as const` — the property type widens to `string`, so it must NOT resolve.
const WIDENED_TABLES = {
  bid_questions: 'bid_questions',
};

const sb = createClient<Database>('https://example.supabase.co', 'anon-key');

// Untyped client for the decoys — a typed client would reject a widened
// `string` table argument at compile time.
const sbUntyped = createClient('https://example.supabase.co', 'anon-key');

async function readViaLiteralConst(procurementId: string) {
  const { data } = await sb
    .from(BID_QUESTIONS_TABLE)
    .select('project_id, question_text')
    .eq('project_id', procurementId)
    .single();
  return data;
}

async function readViaTableMap() {
  const { data } = await sb
    .from(TABLES.bid_questions)
    .select('project_id')
    .single();
  return data;
}

async function readViaWidenedMapProperty() {
  const { data } = await sbUntyped
    .from(WIDENED_TABLES.bid_questions)
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
  const table = useOther ? 'other_table' : 'bid_questions';
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

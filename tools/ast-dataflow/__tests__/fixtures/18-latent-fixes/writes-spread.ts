// Fixture: spread-carried write payloads that the pre-fix inspector missed.
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

// Spread payload with NO explicit project_id key — the spread source may
// carry the column, so this must be reported (indirect), not skipped.
export async function updateViaSpread(payload: Record<string, unknown>) {
  await sb
    .from('bid_questions')
    .update({ ...payload, question_text: 'x' })
    .eq('id', '1');
}

// Array insert whose element is an identifier — cannot be ruled out.
export async function insertViaIdentifierElement(
  row: Database['public']['Tables']['bid_questions']['Row'],
) {
  await sb.from('bid_questions').insert([row]);
}

// Fully-literal object WITHOUT the key and WITHOUT spread — provably absent,
// must NOT be reported.
export async function updateOtherColumnOnly() {
  await sb.from('bid_questions').update({ question_text: 'y' }).eq('id', '2');
}

// One-hop identifier resolving to a literal WITHOUT the key or spread —
// provably absent, must NOT be reported.
export async function updateViaLocalWithoutKey() {
  const payload = { question_text: 'z' };
  await sb.from('bid_questions').update(payload).eq('id', '3');
}

// Read-chain coverage: .order() and .in() name the column.
export async function readOrderAndIn(ids: string[]) {
  await sb
    .from('bid_questions')
    .select('id')
    .in('project_id', ids)
    .order('project_id');
}

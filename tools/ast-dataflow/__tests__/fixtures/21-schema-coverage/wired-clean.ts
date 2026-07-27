// Fixture: clean typed access on bid_projects — no wildcard, no untyped
// client, no dynamic `.from()` smoke, so the untouched budget_gbp column must
// stay 'unwired'. Expected schema-coverage evidence:
//   id         — select+eq exact reads (chain at line 29) + insert exact
//                write (chain at line 38) → wired
//   title      — select exact read (line 29) only  → read-only
//   owner_id   — insert exact write (line 38) only → write-only
//   budget_gbp — zero rows, zero table smoke       → unwired
import { createClient } from './supabase-stub.js';

type Database = {
  public: {
    Tables: {
      bid_projects: {
        Row: {
          id: string;
          title: string;
          owner_id: string;
          budget_gbp: number | null;
        };
      };
    };
  };
};

const sb = createClient<Database>('https://example.supabase.co', 'anon-key');

export async function readProjects(projectId: string) {
  const { data } = await sb
    .from('bid_projects')
    .select('id, title')
    .eq('id', projectId)
    .single();
  return data;
}

export async function createBidProject(newId: string, ownerId: string) {
  const { data } = await sb
    .from('bid_projects')
    .insert({ id: newId, owner_id: ownerId })
    .single();
  return data;
}

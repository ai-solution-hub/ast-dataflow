// Fixture: apiCall sink (Supabase chain terminal method)
// origin: const payload (line 14)
// hop 2: .insert(payload) — apiCall hop at terminal mutating call, NOT at .from()
// OQ-FT2 LOCK: emit at terminal mutating method (.insert), not at chain root (.from)

interface SupabaseClient {
  from(table: string): {
    insert(payload: unknown): Promise<{ data: unknown; error: unknown }>;
  };
}

export async function processApiCall(supabase: SupabaseClient) {
  const payload = { id: 1, name: 'test' };
  await supabase.from('items').insert(payload);
  // apiCall hop emitted at .insert(), not at .from()
}

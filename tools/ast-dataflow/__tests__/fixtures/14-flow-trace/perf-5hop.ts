/**
 * Performance fixture: 5-hop synthetic chain.
 * Simulates a realistic Supabase payload flow:
 *   raw → validated → enriched → formatted → final → .insert(final)
 *
 * Used by performance.test.ts to validate the 10-second P95 budget (P-19).
 */

interface SupabaseClient {
  from(table: string): { insert(data: unknown): Promise<unknown> };
}
declare const supabase: SupabaseClient;

export function submitBid(raw: Record<string, unknown>) {
  const validated = raw;
  const enriched = validated;
  const formatted = enriched;
  const final = formatted;
  return supabase.from('bids').insert(final);
}

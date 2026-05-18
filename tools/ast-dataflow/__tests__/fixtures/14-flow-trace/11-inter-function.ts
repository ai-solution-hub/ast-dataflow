/**
 * Fixture 11: Inter-function descent.
 *
 * A value flows from an origin declaration, through a function argument call
 * site, then descends into the callee's parameter, and finally to an apiCall
 * sink (Supabase .insert()).
 *
 * Trace (with interFunction: true):
 *   hop 1 — origin (payload), kind: assignment
 *   hop 2 — argument at saveToDb(payload) call site, kind: argument
 *   hop 3 — parameter (data) in saveToDb, kind: argument (callee's param)
 *   hop 4 — .insert(data) in saveToDb, kind: apiCall
 *
 * OQ-FT3 LOCK: enclosing on hop 3 and hop 4 is the callee's enclosing
 * function (saveToDb), NOT the upstream caller (processData).
 */

// Minimal Supabase client type stub for type-checker resolution.
interface SupabaseClient {
  from(table: string): { insert(data: unknown): Promise<unknown> };
}

declare const supabase: SupabaseClient;

export function saveToDb(data: Record<string, unknown>) {
  return supabase.from('items').insert(data);
}

export function processData(raw: Record<string, unknown>) {
  const payload = raw;
  saveToDb(payload);
}

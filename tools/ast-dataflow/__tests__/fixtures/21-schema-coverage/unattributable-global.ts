// Fixture: a widened-`string` dynamic `.from()` site — unattributable to ANY
// table even via its type. It must surface as a per-file count in
// caveats.unattributableSites and must NOT poison per-column verdicts
// (bid_projects.budget_gbp stays 'unwired' despite this file existing).
import { createClient } from './supabase-stub.js';

const sbUntyped = createClient('https://example.supabase.co', 'anon-key');

export async function touchAnyTable(tableName: string) {
  const { data } = await sbUntyped.from(tableName).select('*');
  return data;
}

// Decoy: `Array.from(...)` is a `.from()` call too — its non-string-typed
// argument must NOT be counted as an unattributable table site.
export function decoyArrayFrom(values: readonly number[]) {
  return Array.from(values);
}

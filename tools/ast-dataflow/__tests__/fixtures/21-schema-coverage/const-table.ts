// Fixture: signup_policy — one-hop `.from(CONST)` attribution plus a dynamic
// `.from(fn())` site. SIGNUP_POLICY_TABLE resolves via its string-literal
// type, so allowed_domain is provably wired (the baseline audit's false
// negative). policyTable() is a CallExpression the one-hop resolver never
// follows — no rows — but its return TYPE bounds the smoke to signup_policy:
// the table's untouched columns (id, enforced, updated_at) must report
// 'undecidable', never 'unwired'.
import { createClient } from './supabase-stub.js';

type Database = {
  public: {
    Tables: {
      signup_policy: {
        Row: {
          id: string;
          allowed_domain: string;
          enforced: boolean;
          updated_at: string;
        };
      };
    };
  };
};

const SIGNUP_POLICY_TABLE = 'signup_policy';

const sb = createClient<Database>('https://example.supabase.co', 'anon-key');

// Untyped client for the dynamic site — keeps the chain compiling without
// widening games on the typed builder.
const sbUntyped = createClient('https://example.supabase.co', 'anon-key');

function policyTable(): 'signup_policy' {
  return 'signup_policy';
}

export async function readAllowedDomains() {
  const { data } = await sb
    .from(SIGNUP_POLICY_TABLE)
    .select('allowed_domain')
    .single();
  return data;
}

export async function upsertAllowedDomain(domain: string) {
  const { data } = await sb
    .from(SIGNUP_POLICY_TABLE)
    .upsert({ allowed_domain: domain })
    .single();
  return data;
}

// The .select('enforced') here must contribute NO rows — the site is
// unattributable, so it is smoke only.
export async function touchPolicyDynamically() {
  const { data } = await sbUntyped.from(policyTable()).select('enforced');
  return data;
}

// Fixture: feed_articles — a `.select('*')` poisons every column of the
// table with wildcard reads, and an untyped update contributes an indirect
// write. Wildcard/indirect must NEVER count as wiring evidence.
// Expected schema-coverage verdicts:
//   headline          — select exact read + table wildcard      → read-only
//   extraction_method — insert exact write + table wildcard     → write-only
//   retention_class   — wildcard read + indirect (untyped) write → undecidable
//   id                — wildcard read only                       → undecidable
import { createClient } from './supabase-stub.js';

type Database = {
  public: {
    Tables: {
      feed_articles: {
        Row: {
          id: string;
          headline: string;
          retention_class: string;
          extraction_method: string;
        };
      };
    };
  };
};

const sb = createClient<Database>('https://example.supabase.co', 'anon-key');

// Untyped client — its rows must stay 'indirect'.
const sbUntyped = createClient('https://example.supabase.co', 'anon-key');

export async function listArticles() {
  const { data } = await sb.from('feed_articles').select('*');
  return data;
}

export async function readHeadline() {
  const { data } = await sb.from('feed_articles').select('headline').single();
  return data;
}

export async function recordExtraction(method: string) {
  const { data } = await sb
    .from('feed_articles')
    .insert({ extraction_method: method })
    .single();
  return data;
}

export async function tagRetention(value: string) {
  const { data } = await sbUntyped
    .from('feed_articles')
    .update({ retention_class: value })
    .single();
  return data;
}

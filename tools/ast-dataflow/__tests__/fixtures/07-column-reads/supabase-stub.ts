// Minimal Supabase client stub for fixture use — no real @supabase/supabase-js needed.
// The column-reads query detects typed-vs-untyped by checking whether createClient
// is called with a Database type parameter at the call site.

export interface SupabaseClient<DB = unknown> {
  from<T extends string>(
    table: T,
  ): QueryBuilder<
    DB extends { public: { Tables: Record<T, { Row: infer R }> } }
      ? R
      : Record<string, unknown>
  >;
  rpc(
    fn: string,
    payload: Record<string, unknown>,
  ): Promise<{ data: unknown; error: unknown }>;
}

export interface QueryBuilder<Row> {
  select(columns: string): QueryBuilder<Row>;
  eq(column: string, value: unknown): QueryBuilder<Row>;
  match(query: Record<string, unknown>): QueryBuilder<Row>;
  order(column: string, opts?: { ascending?: boolean }): QueryBuilder<Row>;
  single(): Promise<{ data: Row | null; error: unknown }>;
  then(resolve: (v: { data: Row[] | null; error: unknown }) => void): void;
}

export function createClient<DB = unknown>(
  _url: string,
  _key: string,
): SupabaseClient<DB> {
  throw new Error('stub — not callable at runtime');
}

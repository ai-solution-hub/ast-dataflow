// Minimal Supabase client stub for column-writes fixture use.
// The column-writes query detects typed-vs-untyped by checking whether
// createClient is called with a Database type parameter at the call site.

export interface SupabaseClient<DB = unknown> {
  from<T extends string>(
    table: T,
  ): MutationBuilder<DB extends { public: { Tables: Record<T, { Row: infer R }> } } ? R : Record<string, unknown>>;
}

export interface MutationBuilder<Row> {
  select(columns: string): MutationBuilder<Row>;
  insert(data: Partial<Row> | Partial<Row>[], opts?: Record<string, unknown>): MutationBuilder<Row>;
  update(data: Partial<Row>): MutationBuilder<Row>;
  upsert(data: Partial<Row> | Partial<Row>[], opts?: Record<string, unknown>): MutationBuilder<Row>;
  match(query: Record<string, unknown>): MutationBuilder<Row>;
  eq(column: string, value: unknown): MutationBuilder<Row>;
  single(): Promise<{ data: Row | null; error: unknown }>;
  then(resolve: (v: { data: Row[] | null; error: unknown }) => void): void;
}

export function createClient<DB = unknown>(
  _url: string,
  _key: string,
): SupabaseClient<DB> {
  throw new Error('stub — not callable at runtime');
}

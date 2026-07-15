// Minimal Supabase client stub — same shape as the 08-column-writes stub.

export interface SupabaseClient<DB = unknown> {
  from<T extends string>(
    table: T,
  ): MutationBuilder<
    DB extends { public: { Tables: Record<T, { Row: infer R }> } }
      ? R
      : Record<string, unknown>
  >;
}

export interface MutationBuilder<Row> {
  select(columns: string): MutationBuilder<Row>;
  insert(
    data: Partial<Row> | Partial<Row>[] | unknown,
    opts?: Record<string, unknown>,
  ): MutationBuilder<Row>;
  update(data: Partial<Row> | unknown): MutationBuilder<Row>;
  upsert(
    data: Partial<Row> | Partial<Row>[] | unknown,
    opts?: Record<string, unknown>,
  ): MutationBuilder<Row>;
  match(query: Record<string, unknown>): MutationBuilder<Row>;
  eq(column: string, value: unknown): MutationBuilder<Row>;
  order(column: string, opts?: Record<string, unknown>): MutationBuilder<Row>;
  in(column: string, values: unknown[]): MutationBuilder<Row>;
  gte(column: string, value: unknown): MutationBuilder<Row>;
  single(): Promise<{ data: Row | null; error: unknown }>;
  then(resolve: (v: { data: Row[] | null; error: unknown }) => void): void;
}

export function createClient<DB = unknown>(
  _url: string,
  _key: string,
): SupabaseClient<DB> {
  throw new Error('stub — not callable at runtime');
}

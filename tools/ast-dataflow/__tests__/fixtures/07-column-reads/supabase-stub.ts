// Minimal Supabase client stub for fixture use — no real @supabase/supabase-js needed.
// Mirrors supabase-js 2.105.x builder generics: `.from(table)` echoes the
// table-name literal into the builder's type arguments EVEN when DB = any
// (untyped client) — only the schema-derived arguments degrade to `any`.
// detectIsTyped must therefore inspect the Relation type argument's `Row`
// shape, never the return-type text.

type SchemaOf<DB> = DB extends { public: infer S } ? S : any;

export interface SupabaseClient<DB = any> {
  from<TN extends string & keyof SchemaOf<DB>['Tables']>(
    table: TN,
  ): QueryBuilder<
    { PostgrestVersion: '12' },
    SchemaOf<DB>,
    SchemaOf<DB>['Tables'][TN],
    TN
  >;
  rpc(
    fn: string,
    payload: Record<string, unknown>,
  ): Promise<{ data: unknown; error: unknown }>;
}

type RowOf<Relation> = Relation extends { Row: infer R }
  ? R
  : Record<string, unknown>;

export interface QueryBuilder<
  ClientOptions,
  Schema,
  Relation,
  TN extends string,
> {
  select(columns: string): QueryBuilder<ClientOptions, Schema, Relation, TN>;
  eq(
    column: string,
    value: unknown,
  ): QueryBuilder<ClientOptions, Schema, Relation, TN>;
  match(
    query: Record<string, unknown>,
  ): QueryBuilder<ClientOptions, Schema, Relation, TN>;
  order(
    column: string,
    opts?: { ascending?: boolean },
  ): QueryBuilder<ClientOptions, Schema, Relation, TN>;
  single(): Promise<{ data: RowOf<Relation> | null; error: unknown }>;
  then(
    resolve: (v: { data: RowOf<Relation>[] | null; error: unknown }) => void,
  ): void;
}

export function createClient<DB = any>(
  _url: string,
  _key: string,
): SupabaseClient<DB> {
  throw new Error('stub — not callable at runtime');
}

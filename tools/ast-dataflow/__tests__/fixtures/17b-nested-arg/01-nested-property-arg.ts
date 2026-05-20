// Fixture: nested object-literal property argument
// Pattern mirrors lib/procurement/procurement-queries.ts:70 — value passed as a named property
// in an object literal that is itself an argument to a call.
//
// origin: const procurementIds (line 12, column 9)
// hop 2: argument hop — execute('fn', { p_project_ids: procurementIds }) call site
//         (PropertyAssignment → ObjectLiteralExpression → CallExpression)

interface QueryClient {
  execute(name: string, params: Record<string, unknown>): Promise<unknown>;
}

export async function fetchStats(client: QueryClient) {
  const procurementIds = [1, 2, 3];
  await client.execute('get_bid_question_stats_batch', {
    p_project_ids: procurementIds,
  });
}

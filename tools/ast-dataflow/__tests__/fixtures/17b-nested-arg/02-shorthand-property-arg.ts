// Fixture: shorthand property argument
// Pattern: execute('fn', { procurementIds }) — shorthand for { procurementIds: procurementIds }
// This exercises the ShorthandPropertyAssignment path in the walker.
//
// origin: const procurementIds (line 12, column 9)
// hop 2: argument hop — execute('fn', { procurementIds }) call site
//         (ShorthandPropertyAssignment → ObjectLiteralExpression → CallExpression)

interface QueryClient {
  execute(name: string, params: Record<string, unknown>): Promise<unknown>;
}

export async function fetchStatsShorthand(client: QueryClient) {
  const procurementIds = [1, 2, 3];
  await client.execute('get_bid_question_stats_batch', { procurementIds });
}

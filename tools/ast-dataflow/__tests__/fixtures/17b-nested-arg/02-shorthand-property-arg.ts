// Fixture: shorthand property argument
// Pattern: execute('fn', { bidIds }) — shorthand for { bidIds: bidIds }
// This exercises the ShorthandPropertyAssignment path in the walker.
//
// origin: const bidIds (line 12, column 9)
// hop 2: argument hop — execute('fn', { bidIds }) call site
//         (ShorthandPropertyAssignment → ObjectLiteralExpression → CallExpression)

interface QueryClient {
  execute(name: string, params: Record<string, unknown>): Promise<unknown>;
}

export async function fetchStatsShorthand(client: QueryClient) {
  const bidIds = [1, 2, 3];
  await client.execute('get_bid_question_stats_batch', { bidIds });
}

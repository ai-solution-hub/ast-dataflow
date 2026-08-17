// Fixture: shorthand property argument
// Pattern: execute('fn', { projectIds }) — shorthand for { projectIds: projectIds }
// This exercises the ShorthandPropertyAssignment path in the walker.
//
// origin: const projectIds (line 12, column 9)
// hop 2: argument hop — execute('fn', { projectIds }) call site
//         (ShorthandPropertyAssignment → ObjectLiteralExpression → CallExpression)

interface QueryClient {
  execute(name: string, params: Record<string, unknown>): Promise<unknown>;
}

export async function fetchStatsShorthand(client: QueryClient) {
  const projectIds = [1, 2, 3];
  await client.execute('get_survey_question_stats_batch', { projectIds });
}

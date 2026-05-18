/**
 * Fixture types for type-drift-detect tests.
 *
 * Coverage:
 *   - ItemListResponse: enforced (both fetcher + route annotated)
 *   - OrderSummaryResponse: fetcher-only (fetcher uses it, route does not annotate)
 *   - ProductBody: route-only (route annotates, no fetcher)
 *   - UnusedPayload: unused (no fetcher, no route)
 *   - TestOnlyResult: unused + testOnly (referenced only in __tests__)
 *   - AliasedItemResponse: re-exported alias pointing at ItemListResponse
 */

/** Used in fetcher AND route return type — enforced bucket. */
export interface ItemListResponse {
  items: Array<{ id: string; name: string }>;
  total: number;
}

/** Used in fetcher but route does NOT annotate — fetcher-only bucket. */
export interface OrderSummaryResponse {
  orderId: string;
  status: 'pending' | 'complete';
}

/** Used ONLY in route return type — route-only bucket. */
export interface ProductBody {
  productId: string;
  price: number;
}

/** No fetcher, no route, no test reference — unused bucket. */
export interface UnusedPayload {
  data: string;
}

/** No fetcher, no route — only referenced in __tests__ fixture. */
export interface TestOnlyResult {
  value: number;
}

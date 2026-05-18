/**
 * Fixture fetchers — mirrors the KH pattern of fetchJson<T>(url).
 *
 * Coverage:
 *   - fetchItems: uses ItemListResponse (enforced — also annotated in route)
 *   - fetchOrder: uses OrderSummaryResponse (fetcher-only — route doesn't annotate)
 *   - fetchWithTemplateUrl: uses OrderSummaryResponse via template literal URL
 *   - fetchItemsAlias: uses AliasedItemResponse (re-export alias test)
 *
 * Note: no fetchProducts — ProductBody is route-only.
 */

import type { ItemListResponse, OrderSummaryResponse } from '@/types/items';

/** fetchJson stub — mirrors lib/query/fetchers.ts:29 unchecked cast. */
async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  return res.json() as Promise<T>;
}

/** Fetcher for /api/items — enforced (route also annotates). */
export async function fetchItems(): Promise<ItemListResponse> {
  return fetchJson<ItemListResponse>('/api/items');
}

/** Fetcher for /api/orders — fetcher-only (route does NOT annotate). */
export async function fetchOrder(id: string): Promise<OrderSummaryResponse> {
  return fetchJson<OrderSummaryResponse>(`/api/orders/${id}`);
}

/** Fetcher for /api/orders with template literal URL — indirect confidence. */
export async function fetchOrderByPath(
  id: string,
): Promise<OrderSummaryResponse> {
  const path = `/api/orders/${id}`;
  return fetchJson<OrderSummaryResponse>(path);
}

/**
 * Fixture route for /api/orders.
 * Imports OrderSummaryResponse but does NOT annotate the return type.
 * This is the fetcher-only pattern — the gap type-drift-detect detects.
 */

import type { OrderSummaryResponse } from '@/types/items';

/** Stub NextResponse. */
class NextResponse<T = unknown> {
  constructor(
    public readonly body: T,
    public readonly status: number = 200,
  ) {}

  static json<T>(body: T): NextResponse<T> {
    return new NextResponse(body);
  }
}

/** GET handler — no return type annotation (the gap detected). */
export async function GET(id: string) {
  const data: OrderSummaryResponse = { orderId: id, status: 'pending' };
  return NextResponse.json(data);
}

/**
 * Fixture route for /api/products.
 * Return type annotated with ProductBody — route-only (no matching fetcher).
 */

import type { ProductBody } from '@/types/items';

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

export async function GET(): Promise<NextResponse<ProductBody>> {
  const data: ProductBody = { productId: 'p-1', price: 9.99 };
  return NextResponse.json(data);
}

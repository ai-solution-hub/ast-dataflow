/**
 * Fixture route for /api/items.
 * Return type explicitly annotated with ItemListResponse — enforced.
 */

import type { ItemListResponse } from '@/types/items';

/** Stub NextResponse — just enough to look like the real thing. */
class NextResponse<T = unknown> {
  constructor(
    public readonly body: T,
    public readonly status: number = 200,
  ) {}

  static json<T>(body: T): NextResponse<T> {
    return new NextResponse(body);
  }
}

export async function GET(): Promise<NextResponse<ItemListResponse>> {
  const data: ItemListResponse = { items: [], total: 0 };
  return NextResponse.json(data);
}

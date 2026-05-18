/**
 * Vite fixture — imports target via a relative path.
 * Confirms the importers query also finds relative importers (not alias-only).
 */
import { formatCurrency } from '../utils/format';

export function PriceTag({ amount }: { amount: number }) {
  return formatCurrency(amount);
}

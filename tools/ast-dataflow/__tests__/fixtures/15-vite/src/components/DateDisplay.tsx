/**
 * Vite fixture — imports target via the ~/ alias.
 * Demonstrates that the importers query resolves ~/utils/format correctly.
 */
import { formatDate, formatCurrency } from '~/utils/format';

interface DateDisplayProps {
  date: Date;
  amount: number;
}

export function DateDisplay({ date, amount }: DateDisplayProps) {
  return `${formatDate(date)} — ${formatCurrency(amount)}`;
}

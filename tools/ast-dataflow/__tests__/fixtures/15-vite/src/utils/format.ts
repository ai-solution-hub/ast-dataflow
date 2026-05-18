/**
 * Vite fixture — target module imported via the ~/  alias.
 * The tsconfig maps ~/* to ./src/* so `~/utils/format` resolves here.
 */
export function formatDate(date: Date): string {
  return date.toLocaleDateString('en-GB');
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
  }).format(amount);
}

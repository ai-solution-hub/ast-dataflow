import { OrderSchema } from './zod-pair.js';

export function parseOrder(input: unknown): { id: string } {
  return OrderSchema.parse(input);
}

// Fixture: the zod idiom — a value and a type sharing one exported name.
// resolveSymbol must prefer the value declaration instead of erroring
// ambiguous_symbol (there is no more-specific name a caller could supply).
export const OrderSchema = {
  parse(input: unknown): { id: string } {
    return input as { id: string };
  },
};

export type OrderSchema = { id: string };

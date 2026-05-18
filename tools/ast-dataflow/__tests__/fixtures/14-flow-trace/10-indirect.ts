// Fixture: indirect confidence tier (dynamic property access)
// origin: const obj (line 7)
// hop 2: obj[key] — indirect confidence, terminal (dynamic access unresolvable)

export function processIndirect(key: string) {
  const obj = { a: 1, b: 2, c: 3 };
  const val = obj[key as keyof typeof obj];
  // dynamic property access: confidence indirect, no further descent
  return val;
}

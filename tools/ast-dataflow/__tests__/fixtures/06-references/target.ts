// The symbol under test. Consumers reference this in different ways.
export type MyState = 'active' | 'inactive';
export const MY_CONSTANT = 'fixture-value';
export function myFunction(): string {
  return MY_CONSTANT;
}

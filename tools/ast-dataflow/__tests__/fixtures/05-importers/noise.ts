// This file does NOT import from ./target — used to verify no false positives.
export function noiseFunction(): string {
  return 'unrelated';
}

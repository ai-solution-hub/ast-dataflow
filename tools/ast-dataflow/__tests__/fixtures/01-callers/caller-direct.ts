import { target } from './target';

export function consumerOne(): string {
  return target();
}

export function consumerTwo(): string {
  const a = target();
  const b = target();
  return a + b;
}

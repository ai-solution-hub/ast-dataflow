import { foo as renamedFoo } from './target.js';

export function useAliased(): string {
  return renamedFoo;
}

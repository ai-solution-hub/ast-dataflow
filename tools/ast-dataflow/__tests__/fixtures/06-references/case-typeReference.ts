import type { MyState } from './target';

// MyState used as a type parameter — should produce kind: 'typeReference'
function getState(): MyState {
  return 'active';
}

export { getState };

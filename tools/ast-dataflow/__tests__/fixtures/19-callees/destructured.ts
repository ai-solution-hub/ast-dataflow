const mod = {
  fn(): number {
    return 1;
  },
};

const { fn } = mod;

export function usesDestructured(): number {
  return fn();
}

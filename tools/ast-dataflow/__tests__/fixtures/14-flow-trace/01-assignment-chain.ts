// Fixture: linear assignment chain A → B → C
// origin: const a (line 8)
// hop 2: const b = a (line 9)
// hop 3: const c = b (line 10)
// no return — chain ends at c

export function processChain() {
  const a = { value: 42 };
  const b = a;
  const c = b;
  // intentionally no return — trace ends at c
  void c;
}

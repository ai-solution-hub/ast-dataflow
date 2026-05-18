// Fixture: array destructuring
// origin: const list (line 6)
// hop 2: const [first] = list (line 7) — destructure, exact confidence

export function processList() {
  const list = [1, 2, 3];
  const [first] = list;
  // intentionally no return — trace ends at first binding
  void first;
}

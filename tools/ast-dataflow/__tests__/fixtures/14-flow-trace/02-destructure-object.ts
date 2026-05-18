// Fixture: object destructuring
// origin: const user (line 6)
// hop 2: const { id } = user (line 7) — destructure, exact confidence

export function processUser() {
  const user = { id: 'abc', name: 'Alice' };
  const { id } = user;
  // intentionally no return — trace ends at id binding
  void id;
}

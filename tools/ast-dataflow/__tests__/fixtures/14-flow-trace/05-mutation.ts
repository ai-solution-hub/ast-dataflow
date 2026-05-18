// Fixture: mutation sink (.push)
// origin: const list (line 7)
// hop 2: list.push(value) — mutation hop, terminal

export function processMutation() {
  const list: number[] = [1, 2, 3];
  list.push(4);
  // list is mutated; trace terminates at push
}
